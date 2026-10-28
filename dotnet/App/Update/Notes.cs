using System.Text.Json;
using System.Text.RegularExpressions;
using OsuLocalProfiles.Db;

namespace OsuLocalProfiles.Update;

/// <summary>One release's notes, as the page shows them before and after an update.</summary>
internal sealed record VersionNotes(string Version, string? Date, bool Important, List<string> Highlights);

/// <summary>
/// Versions, release notes and what's new: src/update/github.ts's <c>compareVersions</c>,
/// src/update/notes.ts and src/update/whats-new.ts. The checking and installing are phase 5.
/// </summary>
internal static partial class Notes
{
    public const string ChangelogUrl = "https://github.com/jonathant09/osu-local-profiles/blob/main/CHANGELOG.md";
    private const int MaxLine = 200;
    private const int MaxLines = 30;
    private const string SeenKey = "lastSeenVersion";
    private const string DismissedKey = "updateNudgeDismissed";

    private static (List<double> Numbers, string Pre) Parts(string version)
    {
        var text = version.StartsWith('v') ? version[1..] : version;
        var dash = text.IndexOf('-');
        var main = dash < 0 ? text : text[..dash];
        var pre = dash < 0 ? "" : text[(dash + 1)..];
        // split('-', 2) keeps only what is before a second dash.
        var second = pre.IndexOf('-');
        if (second >= 0) pre = pre[..second];
        return ([.. main.Split('.').Select(ParseIntOrZero)], pre);
    }

    /// <summary><c>Number.parseInt(n, 10) || 0</c>: leading digits, else 0.</summary>
    private static double ParseIntOrZero(string text)
    {
        var s = Js.Trim(text);
        var i = 0;
        var negative = false;
        if (i < s.Length && s[i] is '+' or '-') negative = s[i++] == '-';
        var start = i;
        while (i < s.Length && char.IsAsciiDigit(s[i])) i++;
        if (i == start) return 0;
        var value = double.Parse(s[start..i], System.Globalization.CultureInfo.InvariantCulture);
        return negative ? -value : value;
    }

    /// <summary>-1 if <paramref name="a"/> is older, 1 if newer, 0 if the same; a pre-release sorts below its release.</summary>
    public static int CompareVersions(string a, string b)
    {
        var left = Parts(a);
        var right = Parts(b);
        for (var i = 0; i < Math.Max(left.Numbers.Count, right.Numbers.Count); i++)
        {
            var l = i < left.Numbers.Count ? left.Numbers[i] : 0;
            var r = i < right.Numbers.Count ? right.Numbers[i] : 0;
            if (l != r) return l < r ? -1 : 1;
        }
        if (left.Pre == right.Pre) return 0;
        if (left.Pre.Length == 0) return 1;
        if (right.Pre.Length == 0) return -1;
        return string.CompareOrdinal(left.Pre, right.Pre) < 0 ? -1 : 1;
    }

    [GeneratedRegex(@"^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9_.]+)?\z")]
    private static partial Regex VersionPattern();

    [GeneratedRegex(@"^[0-9]{4}-[0-9]{2}-[0-9]{2}\z")]
    private static partial Regex DatePattern();

    /// <summary>Release notes as a package's <c>release-notes.json</c> holds them, anything malformed left out.</summary>
    public static List<VersionNotes> ParseNotes(JsonElement? raw)
    {
        if (Js.Get(raw, "versions") is not { ValueKind: JsonValueKind.Array } versions) return [];
        var output = new List<VersionNotes>();
        foreach (var n in versions.EnumerateArray())
        {
            if (!Js.IsString(Js.Get(n, "version"), out var version) || !VersionPattern().IsMatch(version)) continue;
            var date = Js.IsString(Js.Get(n, "date"), out var d) && DatePattern().IsMatch(d) ? d : null;
            var highlights = Js.Get(n, "highlights") is { ValueKind: JsonValueKind.Array } list
                ? list.EnumerateArray().Where(h => h.ValueKind == JsonValueKind.String && Js.Trim(h.GetString()!).Length > 0)
                    .Take(MaxLines).Select(h => h.GetString()!).Select(h => h.Length > MaxLine ? $"{h[..MaxLine]}..." : h).ToList()
                : [];
            output.Add(new VersionNotes(version, date, Js.Get(n, "important") is { ValueKind: JsonValueKind.True }, highlights));
        }
        return output;
    }

    /// <summary>The versions after <paramref name="from"/> up to <paramref name="to"/>, newest first.</summary>
    public static List<VersionNotes> Between(List<VersionNotes> all, string? from, string to) =>
        [.. all.Where(n => CompareVersions(n.Version, to) <= 0 && (from is null ? n.Version == to : CompareVersions(n.Version, from) > 0))
            .OrderBy(n => n, Comparer<VersionNotes>.Create((a, b) => CompareVersions(b.Version, a.Version)))];

    /// <summary>The notes a package carries for itself and the versions before it.</summary>
    public static List<VersionNotes> Local(string installDir)
    {
        try
        {
            return JsonText.TryParse(Js.ReadFileUtf8(Path.Combine(installDir, "release-notes.json")), out var parsed) ? ParseNotes(parsed) : [];
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return [];
        }
    }

    [GeneratedRegex(@"^OK: updated to (\S+)")]
    private static partial Regex UpdatedTo();

    /// <summary>The version <c>data/update.log</c> says the last update installed, if it succeeded.</summary>
    public static string? UpdatedToFromLog(string dataDir)
    {
        try
        {
            var first = Js.ReadFileUtf8(Path.Combine(dataDir, "update.log")).Split('\n')[0];
            var m = UpdatedTo().Match(first);
            return m.Success ? m.Groups[1].Value : null;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    private static string? Read(Database db, string key) => db.Get("SELECT value FROM kv WHERE key = ?", r => r.GetString(0), key);

    /// <summary>What this version brought since the last one this install ran, until it has been seen.</summary>
    public static object? WhatsNew(Database db, string? current, string installDir, string dataDir)
    {
        if (current is null) return null;
        var seen = Read(db, SeenKey);
        if (seen is not null && CompareVersions(seen, current) >= 0) return null;
        if (seen is null && UpdatedToFromLog(dataDir) != current) return null;
        return new { from = seen, to = current, notes = Between(Local(installDir), seen, current) };
    }

    /// <summary>When the "you are behind" notice was last put away, and on which version.</summary>
    public static (string Version, double At)? NudgeDismissal(Database db)
    {
        if (!JsonText.TryParse(Read(db, DismissedKey) ?? "null", out var d)) return null;
        return Js.Get(d, "version") is { ValueKind: JsonValueKind.String } v && Js.Get(d, "at") is { ValueKind: JsonValueKind.Number } at
            ? (v.GetString()!, Js.NumberOf(at))
            : null;
    }

    private const double QuietDays = 7;

    /// <summary>Whether the notice above the page shows, given what dismissed it last.</summary>
    public static bool NudgeShown(string? nudge, List<VersionNotes> missing, (string Version, double At)? dismissed, double now)
    {
        if (nudge is null) return false;
        if (dismissed is not { } d) return true;
        var importantSince = missing.Any(n => n.Important && CompareVersions(n.Version, d.Version) > 0);
        return importantSince || now - d.At >= QuietDays * 86_400_000;
    }
}
