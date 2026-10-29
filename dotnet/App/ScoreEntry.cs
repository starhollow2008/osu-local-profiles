using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using OsuLocalProfiles.Calc;
using OsuLocalProfiles.Clients;
using OsuLocalProfiles.Db;
using OsuLocalProfiles.Replays;
using OsuLocalProfiles.Settings;
using OsuLocalProfiles.Tracker;

namespace OsuLocalProfiles;

/// <summary>
/// Replays this app builds for a score that has none, one from its osu! link and one entered by
/// hand: src/built-replays.ts. osu!'s calculator prices from what a replay's header and lazer's
/// block hold, so a replay built from osu!'s own record gives it exactly what the real one would.
/// </summary>
internal static class BuiltReplays
{
    /// <summary>A lazer version, from when lazer's block carried everything read here.</summary>
    private const int LazerBuiltVersion = 30000017;

    private static LegacyCounts CountsOf(OsuWebScore score)
    {
        var c = OnlineImport.LegacyCounts(score.Statistics, score.Mode);
        return new LegacyCounts(c.C300, c.C100, c.C50, c.Geki, c.Katu, c.Miss);
    }

    /// <summary>The replay for a score imported from its osu! link; null for a stable score whose mods have no stable bits.</summary>
    public static byte[]? Linked(OsuWebScore score, LinkedPlayer player)
    {
        var counts = CountsOf(score);
        if (score.LegacyScoreId is { } legacyId)
        {
            // Set on osu!stable: a stable replay, as osu!stable itself would have written it.
            if (Mods.EncodeLegacy(score.Mods) is not { } legacyMods) return null;
            var total = score.LegacyTotalScore ?? 0;
            return ReplayWriter.Encode(
                new ReplayHeader((int)score.Mode, Clients.Mcosu.BuiltReplayVersion, score.BeatmapMD5, player.Name, null, counts,
                    total, score.MaxCombo, score.LegacyPerfect, (int)legacyMods, score.PlayedAt, long.Parse(legacyId, System.Globalization.CultureInfo.InvariantCulture)),
                [AppBlocks.Write(AppBlocks.BuiltBlock, new { origin = "link", legacyTotal = total > 0 })]);
        }
        // Set on lazer: its own block carries the statistics, mods and settings osu! prices from.
        var block = new Dictionary<string, object?>
        {
            ["online_id"] = Js.StringToNumber(score.Id),
            ["mods"] = score.Mods,
            ["statistics"] = score.Statistics,
            ["maximum_statistics"] = score.MaximumStatistics,
            ["rank"] = score.Grade,
        };
        if (player.Id is { } userId) block["user_id"] = userId;
        return ReplayWriter.Encode(
            new ReplayHeader((int)score.Mode, LazerBuiltVersion, score.BeatmapMD5, player.Name, null, counts,
                score.TotalScore, score.MaxCombo, score.LegacyPerfect, 0, score.PlayedAt, long.Parse(score.Id, System.Globalization.CultureInfo.InvariantCulture)),
            [ReplayWriter.LazerBlock(block), AppBlocks.Write(AppBlocks.BuiltBlock, new { origin = "link", legacyTotal = false })]);
    }

    /// <summary>A score typed in by hand, as osu!stable's results screen shows one: always a stable replay.</summary>
    public static byte[] Manual(int mode, string beatmapMD5, string player, LegacyCounts counts, double maxCombo, int legacyMods,
        double? totalScore, double playedAt) =>
        ReplayWriter.Encode(
            new ReplayHeader(mode, Clients.Mcosu.BuiltReplayVersion, beatmapMD5, player, null, counts, totalScore ?? 0, maxCombo, false,
                legacyMods, playedAt, 0),
            [AppBlocks.Write(AppBlocks.BuiltBlock, new { origin = "manual", legacyTotal = totalScore is not null })]);
}

/// <summary>
/// Beatmap files downloaded for a score on a beatmap that is not installed, kept in
/// <c>data/beatmaps/</c> by their MD5 and indexed like any other: src/stored-beatmaps.ts.
/// </summary>
internal static class StoredBeatmaps
{
    public const string Dir = "beatmaps";

    /// <summary>Keep a downloaded beatmap and index it.</summary>
    public static (string Path, string Md5) Store(Database db, string dataDir, byte[] bytes)
    {
        var md5 = Convert.ToHexStringLower(MD5.HashData(bytes));
        var dir = NodePath.Join(dataDir, Dir);
        Directory.CreateDirectory(dir);
        var file = NodePath.Join(dir, $"{md5}.osu");
        if (!File.Exists(file)) File.WriteAllBytes(file, bytes);
        Clients.Beatmaps.IndexOneFile(db, file);
        return (file, md5);
    }

    /// <summary>
    /// The <c>.osu</c> file a score needs: the installed one, or osu!'s, downloaded and kept. osu!
    /// serves only a beatmap's current version, so one updated since the play is refused.
    /// </summary>
    public static async Task<string> Ensure(Database db, BeatmapResolver resolver, string dataDir, OsuWeb osu, double beatmapId, string md5)
    {
        if (resolver.Resolve(md5).OsuPath is { } local && File.Exists(local)) return local;
        var stored = Store(db, dataDir, await osu.FetchBeatmapFile(beatmapId));
        if (stored.Md5 != md5)
        {
            File.Delete(stored.Path);
            db.Run("DELETE FROM osu_files WHERE path = ?", stored.Path);
            throw new InvalidOperationException(
                "this beatmap has been updated on osu! since the score was set, and its old version cannot be downloaded to price it");
        }
        return stored.Path;
    }
}

/// <summary>What score entry needs of the running app, for one profile.</summary>
internal sealed record EntryDeps(
    Database Db,
    BeatmapResolver Resolver,
    string DataDir,
    long ProfileId,
    PlayerIdentity Identity,
    OsuWeb Osu,
    Func<string, long?, Task<IngestOutcome>> ImportBuiltReplay,
    Func<string, Task<PpResult?>> PriceReplay,
    bool CanPrice)
{
    /// <summary>The deps for a profile, from the running tracker: one place for the server and startup.</summary>
    public static EntryDeps Of(PlayTracker tracker, Database db, string dataDir, long profileId, OsuWeb osu) => new(
        db, tracker.Beatmaps, dataDir, profileId, tracker.PlayerIdentity, osu,
        (file, target) => tracker.ImportBuiltReplay(file, target ?? profileId),
        tracker.PriceReplay,
        tracker.CalculatorVersion is not null);
}

/// <summary>A score as the link check shows it, before anything is written.</summary>
internal sealed record LinkPreview(
    string Title, string? TitleOriginal, double Mode, string Mods, string Grade, double Accuracy, double MaxCombo,
    double? OsuPp, double PlayedAt, string Player, bool? Yours, bool Already);

/// <summary>A beatmap a score can be entered on: one whose file is here, installed or downloaded.</summary>
internal sealed record EntryBeatmap(string Md5, object? BeatmapId, string Title, string? TitleOriginal, int Mode, int Objects);

/// <summary>What converting a profile's imported best performances came to.</summary>
internal sealed record Conversion(int Converted, int Left);

/// <summary>
/// Adding one score by name, from its link on osu.ppy.sh or typed in by hand: src/score-entry.ts.
/// Both end as a replay built from the score's numbers, priced here like any other.
/// </summary>
internal static partial class ScoreEntry
{
    private static (string Title, string? TitleOriginal) Named(OsuWebScore score)
    {
        var n = Metadata.Names(score.Artist, score.Title, null, null);
        string WithVersion(string name) => string.IsNullOrEmpty(score.Version) ? name : $"{name} [{score.Version}]";
        var original = Metadata.BeatmapNameOriginal(n);
        var name = Metadata.BeatmapName(n);
        return (WithVersion(name.Length > 0 ? name : score.BeatmapMD5[..Math.Min(12, score.BeatmapMD5.Length)]),
            original is null ? null : WithVersion(original));
    }

    /// <summary>
    /// Here already, from its replay or this link before, or deleted for good. One held only as osu!'s
    /// figures is not: the link's built replay is a better record and takes its place.
    /// </summary>
    private static bool IsAlready(EntryDeps deps, LinkedScore linked)
    {
        var score = linked.Score;
        var found = Existing.Find(deps.Db, deps.ProfileId, OnlineImport.IdentityOf(score));
        return (found is not null && !Existing.Replaces(found, "built"))
            || Scores.WasDeleted(deps.Db, deps.ProfileId, $"{score.BeatmapMD5}:{Js.NumberToString(score.PlayedAt)}");
    }

    public static async Task<LinkPreview> CheckLink(EntryDeps deps, string link)
    {
        var linked = await deps.Osu.FetchLinkedScore(link);
        var (score, player) = (linked.Score, linked.Player);
        var owns = Players.OwnsPlay(deps.Identity, new ReplayPlayer(player.Name, player.Id, Js.StringToNumber(score.Id)));
        var (title, titleOriginal) = Named(score);
        return new LinkPreview(title, titleOriginal, score.Mode,
            Mods.Label(Mods.WithClassicMod(score.Mods, score.LegacyScoreId is not null ? "stable" : "lazer")),
            score.Grade, score.Accuracy, score.MaxCombo, score.Pp, score.PlayedAt, player.Name, owns, IsAlready(deps, linked));
    }

    /// <summary>Import a score from its link: its beatmap if need be, then its built replay.</summary>
    public static async Task<IngestOutcome?> ImportLink(EntryDeps deps, string link)
    {
        var linked = await deps.Osu.FetchLinkedScore(link);
        if (IsAlready(deps, linked)) return null;
        var bytes = BuiltReplays.Linked(linked.Score, linked.Player)
            ?? throw new InvalidOperationException("that score has mods an osu!stable replay cannot hold");
        // Names and ranked status as osu! gives them, for a beatmap nothing here can describe.
        OnlineImport.CacheBeatmap(deps.Db, deps.Resolver, linked.Score);
        await StoredBeatmaps.Ensure(deps.Db, deps.Resolver, deps.DataDir, deps.Osu, linked.Score.BeatmapId, linked.Score.BeatmapMD5);
        return await ImportBuilt(deps, bytes);
    }

    /// <summary>The built replay, kept and imported; null when the play was already here.</summary>
    private static async Task<IngestOutcome?> ImportBuilt(EntryDeps deps, byte[] bytes)
    {
        var file = UploadedReplays.Store(deps.DataDir, bytes) ?? throw new InvalidOperationException("the score could not be built into a replay");
        var outcome = await deps.ImportBuiltReplay(file, null);
        UploadedReplays.Release(deps.Db, file);
        return outcome.Status == "added" ? outcome : null;
    }

    /* ---------------------------------------------------- imported best performances */

    private static string? Text(object? v) => v switch
    {
        null => null,
        string s => s,
        long l => l.ToString(System.Globalization.CultureInfo.InvariantCulture),
        double d => Js.NumberToString(d),
        _ => v.ToString(),
    };

    /// <summary>An imported row as the score osu! handed over, rebuilt from what it stored, to be built into a replay.</summary>
    private static OsuWebScore? FromImportedRow(Row r)
    {
        if (Text(r["online_score_id"]) is not { } id) return null;
        var stable = r.Str("client") == "stable";
        Dictionary<string, double> Counts(string column)
        {
            var output = new Dictionary<string, double>(StringComparer.Ordinal);
            if (r.Str(column) is { } json && JsonText.TryParse(json, out var parsed) && parsed.ValueKind == JsonValueKind.Object)
            {
                foreach (var (key, value) in Js.Entries(parsed)) if (value.ValueKind == JsonValueKind.Number) output[key] = Js.NumberOf(value);
            }
            return output;
        }
        var total = Convert.ToDouble(r["total_score"]);
        return new OsuWebScore(
            id, Text(r["legacy_score_id"]), Convert.ToDouble(r["mode"]), r.Str("beatmap_md5")!,
            r["beatmap_id"] is null ? 0 : Convert.ToDouble(r["beatmap_id"]),
            null, null, null, null, null, 0, null,
            Mods.Parse(r.Str("mods_json")) ?? [],
            Counts("statistics_json"), Counts("max_statistics_json"),
            0, Convert.ToDouble(r["max_combo"]), total, null,
            // An imported stable play stored osu!stable's own total, which is what its replay carries.
            stable ? total : null,
            r.Str("grade")!, true, false, true, null, Convert.ToDouble(r["played_at"]), null);
    }

    private static bool Installed(EntryDeps deps, string md5) => deps.Resolver.Resolve(md5).OsuPath is { } local && File.Exists(local);

    /// <summary>
    /// Put a profile's imported best performances on built replays, priced here, each taking its row's
    /// place. A beatmap not installed is downloaded only when <paramref name="download"/> is set (an
    /// import, or Recalculate every score); otherwise that play waits for the next chance.
    /// </summary>
    public static async Task<Conversion> ConvertImported(EntryDeps deps, long profileId, bool download, Action<int, int>? onDownload = null)
    {
        var rows = deps.Db.Rows("""
            SELECT id, mode, beatmap_md5, beatmap_id, client, mods_json, statistics_json, max_statistics_json,
                   max_combo, total_score, grade, played_at, online_score_id, legacy_score_id
              FROM scores WHERE profile_id = ? AND imported_at IS NOT NULL
            """, profileId);
        if (rows.Count == 0) return new Conversion(0, 0);
        if (!deps.CanPrice) return new Conversion(0, rows.Count);

        // How many beatmaps there are to download, each once however many plays it has.
        var toDownload = download
            ? rows.Where(row => row["beatmap_id"] is not null && !Installed(deps, row.Str("beatmap_md5")!)).Select(row => row.Str("beatmap_md5")!).ToHashSet()
            : [];
        var downloaded = new HashSet<string>();
        // Written under the account the scores came from, which is whose they are.
        var player = new LinkedPlayer(null, SettingsStore.Get(deps.Db, profileId).LinkedUsername);
        int converted = 0, left = 0;
        foreach (var row in rows)
        {
            var md5 = row.Str("beatmap_md5")!;
            var score = FromImportedRow(row);
            var bytes = score is null ? null : BuiltReplays.Linked(score, player);
            var local = deps.Resolver.Resolve(md5).OsuPath;
            try
            {
                if (bytes is null || score is null) throw new InvalidOperationException("not buildable");
                if (local is null || !File.Exists(local))
                {
                    if (!download || row["beatmap_id"] is null) throw new InvalidOperationException("no beatmap");
                    try
                    {
                        await StoredBeatmaps.Ensure(deps.Db, deps.Resolver, deps.DataDir, deps.Osu, Convert.ToDouble(row["beatmap_id"]), md5);
                    }
                    finally
                    {
                        if (toDownload.Contains(md5) && downloaded.Add(md5)) onDownload?.Invoke(downloaded.Count, toDownload.Count);
                    }
                }
                var file = UploadedReplays.Store(deps.DataDir, bytes) ?? throw new InvalidOperationException("not buildable");
                var outcome = await deps.ImportBuiltReplay(file, profileId);
                UploadedReplays.Release(deps.Db, file);
                if (outcome.Status == "added") converted++;
                else left++;
            }
            catch (Exception e) when (e is not OutOfMemoryException)
            {
                left++;
            }
        }
        return new Conversion(converted, left);
    }

    /* -------------------------------------------------------------------- beatmaps */

    [GeneratedRegex(@"\r?\n")]
    private static partial Regex LineBreak();

    private static EntryBeatmap? Describe(EntryDeps deps, string md5)
    {
        var beatmap = deps.Resolver.Resolve(md5);
        if (beatmap.OsuPath is not { } path || !File.Exists(path)) return null;
        var text = Js.ReadFileUtf8(path);
        var objects = LineBreak().Split(Clients.Beatmaps.OsuSection(text, "[HitObjects]") ?? "").Count(l => Js.Trim(l) != "");
        var n = Metadata.Names(beatmap.Artist, beatmap.Title, beatmap.ArtistUnicode, beatmap.TitleUnicode);
        string WithVersion(string name) => string.IsNullOrEmpty(beatmap.Version) ? name : $"{name} [{beatmap.Version}]";
        var original = Metadata.BeatmapNameOriginal(n);
        var name = Metadata.BeatmapName(n);
        return new EntryBeatmap(md5, beatmap.BeatmapId, WithVersion(name.Length > 0 ? name : md5[..Math.Min(12, md5.Length)]),
            original is null ? null : WithVersion(original), Clients.Beatmaps.Mode(path), objects);
    }

    /// <summary>JavaScript's <c>split(/\s+/)</c> with the empty pieces dropped.</summary>
    private static IEnumerable<string> Words(string text)
    {
        var word = new System.Text.StringBuilder();
        foreach (var c in text)
        {
            if (Js.IsSpace(c))
            {
                if (word.Length > 0) yield return word.ToString();
                word.Clear();
            }
            else
            {
                word.Append(c);
            }
        }
        if (word.Length > 0) yield return word.ToString();
    }

    /// <summary>Installed beatmaps whose name has every word typed, for picking one to enter a score on.</summary>
    public static List<EntryBeatmap> Search(EntryDeps deps, string query, int limit = 20)
    {
        var words = Words(Js.ToLower(Js.Trim(query))).Take(8).ToList();
        if (words.Count == 0) return [];
        static string Like(string w) => $"%{Regex.Replace(w, @"[\\%_]", m => $"\\{m.Value}")}%";
        var rows = deps.Db.All($"""
            SELECT DISTINCT md5 FROM osu_files
             WHERE {string.Join(" AND ", words.Select(_ => "LOWER(name) LIKE ? ESCAPE '\\'"))}
             ORDER BY name LIMIT ?
            """, r => r.GetString(0), [.. words.Select(Like), limit]);
        return [.. rows.Select(md5 => Describe(deps, md5)).Where(b => b is not null).Select(b => b!)];
    }

    [GeneratedRegex(@"^[0-9a-f]{32}\z")]
    private static partial Regex Md5Shape();

    /// <summary>
    /// A beatmap by its link or id, or by the MD5 a search returned. An installed one is used as it
    /// is; otherwise osu!'s current file is downloaded and kept.
    /// </summary>
    public static async Task<EntryBeatmap> Find(EntryDeps deps, string? md5, string link)
    {
        if (md5 is not null)
        {
            return (Md5Shape().IsMatch(md5) ? Describe(deps, md5) : null)
                ?? throw new InvalidOperationException("that beatmap is not on this computer");
        }
        var id = BeatmapIdOf(link) ?? throw new InvalidOperationException("that is not a beatmap link or id -- link to one difficulty");
        if (deps.Resolver.Md5ForBeatmapId(id) is { } local && Describe(deps, local) is { } installed) return installed;
        var stored = StoredBeatmaps.Store(deps.Db, deps.DataDir, await deps.Osu.FetchBeatmapFile(id));
        return Describe(deps, stored.Md5) ?? throw new InvalidOperationException("osu! sent a file that is not a beatmap");
    }

    [GeneratedRegex(@"^([0-9]{1,10})\z")]
    private static partial Regex BareBeatmapId();

    [GeneratedRegex(@"osu\.ppy\.sh/beatmapsets/[0-9]+/?#(?:osu|taiko|fruits|mania)/([0-9]{1,10})", RegexOptions.IgnoreCase)]
    private static partial Regex SetLink();

    [GeneratedRegex(@"osu\.ppy\.sh/(?:b|beatmaps)/([0-9]{1,10})", RegexOptions.IgnoreCase)]
    private static partial Regex BeatmapLink();

    public static double? BeatmapIdOf(string input)
    {
        var text = Js.Trim(input);
        var match = BareBeatmapId().Match(text);
        if (!match.Success) match = SetLink().Match(text);
        if (!match.Success) match = BeatmapLink().Match(text);
        var id = match.Success ? Js.StringToNumber(match.Groups[1].Value) : double.NaN;
        return double.IsFinite(id) && id == Math.Floor(id) && id <= 9007199254740991 && id > 0 ? id : null;
    }

    /* -------------------------------------------------------------------- by hand */

    /// <summary>The judgements each ruleset has, by the header counter that holds them.</summary>
    public static readonly string[][] Judgements =
    [
        ["c300", "c100", "c50", "miss"],
        ["c300", "c100", "miss"],
        ["c300", "c100", "c50", "katu", "miss"],
        ["geki", "c300", "katu", "c100", "c50", "miss"],
    ];

    /// <summary>Pairs osu!stable never allowed together, so a typed-in play cannot have had them.</summary>
    private static readonly (string A, string B)[] Exclusive =
        [("EZ", "HR"), ("DT", "HT"), ("NC", "HT"), ("NF", "SD"), ("NF", "PF"), ("RX", "AP"), ("NF", "RX"), ("NF", "AP")];

    /// <summary><c>/[s+,|/]/g</c>: JavaScript's whitespace, and the separators a list of mods is typed with.</summary>
    private static string WithoutSeparators(string text) => new([.. text.Where(c => !Js.IsSpace(c) && c is not ('+' or ',' or '|' or '/'))]);

    /// <summary>
    /// Mods as typed (<c>HDDT</c>, <c>+HD DT</c>, <c>hd,dt</c>) to osu!stable's bitmask for the ruleset,
    /// or a message saying what is wrong. Autoplay and Cinema are refused.
    /// </summary>
    public static (int Bits, List<string> Acronyms)? ParseMods(JsonElement? text, int mode, out string? error)
    {
        error = null;
        var raw = text is { ValueKind: not JsonValueKind.Null } t ? Js.ToJsString(t) : "";
        var clean = WithoutSeparators(Js.ToUpper(raw));
        var known = Mods.LegacyModBits.Append("CL").OrderByDescending(a => a.Length).ToList();
        var acronyms = new List<string>();
        for (var i = 0; i < clean.Length;)
        {
            var hit = known.FirstOrDefault(a => string.CompareOrdinal(clean, i, a, 0, a.Length) == 0 && i + a.Length <= clean.Length);
            if (hit is null)
            {
                error = $"\"{Js.Slice(clean[i..], 2)}\" is not an osu!stable mod";
                return null;
            }
            if (hit != "CL" && !acronyms.Contains(hit)) acronyms.Add(hit);
            i += hit.Length;
        }
        if (acronyms.Any(a => a is "AT" or "CN"))
        {
            error = "a play set by Autoplay cannot be entered";
            return null;
        }
        foreach (var (a, b) in Exclusive)
        {
            if (acronyms.Contains(a) && acronyms.Contains(b))
            {
                error = $"{a} and {b} cannot be on together";
                return null;
            }
        }
        if (Mods.EncodeLegacy(acronyms.Select(Mods.Of)) is not { } bits)
        {
            error = "those mods are not osu!stable mods";
            return null;
        }
        var kept = Mods.DecodeLegacy((int)bits, mode).Select(Mods.Acronym).ToHashSet();
        if (acronyms.FirstOrDefault(a => !kept.Contains(a)) is { } foreign)
        {
            error = $"{foreign} is not a mod in this ruleset";
            return null;
        }
        return ((int)bits, acronyms);
    }

    /// <summary>A whole number from 0 to <paramref name="max"/>, from a number or the text of one; null otherwise.</summary>
    private static double? Whole(JsonElement? v, double max)
    {
        double n;
        if (v is { ValueKind: JsonValueKind.String } s && Js.Trim(s.GetString()!) != "") n = Js.StringToNumber(s.GetString()!);
        else if (v is { ValueKind: JsonValueKind.Number } number) n = Js.NumberOf(number);
        else return null;
        return double.IsFinite(n) && n == Math.Floor(n) && n >= 0 && n <= max ? n : null;
    }

    /// <summary>1 October 2007: osu!'s first public release. No play is older.</summary>
    private static readonly double OsuEpoch = Js.DateUtc(2007, 9, 1);

    private static bool Blank(JsonElement? v) => v is null or { ValueKind: JsonValueKind.Null } || (v is { ValueKind: JsonValueKind.String } s && s.GetString() == "");

    /// <summary>
    /// Enter a score by hand. Everything typed is checked against the beatmap first, and the pp
    /// always comes from osu!'s calculator, never from the form. Null when the play was already here.
    /// </summary>
    public static async Task<IngestOutcome?> Enter(EntryDeps deps, JsonElement input, string player)
    {
        if (!deps.CanPrice) throw new InvalidOperationException("the pp calculator is not available, so a score cannot be entered by hand");
        var beatmap = Js.IsString(Js.Get(input, "md5"), out var md5) && Md5Shape().IsMatch(md5) ? Describe(deps, md5) : null;
        if (beatmap is null) throw new InvalidOperationException("choose a beatmap first");

        var asked = Js.ToNumber(Js.Get(input, "mode"));
        if (asked is not (0 or 1 or 2 or 3)) throw new InvalidOperationException("choose a ruleset");
        var mode = (int)asked;
        if (beatmap.Mode != 0 && mode != beatmap.Mode) throw new InvalidOperationException("this beatmap can only be played in its own ruleset");

        var counts = new Dictionary<string, double> { ["c300"] = 0, ["c100"] = 0, ["c50"] = 0, ["geki"] = 0, ["katu"] = 0, ["miss"] = 0 };
        var given = Js.Get(input, "counts");
        foreach (var key in Judgements[mode])
        {
            // `input.counts[key]`, which JavaScript cannot read when there are no counts at all.
            if (given is null or { ValueKind: JsonValueKind.Null })
            {
                throw new InvalidOperationException($"Cannot read properties of {(given is null ? "undefined" : "null")} (reading '{key}')");
            }
            var value = Js.Get(given, key);
            var n = Whole(value is null or { ValueKind: JsonValueKind.Null } ? JsonText.From(0) : value, 65535)
                ?? throw new InvalidOperationException("each judgement is a whole number from 0");
            counts[key] = n;
        }
        var judged = Judgements[mode].Sum(key => counts[key]);
        if (judged == 0) throw new InvalidOperationException("enter the play’s judgements");
        // An osu! or mania play on its own ruleset's beatmap is judged once per object, exactly.
        if (mode == beatmap.Mode && mode is 0 or 3 && judged != beatmap.Objects)
        {
            throw new InvalidOperationException($"the judgements add up to {Js.NumberToString(judged)}, and this beatmap has {beatmap.Objects} objects");
        }

        var maxCombo = Whole(Js.Get(input, "maxCombo"), 65535) ?? throw new InvalidOperationException("enter the play’s max combo");
        if (ParseMods(Js.Get(input, "mods"), mode, out var modsError) is not { } mods) throw new InvalidOperationException(modsError);
        var typedTotal = Js.Get(input, "totalScore");
        var totalScore = Blank(typedTotal) ? null : Whole(typedTotal, 0x7fffffff);
        if (totalScore is null && !Blank(typedTotal)) throw new InvalidOperationException("the score is a whole number");
        var playedAt = Js.ToNumber(Js.Get(input, "playedAt"));
        if (!double.IsFinite(playedAt) || playedAt < OsuEpoch || playedAt > Js.Now() + 60_000)
        {
            throw new InvalidOperationException("enter when the play was set");
        }

        var bytes = BuiltReplays.Manual(mode, beatmap.Md5, player,
            new LegacyCounts(counts["c300"], counts["c100"], counts["c50"], counts["geki"], counts["katu"], counts["miss"]),
            maxCombo, mods.Bits, totalScore, playedAt);

        // The combo is the one thing the beatmap alone cannot check: its maximum is osu!'s to say.
        var file = UploadedReplays.Store(deps.DataDir, bytes) ?? throw new InvalidOperationException("the score could not be built into a replay");
        var priced = await deps.PriceReplay(file);
        if (priced is null || priced.MaxCombo <= 0)
        {
            UploadedReplays.Release(deps.Db, file);
            throw new InvalidOperationException("osu!’s calculator could not price this play");
        }
        if (maxCombo > priced.MaxCombo)
        {
            UploadedReplays.Release(deps.Db, file);
            throw new InvalidOperationException($"a combo of {Js.NumberToString(maxCombo)} is more than this beatmap's maximum of {Js.NumberToString(priced.MaxCombo)}");
        }
        return await ImportBuilt(deps, bytes);
    }
}
