using OsuLocalProfiles.Db;

namespace OsuLocalProfiles;

/// <summary>One tracked playstyle, as <c>/api/state</c> lists it.</summary>
internal sealed record Profile(long Id, string Name, long CreatedAt, long TrackingSince, long ScoreCount, bool Active);

/// <summary>A refusal the page shows as it is, such as a name already taken.</summary>
internal sealed class UserError(string message) : Exception(message);

/// <summary>
/// Several tracked playstyles in one install: src/profiles.ts. The active one is kept in
/// <c>kv</c>, not config.json, so a rename never orphans the selection.
/// </summary>
internal static class Profiles
{
    private const string ActiveKey = "activeProfileId";

    public static List<Profile> List(Database db)
    {
        var active = ActiveId(db);
        return db.All("""
            SELECT p.id, p.name, p.created_at, p.tracking_since,
                   ((SELECT COUNT(*) FROM scores s WHERE s.profile_id = p.id)
                    + (SELECT COUNT(*) FROM incomplete_plays i WHERE i.profile_id = p.id))
                     AS score_count
              FROM profiles p
             ORDER BY p.created_at ASC
            """, r => new Profile(
            r.Long("id"), r.Text("name"), r.Long("created_at"), r.Long("tracking_since"), r.Long("score_count"),
            r.Long("id") == active));
    }

    /// <summary>Create the first profile, named from config.json, only when there are none yet.</summary>
    public static void SeedFirst(Database db, string name)
    {
        if (Convert.ToInt64(db.Scalar("SELECT COUNT(*) AS n FROM profiles")) == 0) db.GetOrCreateProfile(name);
    }

    /// <summary>An existing profile by its exact name, or null. Never creates one.</summary>
    public static Profile? FindByName(Database db, string name) => List(db).Find(p => p.Name == name);

    public static Profile? Get(Database db, long id) => List(db).Find(p => p.Id == id);

    /// <summary>
    /// The profile being tracked. Falls back to the oldest when the stored id is missing or gone,
    /// so the app always has somewhere to write; a read-only database is not repaired.
    /// </summary>
    public static long ActiveId(Database db)
    {
        var stored = db.Get("SELECT value FROM kv WHERE key = ?", r => r.GetString(0), ActiveKey);
        if (stored is not null)
        {
            var id = Js.StringToNumber(stored);
            if (double.IsFinite(id) && db.Exists("SELECT 1 AS hit FROM profiles WHERE id = ?", id)) return (long)id;
        }

        var first = db.Get("SELECT id FROM profiles ORDER BY created_at ASC LIMIT 1", r => (long?)r.GetInt64(0))
            ?? throw new InvalidOperationException("no profiles exist");
        if (db.Writable) SetActive(db, first);
        return first;
    }

    public static void SetActive(Database db, long id)
    {
        if (!db.Exists("SELECT 1 AS hit FROM profiles WHERE id = ?", id)) throw new UserError($"no profile with id {id}");
        db.Run("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
            ActiveKey, id.ToString(), id.ToString());
    }

    private static string CleanName(string? name)
    {
        var trimmed = Js.Trim(name ?? "");
        if (trimmed.Length == 0) throw new UserError("a profile needs a name");
        if (trimmed.Length > 60) throw new UserError("that name is too long (60 characters max)");
        return trimmed;
    }

    /// <summary>A new profile starts empty and tracks from now, never from earlier plays.</summary>
    public static Profile Create(Database db, string? name)
    {
        var clean = CleanName(name);
        if (db.Exists("SELECT 1 AS hit FROM profiles WHERE name = ?", clean)) throw new UserError($"a profile called \"{clean}\" already exists");

        var now = Js.Now();
        db.Run("INSERT INTO profiles (name, created_at, tracking_since, default_mode) VALUES (?, ?, ?, 0)", clean, now, now);
        var id = Convert.ToInt64(db.Scalar("SELECT last_insert_rowid() AS id"));
        return Get(db, id)!;
    }

    public static Profile Rename(Database db, long id, string? name)
    {
        var clean = CleanName(name);
        var clash = db.Get("SELECT id FROM profiles WHERE name = ?", r => (long?)r.GetInt64(0), clean);
        if (clash is not null && clash != id) throw new UserError($"a profile called \"{clean}\" already exists");

        if (db.Run("UPDATE profiles SET name = ? WHERE id = ?", clean, id) == 0) throw new UserError($"no profile with id {id}");
        return Get(db, id)!;
    }

    /// <summary>
    /// Delete a profile and everything it tracked (ON DELETE CASCADE). The last one cannot go:
    /// the app must always have somewhere to put the next score.
    /// </summary>
    public static (long DeletedScores, long NextActive) Delete(Database db, long id)
    {
        if (Convert.ToInt64(db.Scalar("SELECT COUNT(*) AS n FROM profiles")) <= 1)
        {
            throw new UserError("this is the only profile -- reset it instead of deleting it");
        }

        // Abandoned attempts included: they are plays, and the confirmation says how much goes.
        var scores = Convert.ToInt64(db.Scalar("""
            SELECT (SELECT COUNT(*) FROM scores WHERE profile_id = ?)
                 + (SELECT COUNT(*) FROM incomplete_plays WHERE profile_id = ?) AS n
            """, id, id));

        db.Transaction(() =>
        {
            if (db.Run("DELETE FROM profiles WHERE id = ?", id) == 0) throw new UserError($"no profile with id {id}");
        });

        // ActiveId repairs a dangling selection by falling back to the oldest profile.
        return (scores, ActiveId(db));
    }
}
