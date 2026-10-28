using System.Text.RegularExpressions;

namespace OsuLocalProfiles.Clients;

/// <summary>
/// A play osu! accepted, as lazer's log describes it: its submission token (a natural dedupe key),
/// when it started (null when the log was joined mid-play), when osu! counted it, osu!'s id for
/// the score, the beatmap as the log named it, and whether it was played to the end. <c>BeatmapId</c>
/// is joined on from the network log, where the submission request names it.
/// </summary>
internal sealed record LoggedPlay(string Token, double? StartedAt, double CountedAt, string OnlineScoreId, string? BeatmapName, bool Passed,
    double? BeatmapId = null);

/// <summary>
/// An attempt osu! logged it had no token for, and so never counted: the gameplay screen's instance
/// number, when it was entered and left, and the beatmap as gameplay began. <c>Session</c> is the
/// session log it came from, which is what makes it unique.
/// </summary>
internal sealed record UnsubmittedAttempt(string Player, double StartedAt, double EndedAt, string? BeatmapName, string? Session = null);

/// <summary>A session's log files: the runtime log, the network log if there is one, and when the runtime log last changed.</summary>
internal sealed record LogSessionFiles(string Id, string Runtime, string? Network, double ModifiedAt);

/// <summary>
/// Reader for osu!lazer's own log files: src/clients/lazer-log.ts. Every pattern fails closed: an
/// unrecognised line is ignored, and something is only reported when the game said so in as many
/// words. Timestamps in the logs are UTC.
/// </summary>
internal static partial class LazerLog
{
    [GeneratedRegex(@"\A([0-9]{4})-([0-9]{2})-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) \[[a-z]+\]: ([^\n\r\u2028\u2029]*)\z")]
    internal static partial Regex Line();

    [GeneratedRegex(@"\AGame-wide working beatmap updated to (.+)\z")]
    internal static partial Regex Beatmap();

    [GeneratedRegex(@"\AScore submission token retrieved \(([0-9]+)\)\z")]
    internal static partial Regex Token();

    [GeneratedRegex(@"\AScore submission completed! \(token:([0-9]+) id:([0-9]+)\)\z")]
    internal static partial Regex Submitted();

    [GeneratedRegex(@"suspended [A-Za-z0-9_]*Player#[0-9]+ \(waiting on [A-Za-z0-9_]*ResultsScreen#")]
    internal static partial Regex ReachedResults();

    [GeneratedRegex(@"exit from [A-Za-z0-9_]*Player#[0-9]+")]
    internal static partial Regex LeftGameplay();

    [GeneratedRegex(@"Request to https://osu\.ppy\.sh/api/v2/beatmaps/([0-9]+)/solo/scores/([0-9]+) successfully completed")]
    private static partial Regex SubmissionUrl();

    [GeneratedRegex(@" entered SoloPlayer#([0-9]+)")]
    internal static partial Regex EnteredSolo();

    [GeneratedRegex(@" exit from SoloPlayer#([0-9]+)")]
    internal static partial Regex LeftSolo();

    [GeneratedRegex(@" suspended SoloPlayer#([0-9]+) \(waiting on [A-Za-z0-9_]*ResultsScreen#")]
    internal static partial Regex SoloReachedResults();

    [GeneratedRegex(@"\ANo token, skipping score submission\z")]
    internal static partial Regex NoToken();

    [GeneratedRegex(@"\A([0-9]+)\.runtime\.log\z")]
    private static partial Regex RuntimeLog();

    [GeneratedRegex("\r?\n")]
    internal static partial Regex NewLine();

    /// <summary>For batch reads: every counted play and every unsubmitted attempt in a session.</summary>
    public static (List<LoggedPlay> Plays, List<UnsubmittedAttempt> Attempts) ParseSessionEvents(string runtime)
    {
        var session = new LogSession();
        var (plays, attempts) = session.FeedEvents(NewLine().Split(runtime));
        return ([.. plays, .. session.Flush()], attempts);
    }

    /// <summary>Token to beatmap id, from the submission requests in a <c>.network.log</c>.</summary>
    public static Dictionary<string, double> ParseSubmissionBeatmaps(string text)
    {
        var output = new Dictionary<string, double>(StringComparer.Ordinal);
        foreach (var line in NewLine().Split(text))
        {
            var m = SubmissionUrl().Match(line);
            if (m.Success) output[m.Groups[2].Value] = Js.StringToNumber(m.Groups[1].Value);
        }
        return output;
    }

    /// <summary>lazer keeps its logs beside its file store. osu!stable has no equivalent.</summary>
    public static string? LogDirOf(OsuInstall install) => install.Kind == "lazer" ? NodePath.Join(install.Root, "logs") : null;

    /// <summary>
    /// The session log files in a directory, newest last: ordered by the session's name, when it
    /// started, which never changes where a modification time can.
    /// </summary>
    public static List<LogSessionFiles> ListLogSessions(string dir)
    {
        string[] names;
        try
        {
            names = [.. Directory.EnumerateFileSystemEntries(dir).Select(p => Path.GetFileName(p))];
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException)
        {
            return [];
        }
        var output = new List<LogSessionFiles>();
        foreach (var name in names)
        {
            var m = RuntimeLog().Match(name);
            if (!m.Success) continue;
            var runtime = NodePath.Join(dir, name);
            double modifiedAt;
            try
            {
                FileSystemInfo info = File.Exists(runtime) ? new FileInfo(runtime) : new DirectoryInfo(runtime);
                if (!info.Exists) continue;
                modifiedAt = (info.LastWriteTimeUtc - DateTime.UnixEpoch).TotalMilliseconds;
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                continue;
            }
            var network = NodePath.Join(dir, $"{m.Groups[1].Value}.network.log");
            output.Add(new LogSessionFiles(m.Groups[1].Value, runtime, File.Exists(network) || Directory.Exists(network) ? network : null, modifiedAt));
        }
        return [.. output.OrderBy(s => Js.StringToNumber(s.Id))];
    }

    /// <summary>A log line's timestamp, UTC, as <c>Date.UTC</c> reads its fields.</summary>
    internal static double Timestamp(Match m)
    {
        double F(int group) => Js.StringToNumber(m.Groups[group].Value);
        return Js.DateUtc(F(1), F(2) - 1, F(3), F(4), F(5), F(6));
    }
}

/// <summary>
/// The log read one line at a time, so tailing a live log and reading whole files share one code
/// path: a play's start, its submission and its outcome can be hundreds of lines apart.
/// </summary>
internal sealed class LogSession
{
    /// <summary>How late a <c>No token</c> line may still belong to the screen that just closed.</summary>
    private const double LateNoTokenMs = 5_000;

    /// <summary>A gameplay screen entered this recently cannot be the one a <c>No token</c> line is about.</summary>
    private const double JustEnteredMs = 1_000;

    private sealed class OpenPlay
    {
        public required string Token;
        public double? StartedAt;
        public string? BeatmapName;
        public double? CountedAt;
        public string? OnlineScoreId;
        public bool? Outcome;
        public bool Reported;
    }

    private sealed class OpenScreen
    {
        public required string Player;
        public double EnteredAt;
        public string? BeatmapName;
        public bool HadToken;
        public bool NoToken;
        public bool Passed;
        public double? EndedAt;
        public bool Reported;
    }

    private string? beatmap;
    private OpenPlay? current;
    private OpenScreen? screen;
    private OpenScreen? lastScreen;
    private bool tokenPending;

    /// <summary>Lines from the log, in order. Returns the plays that finished within them.</summary>
    public List<LoggedPlay> Feed(IEnumerable<string> lines) => FeedEvents(lines).Plays;

    /// <summary>Lines from the log, in order: the plays osu! counted, and the attempts it could not submit.</summary>
    public (List<LoggedPlay> Plays, List<UnsubmittedAttempt> Attempts) FeedEvents(IEnumerable<string> lines)
    {
        var plays = new List<LoggedPlay>();
        var attempts = new List<UnsubmittedAttempt>();
        foreach (var line in lines) Line(line, plays, attempts);
        return (plays, attempts);
    }

    /// <summary>Solo gameplay screens, followed independently of the submissions, for attempts with no token.</summary>
    private void TrackScreen(double at, string body, List<UnsubmittedAttempt> attempts)
    {
        if (LazerLog.Token().IsMatch(body))
        {
            tokenPending = true;
            return;
        }

        var entered = LazerLog.EnteredSolo().Match(body);
        if (entered.Success)
        {
            // A screen still open here missed its exit line; it is dropped unreported rather than guessed at.
            screen = new OpenScreen { Player = entered.Groups[1].Value, EnteredAt = at, BeatmapName = beatmap, HadToken = tokenPending };
            tokenPending = false;
            return;
        }

        if (LazerLog.NoToken().IsMatch(body))
        {
            var open = screen;
            var last = lastScreen;
            var lateForLast = last is not null && !last.NoToken && !last.HadToken && last.EndedAt is { } ended
                && at - ended <= LateNoTokenMs && (open is null || at - open.EnteredAt <= JustEnteredMs);
            if (lateForLast)
            {
                last!.NoToken = true;
                ReportAttempt(last, attempts);
            }
            else if (open is not null)
            {
                open.NoToken = true;
            }
            return;
        }

        var results = LazerLog.SoloReachedResults().Match(body);
        if (results.Success)
        {
            if (screen is not null && screen.Player == results.Groups[1].Value) screen.Passed = true;
            return;
        }

        var left = LazerLog.LeftSolo().Match(body);
        if (left.Success && screen is not null && screen.Player == left.Groups[1].Value)
        {
            screen.EndedAt = at;
            ReportAttempt(screen, attempts);
            lastScreen = screen;
            screen = null;
        }
    }

    private static void ReportAttempt(OpenScreen s, List<UnsubmittedAttempt> attempts)
    {
        // Only a screen osu! said had no token, that did not reach results, and that has closed.
        if (s.Reported || !s.NoToken || s.Passed || s.EndedAt is not { } ended) return;
        s.Reported = true;
        attempts.Add(new UnsubmittedAttempt(s.Player, s.EnteredAt, ended, s.BeatmapName));
    }

    private void Line(string line, List<LoggedPlay> output, List<UnsubmittedAttempt> attempts)
    {
        var parsed = LazerLog.Line().Match(line);
        if (!parsed.Success) return;
        var at = LazerLog.Timestamp(parsed);
        var body = parsed.Groups[7].Value;

        TrackScreen(at, body, attempts);

        var map = LazerLog.Beatmap().Match(body);
        if (map.Success)
        {
            beatmap = Js.Trim(map.Groups[1].Value);
            return;
        }

        var token = LazerLog.Token().Match(body);
        if (token.Success)
        {
            // A play starting while another is open means its ending was missed: report what is known.
            Close(output);
            current = new OpenPlay { Token = token.Groups[1].Value, StartedAt = at, BeatmapName = beatmap };
            return;
        }

        var submitted = LazerLog.Submitted().Match(body);
        if (submitted.Success)
        {
            if (current is null || current.Token != submitted.Groups[1].Value)
            {
                // Joined mid-play: the submission alone says osu! counted it.
                Close(output);
                current = new OpenPlay { Token = submitted.Groups[1].Value, StartedAt = null, BeatmapName = beatmap };
            }
            current.CountedAt = at;
            current.OnlineScoreId = submitted.Groups[2].Value;
            if (current.Outcome is { } outcome) Report(output, outcome);
            return;
        }

        if (current is null) return;

        if (LazerLog.ReachedResults().IsMatch(body))
        {
            current.Outcome = true;
            if (current.CountedAt is not null) Report(output, true);
            return;
        }

        if (LazerLog.LeftGameplay().IsMatch(body))
        {
            // A pass already settled stays one: leaving the results screen exits the Player too.
            current.Outcome ??= false;
            if (current.CountedAt is not null) Report(output, false);
        }
    }

    private void Close(List<LoggedPlay> output)
    {
        Report(output, current?.Outcome ?? false);
        current = null;
    }

    private void Report(List<LoggedPlay> output, bool passed)
    {
        var play = current;
        // Only a play osu! itself accepted is a play.
        if (play is null || play.Reported || play.CountedAt is not { } counted || play.OnlineScoreId is null) return;
        play.Reported = true;
        output.Add(new LoggedPlay(play.Token, play.StartedAt, counted, play.OnlineScoreId, play.BeatmapName, passed));
    }

    /// <summary>Report a play still open at the end of a finished session's file. Never for a live log.</summary>
    public List<LoggedPlay> Flush()
    {
        var output = new List<LoggedPlay>();
        Close(output);
        return output;
    }
}
