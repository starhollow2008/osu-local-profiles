using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using OsuLocalProfiles.Calc;
using OsuLocalProfiles.Db;

namespace OsuLocalProfiles;

/// <summary>
/// Everything osu!'s score page shows about one score, as far as this machine knows it: the row's
/// play plus its judgements, the client, the difficulty's own star rating and the pp's parts.
/// </summary>
internal sealed class ScoreDetail(Play play)
{
    // The play's own fields first, as `{ ...play, ... }` writes them.
    public string Kind => play.Kind;
    public object? Id => play.Id;
    public object? BeatmapMd5 => play.BeatmapMd5;
    public object? BeatmapId => play.BeatmapId;
    public object? BeatmapsetId => play.BeatmapsetId;
    public string? Artist => play.Artist;
    public string? Title => play.Title;
    public string? ArtistUnicode => play.ArtistUnicode;
    public string? TitleUnicode => play.TitleUnicode;
    public object? Version => play.Version;
    public object? Creator => play.Creator;
    public List<JsonElement> Mods => play.Mods;
    public object? Accuracy => play.Accuracy;
    public object? MaxCombo => play.MaxCombo;
    public object? TotalScore => play.TotalScore;
    public object? Grade => play.Grade;
    public object? Stars => play.Stars;
    public object? Pp => play.Pp;
    public bool Ranked => play.Ranked;
    public bool Passed => play.Passed;
    public object? PlayedAt => play.PlayedAt;
    public double? Weight => play.Weight;
    public double? WeightedPp => play.WeightedPp;
    public bool Counted => play.Counted;
    public bool Pinned => play.Pinned;
    public bool HasReplay => play.HasReplay;
    public string Source => play.Source;
    public string? OsuUrl => play.OsuUrl;
    public string? PpBasis => play.PpBasis;

    public object? Mode { get; init; }
    /// <summary><c>stable</c>, <c>mcosu</c> or <c>lazer</c>: osu-web's "Played on".</summary>
    public string Client { get; init; } = "lazer";
    public Dictionary<string, object?> Statistics { get; init; } = [];
    /// <summary>Empty for a stable score: its replay records what was hit, not what could have been.</summary>
    public Dictionary<string, object?> MaximumStatistics { get; init; } = [];
    public bool? PerfectCombo { get; init; }
    public object? DifficultyStars { get; init; }
    public object? CreatorId { get; init; }
    /// <summary>Whether the replay file is on disk right now, not just whether one was recorded.</summary>
    public bool ReplayAvailable { get; init; }
    public List<JsonElement>? PpBreakdown { get; init; }
    public object? PpVersion { get; init; }
}

/// <summary>One score's views: its page and its replay (src/scores.ts, the reading half).</summary>
internal static partial class Scores
{
    /// <summary>
    /// How an unfinished play's key is remembered in <c>deleted_scores</c>: prefixed, so it can never
    /// be mistaken for a replay's.
    /// </summary>
    public static string DeletedIncompleteKey(string dedupeKey) => $"incomplete:{dedupeKey}";

    /// <summary>Whether a replay with this key was deleted from the profile, and must not come back.</summary>
    public static bool WasDeleted(Database db, long profileId, string dedupeKey) =>
        db.Exists("SELECT 1 AS hit FROM deleted_scores WHERE profile_id = ? AND dedupe_key = ?", profileId, dedupeKey);

    /// <summary>
    /// A stable score's six counters, named as lazer names them for the ruleset: what lazer
    /// does when it imports one, so a stable score reads like a lazer one.
    /// </summary>
    public static Dictionary<string, object?> LegacyStatistics(object? mode, Row c) => (mode switch { long l => l, double d => d, _ => -1 }) switch
    {
        1 => new() { ["great"] = c["count300"], ["ok"] = c["count100"], ["miss"] = c["count_miss"] },
        2 => new()
        {
            ["great"] = c["count300"], ["large_tick_hit"] = c["count100"], ["small_tick_hit"] = c["count50"],
            ["small_tick_miss"] = c["count_katu"], ["miss"] = c["count_miss"],
        },
        3 => new()
        {
            ["perfect"] = c["count_geki"], ["great"] = c["count300"], ["good"] = c["count_katu"],
            ["ok"] = c["count100"], ["meh"] = c["count50"], ["miss"] = c["count_miss"],
        },
        _ => new() { ["great"] = c["count300"], ["ok"] = c["count100"], ["meh"] = c["count50"], ["miss"] = c["count_miss"] },
    };

    /// <summary>The pp's parts as stored: each with a numeric <c>pp</c> and a text <c>name</c>.</summary>
    private static List<JsonElement>? ParseBreakdown(string? json)
    {
        if (string.IsNullOrEmpty(json) || !JsonText.TryParse(json, out var parts) || parts.ValueKind != JsonValueKind.Array) return null;
        return [.. parts.EnumerateArray().Where(p =>
            Js.Get(p, "pp") is { ValueKind: JsonValueKind.Number } && Js.Get(p, "name") is { ValueKind: JsonValueKind.String })];
    }

    /// <summary>Judgement counts as stored, keeping only finite numbers; null when unreadable.</summary>
    private static Dictionary<string, object?>? ParseStatistics(string? json)
    {
        if (string.IsNullOrEmpty(json) || !JsonText.TryParse(json, out var parsed)) return null;
        // Object.entries(null) throws in JavaScript, and the caller falls back to the counters.
        if (parsed.ValueKind == JsonValueKind.Null) return null;
        var output = new Dictionary<string, object?>();
        // Object.entries of anything: an object's own keys, an array's indexes; nothing else.
        if (parsed.ValueKind == JsonValueKind.Object)
        {
            foreach (var p in parsed.EnumerateObject())
            {
                if (p.Value.ValueKind == JsonValueKind.Number) output[p.Name] = p.Value;
                else output.Remove(p.Name);
            }
        }
        else if (parsed.ValueKind == JsonValueKind.Array)
        {
            var i = 0;
            foreach (var v in parsed.EnumerateArray())
            {
                if (v.ValueKind == JsonValueKind.Number) output[(i).ToString(CultureInfo.InvariantCulture)] = v;
                i++;
            }
        }
        return output;
    }

    private static readonly string[] Rulesets = ["osu", "taiko", "fruits", "mania"];

    /// <summary>
    /// The difficulty's own star rating: osu!'s from the set's cached page, or any score on it
    /// whose mods leave the rating alone. Never a score's rating its mods changed.
    /// </summary>
    private static object? DifficultyStars(Database db, long profileId, object? md5, object? mode, object? beatmapId, object? beatmapsetId)
    {
        if (beatmapsetId is not null && beatmapId is long or double && Favorites.DetailsFor(db, beatmapsetId) is { } details
            && Js.Get(details, "difficulties") is { ValueKind: JsonValueKind.Array } difficulties)
        {
            var id = Convert.ToDouble(beatmapId);
            var known = difficulties.EnumerateArray().FirstOrDefault(d =>
                Js.Get(d, "id") is { ValueKind: JsonValueKind.Number } n && Js.NumberOf(n) == id);
            // A converted play is rated in its own ruleset, which the set's page does not list.
            var m = mode is long or double ? Convert.ToDouble(mode) : double.NaN;
            var ruleset = m is 0 or 1 or 2 or 3 ? Rulesets[(int)m] : null;
            if (known.ValueKind == JsonValueKind.Object && ruleset is not null && Js.IsString(Js.Get(known, "mode"), out var knownMode)
                && knownMode == ruleset)
            {
                return Js.Get(known, "stars");
            }
        }

        var scores = db.Rows($"""
            SELECT s.stars, s.mods_json FROM scores s
             WHERE s.profile_id = ? AND s.beatmap_md5 = ? AND s.mode = ? AND s.stars IS NOT NULL
               AND {Eligibility.VisibleSql()}
            """, profileId, md5, mode);
        return scores.FirstOrDefault(s => Favorites.RatingNeutral(s.Str("mods_json")))?["stars"];
    }

    public static ScoreDetail? Detail(Database db, long profileId, long id, Eligibility e)
    {
        if (Stats.PlayById(db, profileId, id, e) is not { } play) return null;
        var row = db.FirstRow("""
            SELECT mode, client, statistics_json, max_statistics_json, beatmap_max_combo, replay_path,
                   count300, count100, count50, count_geki, count_katu, count_miss,
                   pp_parts, pp_nomod_parts, pp_version
              FROM scores WHERE id = ?
            """, id)!;

        var mapMax = row.Num("beatmap_max_combo");
        var replayPath = row.Str("replay_path");
        var details = play.BeatmapsetId is null ? null : Favorites.DetailsFor(db, play.BeatmapsetId);
        var parts = row.Str(play.PpBasis == "without-unranked-mods" ? "pp_nomod_parts" : "pp_parts");
        var client = row.Str("client");
        var maxCombo = play.MaxCombo switch { long l => l, double d => d, _ => double.NaN };
        var creatorId = details is null ? null : Js.Get(details, "userId");

        return new ScoreDetail(play)
        {
            Mode = row["mode"],
            Client = client is "stable" or "mcosu" ? client : "lazer",
            Statistics = ParseStatistics(row.Str("statistics_json")) ?? LegacyStatistics(row["mode"], row),
            MaximumStatistics = ParseStatistics(row.Str("max_statistics_json")) ?? [],
            // The medals' definition of a full combo, so the card and the FC medals never disagree.
            PerfectCombo = mapMax is null or <= 0 ? null : maxCombo >= mapMax,
            DifficultyStars = DifficultyStars(db, profileId, play.BeatmapMd5, row["mode"], play.BeatmapId, play.BeatmapsetId),
            CreatorId = creatorId is { ValueKind: not JsonValueKind.Null } ? creatorId : null,
            // A built replay (McOsu, a link, typed in) has no cursor data: `HasReplay` says so.
            ReplayAvailable = play.HasReplay && replayPath is not null && File.Exists(replayPath),
            PpBreakdown = ParseBreakdown(parts),
            PpVersion = row["pp_version"],
        };
    }

    /// <summary>Which profile a visible score belongs to, so its link outlives a profile switch.</summary>
    public static long? Owner(Database db, long id) =>
        db.FirstRow($"SELECT s.profile_id FROM scores s WHERE s.id = ? AND {Eligibility.VisibleSql()}", id)?.Long("profile_id");

    /* ------------------------------------------------------------ the replay */

    /// <summary>Characters Windows will not have in a file name, which lazer strips too.</summary>
    [GeneratedRegex("[<>:\"/\\\\|?*\\x00-\\x1f]")]
    private static partial Regex InvalidFileName();

    private const int MaxFileName = 200;

    /// <summary>
    /// The name lazer gives a replay it exports, dated in local time:
    /// <c>&lt;player&gt; playing &lt;artist&gt; - &lt;title&gt; (&lt;mapper&gt;) [&lt;version&gt;] (yyyy-MM-dd_HH-mm).osr</c>.
    /// </summary>
    public static string ReplayFileName(string player, string? artist, string? title, string? creator, string? version, double playedAt)
    {
        var d = DateTimeOffset.FromUnixTimeMilliseconds((long)playedAt).ToLocalTime();
        var stamp = d.ToString("yyyy-MM-dd_HH-mm", CultureInfo.InvariantCulture);
        var name = $"{player} playing {(string.IsNullOrEmpty(artist) ? "unknown artist" : artist)} - "
            + $"{(string.IsNullOrEmpty(title) ? "unknown title" : title)}"
            + $"{(string.IsNullOrEmpty(creator) ? "" : $" ({creator})")}{(string.IsNullOrEmpty(version) ? "" : $" [{version}]")} ({stamp})";
        var clean = Js.Trim(InvalidFileName().Replace(name, ""));
        return $"{Js.Trim(Js.Slice(clean, MaxFileName))}.osr";
    }

    /// <summary>
    /// <c>Content-Disposition</c> for a name that may not be ASCII: an ASCII fallback, and the exact
    /// name as RFC 5987 UTF-8, encoded as <c>encodeURIComponent</c> with <c>'()*</c> escaped too.
    /// </summary>
    public static string AttachmentHeader(string fileName)
    {
        var ascii = new StringBuilder(fileName.Length);
        foreach (var c in fileName) ascii.Append(c is < (char)0x20 or > (char)0x7e or '"' or (char)0x5c ? '_' : c);
        var encoded = new StringBuilder();
        foreach (var b in Encoding.UTF8.GetBytes(fileName))
        {
            var c = (char)b;
            if (c is (>= 'A' and <= 'Z') or (>= 'a' and <= 'z') or (>= '0' and <= '9') or '-' or '_' or '.' or '!' or '~') encoded.Append(c);
            else encoded.Append('%').Append(b.ToString("X2", CultureInfo.InvariantCulture));
        }
        return $"attachment; filename=\"{ascii}\"; filename*=UTF-8''{encoded}";
    }

    /// <summary>
    /// The replay to hand the browser for one of this profile's scores, or why there is none. The
    /// path comes from the database only: the request names a score, never a file.
    /// </summary>
    public static (string? Path, string? FileName, string? Error) ReplayDownload(Database db, long profileId, long id, string player)
    {
        var row = db.FirstRow($"""
            SELECT s.replay_path, s.client, s.origin, s.played_at, b.artist, b.title, b.creator, b.version
              FROM scores s
              LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
             WHERE s.id = ? AND s.profile_id = ? AND {Eligibility.VisibleSql()}
            """, id, profileId);
        if (row is null) return (null, null, $"no score {id} on this profile");
        if (row.Str("replay_path") is not { Length: > 0 } file) return (null, null, "no replay was recorded for this score");
        if (row.Str("client") == "mcosu") return (null, null, "McOsu does not save replays");
        if (row["origin"] is not null) return (null, null, "this score has no replay file");
        if (!File.Exists(file)) return (null, null, "the replay is no longer in osu!'s files - it may have been deleted from osu!");
        return (file, ReplayFileName(player, row.Str("artist"), row.Str("title"), row.Str("creator"), row.Str("version"),
            row.Num("played_at") ?? 0), null);
    }
}

/// <summary>
/// A profile's avatar and banner in <c>data/</c>, and the images in its me!: src/identity.ts and
/// src/about-images.ts, the reading halves.
/// </summary>
internal static partial class Identity
{
    /// <summary>The types a stored image may have, by extension (MIME_FOR_EXTENSION).</summary>
    private static readonly Dictionary<string, string> MimeForExtension = new()
    {
        [".png"] = "image/png", [".jpg"] = "image/jpeg", [".jpeg"] = "image/jpeg", [".webp"] = "image/webp", [".gif"] = "image/gif",
    };

    /// <summary>The address <c>saveAboutImage</c> gives an image: a profile, its content's hash, its type.</summary>
    [GeneratedRegex(@"^/api/about-image/([0-9]+)/([0-9a-f]{16})\.(png|jpg|webp|gif)\z")]
    private static partial Regex AboutImageRoute();

    public static bool IsAboutImageRoute(string pathname) => AboutImageRoute().IsMatch(pathname);

    /// <summary>The file behind a me! image's address, or null for anything else or a file that is gone.</summary>
    public static (string File, string Mime)? AboutImageFile(string dataDir, string pathname)
    {
        var m = AboutImageRoute().Match(pathname);
        if (!m.Success) return null;
        var file = Path.Combine(dataDir, "about-images", m.Groups[1].Value, $"{m.Groups[2].Value}.{m.Groups[3].Value}");
        return MimeForExtension.TryGetValue($".{m.Groups[3].Value}", out var mime) && File.Exists(file) ? (file, mime) : null;
    }

    private static readonly string[] Extensions = [".png", ".jpg", ".jpeg", ".webp", ".gif"];

    /// <summary>The names from before profiles had their own, kept working.</summary>
    private static readonly Dictionary<string, string[]> LegacyNames = new()
    {
        ["avatar"] = ["avatar.png", "avatar.jpg", "avatar.jpeg", "avatar.webp"],
        ["cover"] = ["cover.jpg", "cover.png", "cover.jpeg", "cover.webp"],
    };

    /// <summary>The image this profile shows, or null to fall back to what the page draws.</summary>
    public static string? FindImage(string dataDir, long profileId, string kind)
    {
        foreach (var extension in Extensions)
        {
            var file = Path.Combine(dataDir, $"profile-{profileId}-{kind}{extension}");
            if (File.Exists(file)) return file;
        }
        foreach (var name in LegacyNames[kind])
        {
            var file = Path.Combine(dataDir, name);
            if (File.Exists(file)) return file;
        }
        return null;
    }

    public static (bool HasAvatar, bool HasCover) ImageState(string dataDir, long profileId) =>
        (FindImage(dataDir, profileId, "avatar") is not null, FindImage(dataDir, profileId, "cover") is not null);
}
