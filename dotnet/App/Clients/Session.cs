using System.Text.RegularExpressions;

namespace OsuLocalProfiles.Clients;

/// <summary>Who osu! is signed in as on this machine, from one client's own config.</summary>
internal sealed record LocalSession(string Client, string Username);

/// <summary>
/// The username osu! is signed in as, read from the client's own config file: src/clients/session.ts.
/// Read-only and best effort; anything missing or unreadable is nothing to suggest.
/// </summary>
internal static partial class Session
{
    /// <summary>
    /// <c>^\s*key\s*=\s*(.*)$</c>, ignoring case, on one line: the first such line's value, trimmed,
    /// or null when it is empty or there is none. Both clients write <c>Key = Value</c> per line.
    /// </summary>
    public static string? ReadIniValue(string file, string key)
    {
        string text;
        try
        {
            text = Js.ReadFileUtf8(file);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
        foreach (var line in Regex.Split(text, "\r?\n"))
        {
            if (ValueOf(line, key) is not { } value) continue;
            var trimmed = Js.Trim(value);
            return trimmed.Length > 0 ? trimmed : null;
        }
        return null;
    }

    /// <summary>The line's value for the key, or null when it does not match.</summary>
    private static string? ValueOf(string line, string key)
    {
        var i = 0;
        while (i < line.Length && Js.IsSpace(line[i])) i++;
        if (line.Length - i < key.Length) return null;
        for (var k = 0; k < key.Length; k++, i++)
        {
            // JavaScript's `i` flag without `u` never folds a character past ASCII into one inside it.
            if (char.ToLowerInvariant(line[i]) != char.ToLowerInvariant(key[k]) || line[i] > 127) return null;
        }
        while (i < line.Length && Js.IsSpace(line[i])) i++;
        if (i >= line.Length || line[i] != '=') return null;
        i++;
        // `\s*` takes every space it can, a line terminator among them; after that `.` stops at
        // one, and `$` then refuses the line.
        while (i < line.Length && Js.IsSpace(line[i])) i++;
        var rest = line[i..];
        return rest.Any(c => c is '\r' or '\n' || c == (char)0x2028 || c == (char)0x2029) ? null : rest;
    }

    [GeneratedRegex(@"\Aosu!\.[^\n\r]+\.cfg\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex StableConfig();

    public static List<LocalSession> DetectLocalSessions(IEnumerable<OsuInstall> installs)
    {
        var found = new List<LocalSession>();
        foreach (var install in installs)
        {
            if (install.Kind == "lazer")
            {
                // The development client writes game.dev.ini and signs in to the development server.
                var username = (install.Development ? ReadIniValue(NodePath.Join(install.Root, "game.dev.ini"), "Username") : null)
                    ?? ReadIniValue(NodePath.Join(install.Root, "game.ini"), "Username");
                if (!string.IsNullOrEmpty(username)) found.Add(new LocalSession("lazer", username));
                continue;
            }

            // stable names the file after the Windows user, so match the pattern instead of guessing.
            string[] entries;
            try
            {
                entries = [.. Directory.EnumerateFileSystemEntries(install.Root).Select(Path.GetFileName).Select(n => n!)];
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException)
            {
                continue;
            }
            foreach (var entry in entries)
            {
                if (!StableConfig().IsMatch(entry)) continue;
                var username = ReadIniValue(NodePath.Join(install.Root, entry), "Username");
                if (!string.IsNullOrEmpty(username))
                {
                    found.Add(new LocalSession("stable", username));
                    break;
                }
            }
        }
        return found;
    }
}
