using System.Text.Json;
using OsuLocalProfiles.Calc;
using OsuLocalProfiles.Clients;
using OsuLocalProfiles.Db;
using OsuLocalProfiles.Replays;

namespace OsuLocalProfiles.Tracker;

/// <summary>What a recalculation did: scores looked at, repriced, left as they were, and how many gained a pp they lacked.</summary>
internal sealed record RecomputeResult(int Considered, int Updated, int Skipped, int GainedPp)
{
    public static RecomputeResult operator +(RecomputeResult a, RecomputeResult b) =>
        new(a.Considered + b.Considered, a.Updated + b.Updated, a.Skipped + b.Skipped, a.GainedPp + b.GainedPp);

    public static readonly RecomputeResult None = new(0, 0, 0, 0);
}

/// <summary>One profile's scores to recalculate, at most <see cref="Recompute.Batch"/> of them.</summary>
internal sealed record RecalculateBatch(long ProfileId, List<long> Ids);

/// <summary>
/// Pricing stored scores again from their replays: src/tracker/recompute.ts. The same pricing as
/// ingest (<see cref="Pricing"/>), written by an UPDATE generated from the same columns.
/// </summary>
internal static class Recompute
{
    private const string MissingClause = "(map_status IS NULL OR mods_ranked_by IS NULL)";

    /// <summary>How many scores one step of a recalculation reprices before the queue lets anything else in.</summary>
    public const int Batch = 50;

    private const string RecalculatedKey = "pp_recalculated_for";

    /// <summary>Scores recorded before their map's status or their mods' ranking was stored, that a replay can fill in.</summary>
    public static long CountStale(Database db, long profileId) => Convert.ToInt64(db.Scalar($"""
        SELECT COUNT(*) AS n FROM scores
         WHERE profile_id = ? AND replay_path IS NOT NULL AND imported_at IS NULL
           AND {MissingClause}
        """, profileId));

    private static void Update(Database db, long id, IEnumerable<KeyValuePair<string, object?>> values)
    {
        var list = values.ToList();
        db.Run($"UPDATE scores SET {string.Join(", ", list.Select(c => $"{c.Key} = ?"))} WHERE id = ?", [.. list.Select(c => c.Value), id]);
    }

    /// <summary>
    /// Reprice a profile's scores from their replays: all of them, those missing what a recalculation
    /// fills in, or the ones named. A score whose beatmap file is gone keeps what only the file could
    /// give; one whose replay is gone has its mods asked about again.
    /// </summary>
    public static async Task<RecomputeResult> Scores(Database db, BeatmapResolver resolver, long profileId, OfficialCalculator official,
        bool onlyMissing = false, IReadOnlyList<long>? ids = null, Action<int, int>? onProgress = null)
    {
        var rows = db.Rows($"""
            SELECT id, replay_path, pp, mode, mods_json, map_status FROM scores
             WHERE profile_id = ? AND replay_path IS NOT NULL AND imported_at IS NULL
               {(onlyMissing ? $"AND {MissingClause}" : "")}
               {(ids is not null ? $"AND id IN ({(ids.Count == 0 ? "NULL" : string.Join(",", ids.Select(_ => "?")))})" : "")}
             ORDER BY played_at ASC
            """, [profileId, .. (ids ?? []).Cast<object?>()]);

        int updated = 0, skipped = 0, gainedPp = 0;
        foreach (var row in rows)
        {
            onProgress?.Invoke(updated + skipped, rows.Count);
            var id = (long)row.Num("id")!;
            var replayPath = row.Str("replay_path")!;

            ReplayScore score;
            try
            {
                score = Osr.Parse(File.ReadAllBytes(replayPath));
            }
            catch (Exception e) when (e is not OutOfMemoryException)
            {
                await RecheckStoredMods(db, row, official);
                skipped++;
                continue;
            }

            var beatmap = resolver.Resolve(score.BeatmapMD5);
            var mods = Mods.ScoreMods(score, beatmap.OsuPath);
            var pricing = Mods.ScorePricing(score, beatmap.OsuPath);
            var computed = await Pricing.PriceAsPlayed(replayPath, beatmap, official, pricing);
            var (stripped, modsRanked) = await Pricing.PriceTheRest(score, replayPath, beatmap, mods, official, pricing);
            var values = Pricing.PricedColumns(mods, beatmap, computed, stripped, modsRanked, official.Version);

            if (!string.IsNullOrEmpty(beatmap.OsuPath))
            {
                Update(db, id, values);
                updated++;
            }
            else
            {
                Update(db, id, values.Where(c => !Pricing.BeatmapPriced.Contains(c.Key)));
                skipped++;
            }
            if (row["pp"] is null && computed is not null) gainedPp++;
        }
        onProgress?.Invoke(rows.Count, rows.Count);
        return new RecomputeResult(rows.Count, updated, skipped, gainedPp);
    }

    /// <summary>A score whose replay is gone: its stored mods asked about again, so a ranked-mods fix still reaches it.</summary>
    private static async Task RecheckStoredMods(Database db, Row row, OfficialCalculator official)
    {
        if (row["map_status"] is null || row.Str("mods_json") is not { } modsJson) return;
        if (!JsonText.TryParse(modsJson, out var mods)) return;
        var answer = await official.Ranked((int)(row.Num("mode") ?? 0), mods, null);
        if (answer is not { } a) return;
        db.Run("UPDATE scores SET mods_ranked = ?, mods_ranked_by = ?, ranked = ? WHERE id = ?",
            a.Ranked ? 1 : 0, official.Version ?? "unknown", Status.AwardsPp(Pricing.StatusOf(row["map_status"])) && a.Ranked ? 1 : 0, row["id"]);
    }

    /// <summary>Every score a recalculation would reprice, in batches by profile: all, or those another osu! release priced.</summary>
    public static List<RecalculateBatch> Batches(Database db, string? outdatedFor) => ToBatches(outdatedFor is null
        ? db.All("""
            SELECT id, profile_id FROM scores
             WHERE replay_path IS NOT NULL AND imported_at IS NULL
             ORDER BY profile_id, played_at
            """, r => (r.Long("id"), r.Long("profile_id")))
        : db.All("""
            SELECT s.id, s.profile_id FROM scores s
             WHERE s.replay_path IS NOT NULL AND s.imported_at IS NULL AND s.pp IS NOT NULL
               AND (s.pp_version IS NULL OR s.pp_version <> ?)
             ORDER BY s.profile_id, s.played_at
            """, r => (r.Long("id"), r.Long("profile_id")), outdatedFor));

    /// <summary>Scores priced while their beatmap was not found, whose file the index has since.</summary>
    public static List<(long Id, long ProfileId)> FoundBeatmapIds(Database db) => db.All("""
        SELECT s.id, s.profile_id FROM scores s JOIN beatmaps b ON b.md5 = s.beatmap_md5
         WHERE b.osu_path IS NULL AND s.replay_path IS NOT NULL AND s.imported_at IS NULL
           AND EXISTS (SELECT 1 FROM osu_files f WHERE f.md5 = s.beatmap_md5)
         ORDER BY s.profile_id, s.played_at
        """, r => (r.Long("id"), r.Long("profile_id")));

    /// <summary>
    /// Stable plays whose mods were read from only part of their bitmask (the first 15 bits, as
    /// osu!standard), found by reading each replay's header again.
    /// </summary>
    public static List<(long Id, long ProfileId)> MisdecodedIds(Database db, Func<string, (int Mode, int LegacyMods)?>? readHeader = null)
    {
        readHeader ??= ReadReplayHeader;
        var rows = db.All("""
            SELECT id, profile_id, replay_path FROM scores
             WHERE client IN ('stable', 'mcosu') AND replay_path IS NOT NULL AND imported_at IS NULL
             ORDER BY profile_id, played_at
            """, r => (Id: r.Long("id"), ProfileId: r.Long("profile_id"), Path: r.Text("replay_path")));
        static string Label(List<JsonElement> mods) => string.Join(",", mods.Select(m => Mods.Acronym(m)));
        return [.. rows.Where(row =>
        {
            if (readHeader(row.Path) is not { } header) return false;
            return Label(Mods.DecodeLegacy(header.LegacyMods & 0x7fff, 0)) != Label(Mods.DecodeLegacy(header.LegacyMods, header.Mode));
        }).Select(row => (row.Id, row.ProfileId))];
    }

    /// <summary>A replay's mode and mod bits from its first bytes, or null when it cannot be read.</summary>
    public static (int Mode, int LegacyMods)? ReadReplayHeader(string file)
    {
        if (Backfill.ReadHead(file, 512) is not { } head) return null;
        try
        {
            var header = Osr.ParseHeader(head);
            return (header.Mode, header.LegacyMods);
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            return null;
        }
    }

    /// <summary>Rows in batches of one profile each, at most <see cref="Batch"/> long, each row once.</summary>
    public static List<RecalculateBatch> ToBatches(IEnumerable<(long Id, long ProfileId)> rows)
    {
        var seen = new HashSet<long>();
        var batches = new List<RecalculateBatch>();
        foreach (var (id, profileId) in rows)
        {
            if (!seen.Add(id)) continue;
            if (batches.Count > 0 && batches[^1].ProfileId == profileId && batches[^1].Ids.Count < Batch) batches[^1].Ids.Add(id);
            else batches.Add(new RecalculateBatch(profileId, [id]));
        }
        return batches;
    }

    /// <summary>The osu! release every score was last recalculated for, or null.</summary>
    public static string? RecalculatedFor(Database db) => db.FirstRow("SELECT value FROM kv WHERE key = ?", RecalculatedKey)?.Str("value");

    public static void MarkRecalculatedFor(Database db, string release) =>
        db.Run("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", RecalculatedKey, release);
}

/// <summary>When the app last ran, so a launch can import the gap it was closed for: src/tracker/catch-up.ts.</summary>
internal static class CatchUp
{
    private const string LastRunKey = "lastRunAt";

    /// <summary>How often the running app stamps itself, so a crash loses at most this much of the gap.</summary>
    public const double HeartbeatMs = 30 * 60 * 1000;

    public static double? LastRunAt(Database db)
    {
        var raw = db.FirstRow("SELECT value FROM kv WHERE key = ?", LastRunKey)?["value"];
        // `Number(row?.value)`: undefined is NaN, text is read as JavaScript reads it.
        var at = raw switch
        {
            null => double.NaN,
            string s => Js.StringToNumber(s),
            long l => l,
            double d => d,
            _ => double.NaN,
        };
        return double.IsFinite(at) && at > 0 ? at : null;
    }

    public static void MarkRunning(Database db, double? at = null) =>
        db.Run("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            LastRunKey, Js.NumberToString(at ?? Js.Now()));

    /// <summary>Where a catch-up would start: the later of the last run and the tracking start, if that is before now.</summary>
    public static double? Since(double? stamp, double trackingSince, double? now = null)
    {
        if (stamp is null) return null;
        var since = Math.Max(stamp.Value, trackingSince);
        return since < (now ?? Js.Now()) ? since : null;
    }
}
