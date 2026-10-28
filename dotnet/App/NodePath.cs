using System.Text;
using System.Text.RegularExpressions;

namespace OsuLocalProfiles;

/// <summary>
/// Node's <c>path</c> functions for this platform, where the app compares or stores a path it built:
/// <c>path.join</c> normalises separators, <c>.</c> and <c>..</c>, which <see cref="Path.Combine(string[])"/>
/// does not, so a joined path would otherwise read differently from the Node app's.
/// </summary>
internal static partial class NodePath
{
    private static readonly char Sep = Path.DirectorySeparatorChar;

    /// <summary><c>path.join(...parts)</c>: the non-empty parts joined, then normalised.</summary>
    public static string Join(params string[] parts)
    {
        var joined = string.Join(Sep, parts.Where(p => p.Length > 0));
        return joined.Length == 0 ? "." : Normalize(joined);
    }

    /// <summary><c>path.resolve(p)</c>: absolute against the working directory, normalised.</summary>
    public static string Resolve(string p) => Normalize(Path.IsPathRooted(p) && !IsDriveRelative(p) ? p : Path.GetFullPath(p));

    private static bool IsDriveRelative(string p) => OperatingSystem.IsWindows() && p.Length >= 2 && p[1] == ':' && (p.Length == 2 || p[2] is not ('\\' or '/'));

    /// <summary><c>path.isAbsolute(p)</c>.</summary>
    public static bool IsAbsolute(string p) =>
        OperatingSystem.IsWindows() ? p.Length > 0 && (p[0] is '\\' or '/' || (p.Length >= 3 && p[1] == ':' && p[2] is '\\' or '/')) : p.StartsWith('/');

    /// <summary><c>path.normalize</c>: one separator between parts, <c>.</c> gone, <c>..</c> applied.</summary>
    public static string Normalize(string p)
    {
        if (OperatingSystem.IsWindows()) p = p.Replace('/', '\\');
        var prefix = "";
        var rest = p;
        if (OperatingSystem.IsWindows())
        {
            if (rest.Length >= 2 && rest[1] == ':')
            {
                prefix = rest[..2];
                rest = rest[2..];
            }
            if (rest.StartsWith(@"\\", StringComparison.Ordinal) && prefix.Length == 0)
            {
                // A UNC path keeps its leading pair.
                prefix = @"\";
                rest = rest[1..];
            }
        }
        var absolute = rest.Length > 0 && rest[0] == Sep;
        var segments = new List<string>();
        foreach (var segment in rest.Split(Sep))
        {
            if (segment.Length == 0 || segment == ".") continue;
            if (segment == "..")
            {
                if (segments.Count > 0 && segments[^1] != "..") segments.RemoveAt(segments.Count - 1);
                else if (!absolute) segments.Add("..");
                continue;
            }
            segments.Add(segment);
        }
        var body = string.Join(Sep, segments);
        var trailing = rest.Length > 1 && rest[^1] == Sep && body.Length > 0 ? Sep.ToString() : "";
        var result = prefix + (absolute ? Sep.ToString() : "") + body + trailing;
        return result.Length == 0 ? "." : result;
    }

    /// <summary><c>path.dirname(p)</c>.</summary>
    public static string Dirname(string p)
    {
        var i = p.LastIndexOfAny(OperatingSystem.IsWindows() ? ['\\', '/'] : ['/']);
        if (i < 0) return ".";
        if (i == 0) return p[..1];
        if (OperatingSystem.IsWindows() && i == 2 && p[1] == ':') return p[..3];
        return p[..i];
    }

    /// <summary><c>path.basename(p)</c>.</summary>
    public static string Basename(string p)
    {
        var trimmed = p.TrimEnd(OperatingSystem.IsWindows() ? ['\\', '/'] : ['/']);
        var i = trimmed.LastIndexOfAny(OperatingSystem.IsWindows() ? ['\\', '/'] : ['/']);
        return i < 0 ? trimmed : trimmed[(i + 1)..];
    }

    /// <summary>
    /// The lines of a file as JavaScript's multiline <c>^</c> and <c>$</c> see them: split at every
    /// line terminator it knows (CR, LF, CRLF, U+2028, U+2029), which .NET's multiline mode does not.
    /// </summary>
    public static IEnumerable<string> JsLines(string text) => LineBreak().Split(text);

    [GeneratedRegex(@"\r\n|\r|\n|\u2028|\u2029")]
    private static partial Regex LineBreak();

    /// <summary>The first line matching <paramref name="line"/>, its first group, as <c>/^...$/m.exec(text)?.[1]</c>.</summary>
    public static string? FirstMatch(string text, Regex line)
    {
        foreach (var l in JsLines(text))
        {
            var m = line.Match(l);
            if (m.Success) return m.Groups[1].Value;
        }
        return null;
    }

    public static string Utf8Lossless(byte[] bytes) => new UTF8Encoding(false).GetString(bytes);
}
