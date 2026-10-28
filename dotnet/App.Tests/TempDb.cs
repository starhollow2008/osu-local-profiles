using OsuLocalProfiles.Db;

namespace OsuLocalProfiles.Tests;

/// <summary>A database in its own temporary folder, gone when disposed: the TypeScript tests' harness.</summary>
internal sealed class TempDb : IDisposable
{
    public string Folder { get; } = Directory.CreateTempSubdirectory("olp-cs-").FullName;
    public string File => Path.Combine(Folder, "test.db");
    public Database Db { get; private set; }
    public long ProfileId { get; }

    public TempDb(string firstProfile = "First")
    {
        Db = Database.Open(File);
        ProfileId = Db.GetOrCreateProfile(firstProfile);
    }

    /// <summary>Close and open the same file again, as a restart would.</summary>
    public Database Reopen()
    {
        Db.Dispose();
        Db = Database.Open(File);
        return Db;
    }

    public void InsertScore(long profileId, string key)
    {
        Db.Run("""
            INSERT INTO scores
              (profile_id, dedupe_key, mode, beatmap_md5, client, mods_json, mods_label,
               count300, count100, count50, count_geki, count_katu, count_miss,
               accuracy, max_combo, total_score, passed, grade, pp, ranked, played_at)
             VALUES (?,?,0,?,'lazer','[]','None',100,0,0,0,0,0,1.0,100,500000,1,'X',120.5,1,?)
            """, profileId, key, $"md5-{key}", Js.Now());
    }

    public void Dispose()
    {
        Db.Dispose();
        try
        {
            Directory.Delete(Folder, recursive: true);
        }
        catch (IOException)
        {
            /* a scanner holding the file: the temp folder is the system's to clear */
        }
    }
}
