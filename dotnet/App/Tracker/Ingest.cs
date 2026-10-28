using System.Text.Json;
using OsuLocalProfiles.Calc;
using OsuLocalProfiles.Clients;
using OsuLocalProfiles.Db;
using OsuLocalProfiles.Replays;
using OsuLocalProfiles.Settings;

namespace OsuLocalProfiles.Tracker;

/// <summary>
/// What ingesting a replay needs. <c>Filter</c>, <c>Identity</c> and <c>Declines</c> omitted mean no
/// filtering, everyone's replays taken, and nothing recorded: right for a re-ingest of rows already
/// here, which must never pass a filter. <c>ArrivedAt</c> is when a live replay turned up.
/// </summary>
internal sealed record IngestContext(
    Database Db,
    BeatmapResolver Resolver,
    long ProfileId,
    double TrackingSince,
    OfficialCalculator? Official,
    TrackingFilter? Filter = null,
    PlayerIdentity? Identity = null,
    string? Declines = null,
    double? ArrivedAt = null);

/// <summary>A play just tracked, as the console and the page announce it.</summary>
internal sealed record IngestedScore(
    long Id,
    int Mode,
    string Title,
    string? TitleOriginal,
    string ModsLabel,
    double Accuracy,
    string Grade,
    double? Pp,
    double? PpNomod,
    string? PpSource,
    double? Stars,
    bool Ranked,
    bool MapRanked,
    double PlayedAt,
    string Client);

/// <summary>
/// What became of a replay: <c>added</c> with its score; <c>skipped</c> with a reason (too-old,
/// duplicate, deleted, unparseable, not-passed, or another-player with who and which map); or
/// <c>filtered</c> by the profile's filter, with the criterion and which map.
/// </summary>
internal sealed record IngestOutcome(
    string Status,
    string? Reason = null,
    IngestedScore? Score = null,
    string? Player = null,
    string? Title = null,
    string? TitleOriginal = null,
    string? Criterion = null);

/// <summary>A replay read, judged, priced and written as a score: src/tracker/ingest.ts.</summary>
internal static class Ingest
{
    /// <summary>What to call the play in a message: <c>artist - title [version]</c> in both scripts, or the MD5's start.</summary>
    public static (string Title, string? TitleOriginal) Describe(ResolvedBeatmap beatmap, string md5)
    {
        var n = Metadata.Names(beatmap.Artist, beatmap.Title, beatmap.ArtistUnicode, beatmap.TitleUnicode);
        string WithVersion(string name) => string.IsNullOrEmpty(beatmap.Version) ? name : $"{name} [{beatmap.Version}]";
        var original = Metadata.BeatmapNameOriginal(n);
        var name = Metadata.BeatmapName(n);
        return (WithVersion(name.Length > 0 ? name : Js.Slice(md5, 12)), original is null ? null : WithVersion(original));
    }

    /// <summary>
    /// A replay identifies itself; a stable replay with no hash falls back to map and time, and a
    /// McOsu play is known by its beatmap and the moment it ended, as McOsu knows it.
    /// </summary>
    public static string DedupeKey(ReplayScore score)
    {
        var at = Js.NumberToString(score.PlayedAtMs);
        if (score.Client == "mcosu") return $"mcosu:{score.BeatmapMD5}:{at}";
        return score.ReplayMD5 ?? $"{score.BeatmapMD5}:{at}";
    }

    public static async Task<IngestOutcome> ReplayFile(string file, IngestContext ctx)
    {
        ReplayScore score;
        try
        {
            score = Osr.Parse(File.ReadAllBytes(file));
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            // Keyed by its path: with nothing read, there is no play to key it by.
            Declined(ctx, new Decline("score", $"file:{file}", "unparseable", null, null, ctx.Declines ?? "", null, null, null, null, file, null));
            return new IngestOutcome("skipped", "unparseable");
        }
        return await Score(score, file, ctx);
    }

    /// <summary>When a replay's file was last written, or null when it cannot be read.</summary>
    private static double? FileWrittenAt(string file)
    {
        try
        {
            var info = new FileInfo(file);
            if (!info.Exists && !Directory.Exists(file)) return null;
            var written = info.Exists ? info.LastWriteTimeUtc : Directory.GetLastWriteTimeUtc(file);
            return (written - DateTime.UnixEpoch).TotalMilliseconds;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException)
        {
            return null;
        }
    }

    /// <summary>Record a replay turned away, when the caller asked for declines to be kept.</summary>
    private static void Declined(IngestContext ctx, Decline d)
    {
        if (ctx.Declines is null) return;
        Tracker.Declined.Record(ctx.Db, ctx.ProfileId, d with { Source = ctx.Declines });
    }

    private static bool Truthy(JsonElement? value) => Js.Truthy(value);

    public static async Task<IngestOutcome> Score(ReplayScore score, string replayPath, IngestContext ctx)
    {
        double playedAt = score.PlayedAtMs;
        if (playedAt < ctx.TrackingSince) return new IngestOutcome("skipped", "too-old");

        // Someone else's play: checked before anything is read or priced. Not knowing is yours.
        var player = Players.ReplayPlayer(score);
        var key = DedupeKey(score);
        var playerName = Js.Trim(player.Name) is { Length: > 0 } trimmed ? trimmed : null;
        Decline Play(string reason, (string Title, string? TitleOriginal) named, string? criterion = null) =>
            new("score", key, reason, criterion, playerName, ctx.Declines ?? "", named.Title, named.TitleOriginal, score.Mode, playedAt, replayPath, null);
        var justSet = ctx.ArrivedAt is { } arrived && Players.SetJustNow(playedAt, arrived);
        var writtenLater = Players.WasWrittenLater(score, ctx.ArrivedAt ?? FileWrittenAt(replayPath));
        if (Players.OwnsPlay(ctx.Identity ?? PlayerIdentity.Unknown, player, justSet, writtenLater) == false)
        {
            var named = Describe(ctx.Resolver.Resolve(score.BeatmapMD5), score.BeatmapMD5);
            Declined(ctx, Play("another-player", named));
            return new IngestOutcome("skipped", "another-player", Player: Js.Trim(player.Name), Title: named.Title, TitleOriginal: named.TitleOriginal);
        }

        if (ctx.Db.Exists("SELECT id FROM scores WHERE profile_id = ? AND dedupe_key = ?", ctx.ProfileId, key))
        {
            return new IngestOutcome("skipped", "duplicate");
        }
        // Deleted for good from Settings: the replay is still on disk, and must stay out.
        if (Scores.WasDeleted(ctx.Db, ctx.ProfileId, key)) return new IngestOutcome("skipped", "deleted");
        // The same play already here under another record of it: a worse one is replaced in place.
        var found = Existing.Find(ctx.Db, ctx.ProfileId, Existing.ReplayIdentity(score));
        if (found is not null && !Existing.Replaces(found, score.Built is not null ? "built" : "replay"))
        {
            return new IngestOutcome("skipped", "duplicate");
        }

        var mode = score.Mode;
        var beatmap = ctx.Resolver.Resolve(score.BeatmapMD5);
        var mods = Mods.ScoreMods(score, beatmap.OsuPath);
        var pricing = Mods.ScorePricing(score, beatmap.OsuPath);
        var didPass = Grade.Passed(score);
        var grade = Grade.GradeOf(score, mode, mods);
        var acc = Grade.Accuracy(score, mode);
        var described = Describe(beatmap, score.BeatmapMD5);

        // The filter in two halves: everything but the star rating first, so a play rejected on its
        // mods or length is never priced at all.
        var filter = ctx.Filter ?? TrackingFilter.Default();
        BeatmapFilterFacts? facts = null;
        if (filter.Enabled)
        {
            facts = TrackingFilter.BeatmapFacts(ctx.Db, ctx.Resolver, beatmap);
            if (filter.Rejects(TrackingFilter.PlayFactsOf(facts, mode, mods, score.Client)) is { } rejected)
            {
                Declined(ctx, Play("filtered", described, rejected));
                return new IngestOutcome("filtered", Criterion: rejected, Title: described.Title, TitleOriginal: described.TitleOriginal);
            }
        }

        // pp for every score there can be one for, ranked or not: settings decide at query time.
        var computed = await Pricing.PriceAsPlayed(replayPath, beatmap, ctx.Official, pricing);

        // The filter's second half: the star rating as played. One that could not be calculated never rejects.
        if (facts is not null && computed is not null && filter.Rejects(new PlayFacts(Stars: computed.Stars)) is { } byStars)
        {
            Declined(ctx, Play("filtered", described, byStars));
            return new IngestOutcome("filtered", Criterion: byStars, Title: described.Title, TitleOriginal: described.TitleOriginal);
        }

        // A second pass with Relax/Autopilot removed, and whether osu! ranks the mods.
        var (stripped, modsRanked) = await Pricing.PriceTheRest(score, replayPath, beatmap, mods, ctx.Official, pricing);
        var priced = Pricing.PricedColumns(mods, beatmap, computed, stripped, modsRanked, ctx.Official?.Version);

        var statistics = Js.Get(score.Extras, "statistics");
        var maxStatistics = Js.Get(score.Extras, "maximum_statistics");
        // The row by column name, and the statement generated from it, so no value meets the wrong column.
        List<KeyValuePair<string, object?>> row =
        [
            new("profile_id", ctx.ProfileId),
            new("dedupe_key", key),
            new("mode", mode),
            new("beatmap_md5", score.BeatmapMD5),
            new("client", score.Client),
            new("count300", score.Count300),
            new("count100", score.Count100),
            new("count50", score.Count50),
            new("count_geki", score.CountGeki),
            new("count_katu", score.CountKatu),
            new("count_miss", score.CountMiss),
            new("statistics_json", Truthy(statistics) ? JsonText.Stringify(statistics!.Value) : null),
            new("max_statistics_json", Truthy(maxStatistics) ? JsonText.Stringify(maxStatistics!.Value) : null),
            new("accuracy", acc),
            new("max_combo", score.MaxCombo),
            new("total_score", score.TotalScore),
            new("passed", didPass ? 1 : 0),
            new("grade", grade),
            .. priced,
            new("played_at", playedAt),
            // lazer's own id before the legacy header's, which lazer writes as 0.
            new("online_score_id", player.OnlineId is { } onlineId ? Js.NumberToString(onlineId) : null),
            new("replay_path", replayPath),
            new("player_name", player.Name),
            new("player_id", player.UserId),
            // A replay this app built, for a score from its osu! link or entered by hand.
            new("origin", score.Built?.Origin),
        ];
        var columns = row.Select(c => c.Key).ToList();
        var values = row.Select(c => c.Value).ToArray();

        var scoreId = ctx.Db.Serialized(() =>
        {
            if (found is null)
            {
                ctx.Db.Run($"INSERT INTO scores ({string.Join(", ", columns)}) VALUES ({string.Join(", ", columns.Select(_ => "?"))})", values);
                return Convert.ToInt64(ctx.Db.Scalar("SELECT last_insert_rowid() AS id"));
            }
            // The same row as an UPDATE of the worse record: no longer osu!'s figures as they came.
            var old = ctx.Db.FirstRow("SELECT replay_path, origin FROM scores WHERE id = ?", found.Id)!;
            ctx.Db.Run($"UPDATE scores SET {string.Join(", ", columns.Select(c => $"{c} = ?"))}, imported_at = NULL WHERE id = ?", [.. values, found.Id]);
            // A replay this app built for it is not needed any more, once nothing points at it.
            if (old["origin"] is not null && old.Str("replay_path") is { } oldPath && oldPath != replayPath)
            {
                UploadedReplays.Release(ctx.Db, oldPath);
            }
            return found.Id;
        });
        // Tracked now, however it got here, so it is no longer a play the app turned away.
        Tracker.Declined.Forget(ctx.Db, ctx.ProfileId, "score", key);

        var column = priced.ToDictionary(c => c.Key, c => c.Value);
        return new IngestOutcome("added", Score: new IngestedScore(
            scoreId, mode, described.Title, described.TitleOriginal,
            (string)column["mods_label"]!, acc, grade,
            computed?.Value, stripped?.Value, computed is null ? null : "official", computed?.Stars,
            column["ranked"] is 1L, Status.AwardsPp(Pricing.StatusOf(beatmap.Status)), playedAt, score.Client));
    }
}
