using OsuLocalProfiles.Db;

namespace OsuLocalProfiles.Tracker;

/// <summary>A play the app turned away, as Settings lists it.</summary>
internal sealed record DeclinedPlay(
    long Id,
    string Kind,
    string Reason,
    string? Criterion,
    string? Player,
    string Source,
    string? Title,
    string? TitleOriginal,
    long? Mode,
    long? PlayedAt,
    long DeclinedAt,
    string? FileName);

/// <summary>
/// Plays the tracking filter or the owner check turned away: src/tracker/declined.ts, reading
/// half. Recorded in <c>declined_plays</c>, which no figure reads.
/// </summary>
internal static class Declined
{
    /// <summary>The last part of a path, by either separator, as <c>split(/[\/]/).pop()</c>.</summary>
    private static string BaseName(string file) => file.Split((char)0x5C, '/')[^1];

    public static List<DeclinedPlay> List(Database db, long profileId) => db.All(
        "SELECT * FROM declined_plays WHERE profile_id = ? ORDER BY declined_at DESC, id DESC",
        r =>
        {
            var title = r.TextOrNull("title");
            var replayPath = r.TextOrNull("replay_path");
            return new DeclinedPlay(
                r.Long("id"), r.Text("kind"), r.Text("reason"), r.TextOrNull("criterion"), r.TextOrNull("player"),
                r.Text("source"), title, r.TextOrNull("title_original"), r.LongOrNull("mode"), r.LongOrNull("played_at"),
                r.Long("declined_at"),
                title is null && replayPath is not null ? BaseName(replayPath) : null);
        },
        profileId);
}
