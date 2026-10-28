using System.Text.Json;
using OsuLocalProfiles.Db;

namespace OsuLocalProfiles.Calc;

/// <summary>
/// Total Play Time, the way osu! computes it: src/calc/play-time.ts. For every play,
/// <c>min(beatmap length / rate, time from token to submission)</c>; a finished score counts its
/// whole length, and the length ends at the last object's start (or its end for a spinner or a
/// mania hold). The reasons for both are in the TypeScript.
/// </summary>
internal static class PlayTime
{
    /// <summary>The default speed of each rate-adjust mod when lazer wrote no setting for it.</summary>
    private static readonly Dictionary<string, double> DefaultRate = new() { ["DT"] = 1.5, ["NC"] = 1.5, ["HT"] = 0.75, ["DC"] = 0.75 };

    /// <summary>How fast the play ran: only osu!'s rate-adjust mods, as in <c>GetPlayLength</c>.</summary>
    public static double PlayRate(IEnumerable<JsonElement> mods)
    {
        double rate = 1;
        foreach (var mod in mods)
        {
            if (Mods.Acronym(mod) is not { } acronym || !DefaultRate.TryGetValue(acronym, out var fallback)) continue;
            var setting = Js.Get(Js.Get(mod, "settings"), "speed_change");
            rate *= setting is { ValueKind: JsonValueKind.Number } n && Js.NumberOf(n) > 0 ? Js.NumberOf(n) : fallback;
        }
        return rate;
    }

    /// <summary>
    /// First hit object to last, in milliseconds, from a <c>.osu</c> file's <c>[HitObjects]</c>.
    /// 0 when there are none, which callers treat as unknown.
    /// </summary>
    public static long BeatmapLengthMs(string text)
    {
        const string header = "[HitObjects]";
        var start = text.IndexOf(header, StringComparison.Ordinal);
        if (start < 0) return 0;

        var first = double.PositiveInfinity;
        var last = double.NegativeInfinity;
        foreach (var raw in text[(start + header.Length)..].Split('\n'))
        {
            var line = Js.Trim(raw);
            if (line.Length == 0) continue;
            if (line.StartsWith('[')) break;

            var fields = line.Split(',');
            var time = fields.Length > 2 ? Js.StringToNumber(fields[2]) : double.NaN;
            var type = fields.Length > 3 ? Js.StringToNumber(fields[3]) : double.NaN;
            if (!double.IsFinite(time) || !double.IsFinite(type)) continue;

            var end = time;
            // Spinner (bit 3) and mania hold (bit 7) carry their end time in the sixth field, a
            // hold as `end:hitSample`.
            var bits = JsInt32(type);
            if ((bits & 8) != 0 || (bits & 128) != 0)
            {
                var value = Js.StringToNumber((fields.Length > 5 ? fields[5] : "").Split(':')[0]);
                if (double.IsFinite(value) && value > end) end = value;
            }

            if (time < first) first = time;
            if (end > last) last = end;
        }

        return double.IsFinite(first) && last > first ? (long)Js.Round(last - first) : 0;
    }

    /// <summary>JavaScript's ToInt32, which a bitwise <c>&amp;</c> applies to its operands.</summary>
    private static int JsInt32(double n)
    {
        if (!double.IsFinite(n)) return 0;
        var m = Math.Truncate(n) % 4294967296.0;
        if (m < 0) m += 4294967296.0;
        return unchecked((int)(uint)m);
    }

    /// <summary>
    /// Give every cached beatmap a length, reading each <c>.osu</c> at most once. A file that cannot
    /// be read is stored as 0 so it is not retried. Skipped on a read-only database, where the Node
    /// app that owns it fills them in.
    /// </summary>
    private static void FillBeatmapLengths(Database db)
    {
        if (!db.Writable) return;
        var missing = db.All("SELECT md5, osu_path FROM beatmaps WHERE length_ms IS NULL AND osu_path IS NOT NULL",
            r => (Md5: r.GetString(0), Path: r.GetString(1)));
        foreach (var (md5, path) in missing)
        {
            long length = 0;
            try
            {
                length = BeatmapLengthMs(Js.ReadFileUtf8(path));
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                /* moved or deleted since it was indexed: unknown, and remembered as such */
            }
            db.Run("UPDATE beatmaps SET length_ms = ? WHERE md5 = ?", length, md5);
        }
    }

    /// <summary>Total seconds played in one mode, scored plays and incomplete ones together.</summary>
    public static double Seconds(Database db, long profileId, double mode, Eligibility e)
    {
        FillBeatmapLengths(db);
        double ms = 0;

        // A profile's scores use a handful of distinct mod lists, so each is parsed once.
        var rates = new Dictionary<string, double>(StringComparer.Ordinal);
        foreach (var row in db.Rows($"""
            SELECT s.mods_json, b.length_ms
              FROM scores s LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
             WHERE s.profile_id = ? AND s.mode = ? AND {Eligibility.VisibleSql()}
            """, profileId, mode))
        {
            var length = row.Num("length_ms");
            if (length is null or 0) continue;
            var json = row.Text("mods_json");
            if (!rates.TryGetValue(json, out var rate))
            {
                // Unreadable mods: treat as nomod rather than drop the play.
                rate = PlayRate(Mods.Parse(json) ?? []);
                rates[json] = rate;
            }
            ms += length.Value / rate;
        }

        foreach (var row in db.Rows($"""
            SELECT s.started_at, s.played_at, b.length_ms
              FROM incomplete_plays s LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
             WHERE s.profile_id = ? AND s.mode = ? AND {Eligibility.IncompleteSql(e)} AND s.started_at IS NOT NULL
            """, profileId, mode))
        {
            var elapsed = Math.Max(0, (row.Num("played_at") ?? 0) - (row.Num("started_at") ?? 0));
            // The log never names the mods, so the cap is the map at its own speed.
            var length = row.Num("length_ms");
            ms += length is not null and not 0 ? Math.Min(length.Value, elapsed) : elapsed;
        }

        return Math.Floor(ms / 1000);
    }
}
