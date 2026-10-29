using System.Security.Cryptography;
using System.Text;
using OsuLocalProfiles.Calc;
using OsuLocalProfiles.Db;

namespace OsuLocalProfiles;

/// <summary>A profile's pictures and me! images, written: src/identity.ts and src/about-images.ts, the writing half.</summary>
internal static partial class Identity
{
    private static string ProfileFile(string dataDir, long profileId, string kind, string extension) =>
        NodePath.Join(dataDir, $"profile-{profileId}-{kind}{extension}");

    /// <summary>What an upload is, from its first bytes; never from its name, which is the sender's to choose.</summary>
    public static string? SniffImage(byte[] bytes)
    {
        if (bytes.Length < 12) return null;
        string Latin(int start, int length) => Encoding.Latin1.GetString(bytes, start, length);
        if (bytes[0] == 0x89 && Latin(1, 3) == "PNG") return ".png";
        if (bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff) return ".jpg";
        if (Latin(0, 4) == "RIFF" && Latin(8, 4) == "WEBP") return ".webp";
        if (Latin(0, 6) is "GIF89a" or "GIF87a") return ".gif";
        return null;
    }

    /// <summary>A profile's avatar or banner, in place of any it had in another format.</summary>
    public static string SaveImage(string dataDir, long profileId, string kind, byte[] bytes, string extension)
    {
        if (!MimeForExtension.ContainsKey(extension)) throw new InvalidOperationException($"unsupported image type {extension}");
        Directory.CreateDirectory(dataDir);
        ClearImage(dataDir, profileId, kind);
        var file = ProfileFile(dataDir, profileId, kind, extension);
        File.WriteAllBytes(file, bytes);
        return file;
    }

    /// <summary>Back to the generated picture. A hand-placed legacy <c>avatar.png</c> is never deleted.</summary>
    public static void ClearImage(string dataDir, long profileId, string kind)
    {
        foreach (var extension in Extensions)
        {
            var file = ProfileFile(dataDir, profileId, kind, extension);
            if (File.Exists(file)) File.Delete(file);
        }
    }

    /// <summary>An image for a profile's me!, named by its content's hash: its address, or null when it is no image.</summary>
    public static string? SaveAboutImage(string dataDir, long profileId, byte[] bytes)
    {
        if (SniffImage(bytes) is not { } extension) return null;
        var name = $"{Convert.ToHexStringLower(SHA256.HashData(bytes))[..16]}{extension}";
        var folder = NodePath.Join(dataDir, "about-images", profileId.ToString(System.Globalization.CultureInfo.InvariantCulture));
        Directory.CreateDirectory(folder);
        var file = NodePath.Join(folder, name);
        if (!File.Exists(file)) File.WriteAllBytes(file, bytes);
        return $"/api/about-image/{profileId}/{name}";
    }
}

/// <summary>A row the user acts on: removed, put back, pinned, deleted for good (src/scores.ts, the writing half).</summary>
internal static partial class Scores
{
    /// <summary>The ids a request names, each once: <c>[...new Set(ids.map(Number).filter(Number.isInteger))]</c>.</summary>
    public static List<long> WholeIds(IEnumerable<double> ids) =>
        [.. ids.Where(n => double.IsFinite(n) && n == Math.Floor(n)).Select(n => (long)n).Distinct()];

    private static string Marks(int n) => string.Join(",", Enumerable.Repeat("?", n));

    /// <summary>Remove unfinished plays, or put them back: every attempt a row stands for, all or nothing.</summary>
    public static int SetIncompleteHidden(Database db, long profileId, IEnumerable<double> ids, bool hidden) => db.Serialized(() =>
    {
        var wanted = WholeIds(ids);
        if (wanted.Count == 0) throw new InvalidOperationException("no play named");
        var owned = Convert.ToInt64(db.Scalar($"SELECT COUNT(*) AS n FROM incomplete_plays WHERE profile_id = ? AND id IN ({Marks(wanted.Count)})",
            [profileId, .. wanted.Cast<object?>()]));
        if (owned != wanted.Count) throw new InvalidOperationException("no such play on this profile");
        db.Run($"UPDATE incomplete_plays SET hidden_at = ? WHERE profile_id = ? AND id IN ({Marks(wanted.Count)})",
            [hidden ? Js.Now() : null, profileId, .. wanted.Cast<object?>()]);
        return wanted.Count;
    });

    private static Row OwnedScore(Database db, long profileId, double id) =>
        db.FirstRow("SELECT id, mode FROM scores WHERE id = ? AND profile_id = ?", id, profileId)
        ?? throw new InvalidOperationException($"no score {Js.NumberToString(id)} on this profile");

    /// <summary>Pin, unpin, remove or put back one score. A pin goes last among that mode's.</summary>
    public static void ApplyAction(Database db, long profileId, double id, string action) => db.Serialized(() =>
    {
        var score = OwnedScore(db, profileId, id);
        var now = Js.Now();
        switch (action)
        {
            case "pin":
                var last = Convert.ToDouble(db.Scalar("""
                    SELECT COALESCE(MAX(pin_order), -1) AS last FROM scores
                     WHERE profile_id = ? AND mode = ? AND pinned_at IS NOT NULL
                    """, profileId, score["mode"]));
                db.Run("UPDATE scores SET pinned_at = ?, pin_order = ? WHERE id = ?", now, last + 1, id);
                return;
            case "unpin":
                db.Run("UPDATE scores SET pinned_at = NULL, pin_order = NULL WHERE id = ?", id);
                return;
            case "hide":
                // A removed score is no longer pinned: putting it back does not bring the pin back.
                db.Run("UPDATE scores SET hidden_at = ?, pinned_at = NULL, pin_order = NULL WHERE id = ?", now, id);
                return;
            case "restore":
                db.Run("UPDATE scores SET hidden_at = NULL WHERE id = ?", id);
                return;
            default:
                throw new InvalidOperationException($"unknown action {JsonText.Stringify(action)}");
        }
    });

    /// <summary>Pins in the order given; any not named keep theirs, after them.</summary>
    public static void ReorderPins(Database db, long profileId, IEnumerable<double> ids)
    {
        var unique = WholeIds(ids);
        db.Transaction(() =>
        {
            for (var index = 0; index < unique.Count; index++)
            {
                db.Run("UPDATE scores SET pin_order = ? WHERE id = ? AND profile_id = ? AND pinned_at IS NOT NULL", index, unique[index], profileId);
            }
            db.Run($"""
                UPDATE scores SET pin_order = ? + pin_order
                 WHERE profile_id = ? AND pinned_at IS NOT NULL
                   AND id NOT IN ({(unique.Count == 0 ? "NULL" : Marks(unique.Count))})
                """, [unique.Count, profileId, .. unique.Cast<object?>()]);
        });
    }

    /// <summary>How many plays are removed: scores, and each attempt of a removed unfinished play.</summary>
    public static double HiddenCount(Database db, long profileId) => Convert.ToDouble(db.Scalar("""
        SELECT (SELECT COUNT(*) FROM scores WHERE profile_id = ? AND hidden_at IS NOT NULL)
             + (SELECT COUNT(*) FROM incomplete_plays WHERE profile_id = ? AND hidden_at IS NOT NULL) AS n
        """, profileId, profileId));

    /// <summary>
    /// Removed scores and unfinished plays, newest removal first, for Settings to list and put back.
    /// An unfinished play's attempts removed together are one row.
    /// </summary>
    public static List<Dictionary<string, object?>> Hidden(Database db, long profileId, int limit = 200)
    {
        var scores = db.Rows($"""
            SELECT s.id, s.mode, s.mods_label, s.client, s.accuracy, s.grade, s.pp, s.played_at, s.hidden_at,
                   {Metadata.NameColumns}, b.version
              FROM scores s
              LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
             WHERE s.profile_id = ? AND s.hidden_at IS NOT NULL
             ORDER BY s.hidden_at DESC
             LIMIT ?
            """, profileId, limit).Select(r =>
        {
            var n = Metadata.Names(r);
            var name = Metadata.BeatmapName(n);
            return new Dictionary<string, object?>
            {
                ["kind"] = "score",
                ["id"] = r["id"],
                ["mode"] = r["mode"],
                ["title"] = name.Length > 0 ? name : $"beatmap {Js.ToJsString(JsonText.From(r["id"]))}",
                ["titleOriginal"] = Metadata.BeatmapNameOriginal(n),
                ["version"] = r["version"],
                ["modsLabel"] = ClassicLabel(r.Str("mods_label") ?? "", Mods.ScoredAsStable(r["client"] is null ? "null" : Js.ToJsString(JsonText.From(r["client"])))),
                ["accuracy"] = r["accuracy"],
                ["grade"] = r["grade"],
                ["pp"] = r["pp"],
                ["playedAt"] = r["played_at"],
                ["hiddenAt"] = r["hidden_at"],
            };
        });
        var incomplete = db.Rows("""
            SELECT GROUP_CONCAT(s.id) AS ids, COUNT(*) AS attempts, MIN(s.mode) AS mode,
                   MAX(s.played_at) AS played_at, s.hidden_at, s.unsubmitted,
                   MAX(s.beatmap_name) AS beatmap_name, MAX(b.artist) AS artist, MAX(b.title) AS title,
                   MAX(b.artist_unicode) AS artist_unicode, MAX(b.title_unicode) AS title_unicode,
                   MAX(b.version) AS version
              FROM incomplete_plays s
              LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
             WHERE s.profile_id = ? AND s.hidden_at IS NOT NULL
             GROUP BY s.hidden_at, COALESCE(s.beatmap_md5, s.beatmap_name, s.id), s.unsubmitted
             ORDER BY s.hidden_at DESC
             LIMIT ?
            """, profileId, limit).Select(r =>
        {
            var n = Metadata.Names(r);
            var name = Metadata.BeatmapName(n);
            var ids = r["ids"] is null ? "null" : Js.ToJsString(JsonText.From(r["ids"]));
            return new Dictionary<string, object?>
            {
                ["kind"] = "incomplete",
                ["ids"] = ids.Split(',').Select(Js.StringToNumber).ToList(),
                ["mode"] = r["mode"],
                ["title"] = name.Length > 0 ? name : r.Str("beatmap_name") ?? "an unknown beatmap",
                ["titleOriginal"] = Metadata.BeatmapNameOriginal(n),
                ["version"] = r["version"],
                ["unsubmitted"] = r["unsubmitted"] is 1L,
                ["attempts"] = r["attempts"],
                ["playedAt"] = r["played_at"],
                ["hiddenAt"] = r["hidden_at"],
            };
        });
        // Newest removal first, scores before plays at the same moment, as a stable sort leaves them.
        return [.. scores.Concat(incomplete).OrderByDescending(x => ToNumber(x["hiddenAt"])).Take(limit)];
    }

    private static double ToNumber(object? v) => v switch { long l => l, double d => d, _ => double.NaN };

    /// <summary>
    /// Delete removed rows for good, keeping their keys in <c>deleted_scores</c> so no import brings
    /// them back: the ones named (which must be removed already, and this profile's), or every one.
    /// </summary>
    public static int DeleteRemoved(Database db, long profileId, IReadOnlyList<double>? ids, double now, string kind = "score") => db.Serialized(() =>
    {
        List<long>? wanted = ids is null ? null : WholeIds(ids);
        if (wanted is { Count: 0 }) return 0;
        var tables = new List<(string Table, Func<string, string> Key)>();
        if (ids is null || kind == "score") tables.Add(("scores", k => k));
        if (ids is null || kind == "incomplete") tables.Add(("incomplete_plays", DeletedIncompleteKey));

        var doomed = tables.Select(t =>
        {
            var rows = db.Rows(
                $"SELECT id, dedupe_key, hidden_at FROM {t.Table} WHERE profile_id = ? {(wanted is null ? "AND hidden_at IS NOT NULL" : $"AND id IN ({Marks(wanted.Count)})")}",
                [profileId, .. (wanted ?? []).Cast<object?>()]);
            if (wanted is not null)
            {
                var noun = kind == "score" ? "score" : "play";
                if (rows.Count != wanted.Count) throw new InvalidOperationException($"no such {noun} on this profile");
                if (rows.Any(r => r["hidden_at"] is null)) throw new InvalidOperationException($"only a removed {noun} can be deleted");
            }
            return (t.Table, t.Key, Rows: rows);
        }).ToList();

        db.Transaction(() =>
        {
            foreach (var (table, key, rows) in doomed)
            {
                foreach (var r in rows)
                {
                    db.Run("INSERT OR IGNORE INTO deleted_scores (profile_id, dedupe_key, deleted_at) VALUES (?, ?, ?)", profileId, key(r.Str("dedupe_key")!), now);
                    db.Run($"DELETE FROM {table} WHERE id = ?", r["id"]);
                }
            }
        });
        return doomed.Sum(d => d.Rows.Count);
    });

    /// <summary>A stored mods label as osu! shows it for that client: Classic on every stable play.</summary>
    public static string ClassicLabel(string label, bool stable)
    {
        if (!stable || System.Text.RegularExpressions.Regex.IsMatch(label, @"(?<![A-Za-z0-9_])CL(?![A-Za-z0-9_])")) return label;
        return label == "None" ? "CL" : $"{label}CL";
    }
}

/// <summary>The rest of what a profile reset clears, and the welcome's end.</summary>
internal static class ProfileData
{
    /// <summary>The welcome, left: skipped, closed or answered, it ends for good.</summary>
    public static void DismissWelcome(Database db) => db.Run("DELETE FROM kv WHERE key = ?", "welcomePending");

    public static void OfferWelcome(Database db) => db.Run("INSERT OR IGNORE INTO kv (key, value) VALUES (?, ?)", "welcomePending", "1");

    /// <summary>
    /// Every play erased and tracking restarted from now: scores, unfinished plays, deletions, the
    /// declined list, the standing and medals borrowed from osu!, and rank events.
    /// </summary>
    public static (double Deleted, double TrackingSince) Reset(Database db, long profileId) => db.Serialized(() =>
    {
        var before = Convert.ToDouble(db.Scalar("""
            SELECT (SELECT COUNT(*) FROM scores WHERE profile_id = ?)
                 + (SELECT COUNT(*) FROM incomplete_plays WHERE profile_id = ?) AS n
            """, profileId, profileId));
        double now = Js.Now();
        db.Transaction(() =>
        {
            db.Run("DELETE FROM scores WHERE profile_id = ?", profileId);
            db.Run("DELETE FROM incomplete_plays WHERE profile_id = ?", profileId);
            db.Run("DELETE FROM deleted_scores WHERE profile_id = ?", profileId);
            Tracker.Declined.Clear(db, profileId);
            db.Run("DELETE FROM imported_standing WHERE profile_id = ?", profileId);
            db.Run("DELETE FROM imported_medals WHERE profile_id = ?", profileId);
            db.Run("DELETE FROM rank_events WHERE profile_id = ?", profileId);
            db.Run("UPDATE profiles SET tracking_since = ? WHERE id = ?", now, profileId);
        });
        return (before, now);
    });
}
