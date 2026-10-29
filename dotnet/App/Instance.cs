using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace OsuLocalProfiles;

/// <summary>
/// One copy of the app at a time, and a way for whatever started it to stop it: src/instance.ts.
/// A second start finds the first by asking the port, the thing the two would fight over, and
/// opens its page instead.
/// </summary>
internal static class Instance
{
    /// <summary>What the tray launcher sets (LAUNCHER_ENV in src/update/index.ts).</summary>
    public const string LauncherEnv = "OSU_LOCAL_PROFILES_LAUNCHER";

    /// <summary>What the launcher sets when the computer started it as the user signed in (STARTUP_ENV).</summary>
    public const string StartupEnv = "OSU_LOCAL_PROFILES_STARTUP";

    /// <summary>The tray launcher started this process: it has no console, and stops when the launcher does.</summary>
    public static bool LaunchedFromTray(Func<string, string?> getenv) => getenv(LauncherEnv) == "tray";

    /// <summary>The tray launcher or <c>start.sh</c>'s loop will start this process again after an update.</summary>
    public static bool LauncherRestarts(Func<string, string?> getenv) => getenv(LauncherEnv) is "restarts" or "tray";

    /// <summary>Started by the computer as the user signed in: nobody is there to see a page.</summary>
    public static bool StartedWithComputer(Func<string, string?> getenv) => getenv(StartupEnv) == "1";

    /// <summary>
    /// The version of this app answering on <paramref name="port"/>, or null when nothing does, or
    /// something else does. Never throws: a refused connection is the ordinary answer.
    /// </summary>
    public static async Task<(bool Running, string? Version)> RunningInstance(int port, TimeSpan? timeout = null)
    {
        try
        {
            using var client = new HttpClient { Timeout = timeout ?? TimeSpan.FromMilliseconds(1500) };
            using var response = await client.GetAsync($"http://localhost:{port}/api/app");
            if (!response.IsSuccessStatusCode) return (false, null);
            using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            if (Js.Get(doc.RootElement, "app") is not { ValueKind: JsonValueKind.String } app || app.GetString() != Http.Server.AppId)
            {
                return (false, null);
            }
            return (true, Js.IsString(Js.Get(doc.RootElement, "version"), out var version) ? version : null);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or JsonException)
        {
            return (false, null);
        }
    }

    /// <summary>
    /// Stop when the tray launcher goes away. The launcher holds the write end of this process's
    /// stdin; closing it is how Quit in the tray asks the app to stop, and the system closes it
    /// too when the launcher dies for any other reason, so the app never outlives its icon.
    /// </summary>
    /// <remarks>
    /// <c>deliberate</c> tells the two apart: Quit writes <c>{"quit":true}</c> first, and only a
    /// deliberate stop installs an update waiting for it. Every other line (a JSON object or
    /// array) goes to <paramref name="onMessage"/>; anything unreadable is ignored, and a line
    /// that grows past 64 KiB without ending is thrown away, as the TypeScript does.
    /// </remarks>
    public static Task StopWhenLauncherCloses(Stream stdin, Action<bool> stop, Action<JsonElement>? onMessage = null) =>
        Task.Run(() =>
        {
            var deliberate = false;
            var pending = new StringBuilder();
            var buffer = new char[4096];
            using var reader = new StreamReader(stdin, new UTF8Encoding(false));
            try
            {
                int read;
                while ((read = reader.Read(buffer, 0, buffer.Length)) > 0)
                {
                    pending.Append(buffer, 0, read);
                    var text = pending.ToString();
                    var lines = text.Split('\n');
                    pending.Clear().Append(lines[^1]);
                    if (pending.Length > 65_536) pending.Clear();
                    foreach (var line in lines[..^1])
                    {
                        if (!JsonText.TryParse(line, out var message)) continue;
                        if (message.ValueKind is not (JsonValueKind.Object or JsonValueKind.Array)) continue;
                        if (Js.Get(message, "quit") is { ValueKind: JsonValueKind.True }) deliberate = true;
                        onMessage?.Invoke(message);
                    }
                }
            }
            catch (IOException)
            {
                /* the pipe broke: the launcher is gone either way */
            }
            stop(deliberate);
        });
}

/// <summary>Opening the page in the default browser: src/browser.ts.</summary>
internal static class Browser
{
    /// <summary>
    /// The command that opens <paramref name="url"/>, by platform. Windows goes through
    /// <c>cmd</c>'s <c>start</c> with the line passed as written: <c>start "" &lt;url&gt;</c>, with
    /// <c>&amp;</c> and <c>^</c> escaped so a query string can never be read as a second command.
    /// </summary>
    public static (string Command, string Arguments) Command(string platform, string url)
    {
        if (platform == "win32")
        {
            var safe = url.Replace("^", "^^").Replace("&", "^&");
            return ("cmd", $"/c start \"\" {safe}");
        }
        return (platform == "darwin" ? "open" : "xdg-open", url);
    }

    public static string Platform =>
        OperatingSystem.IsWindows() ? "win32" : OperatingSystem.IsMacOS() ? "darwin" : "linux";

    /// <summary>
    /// Opening a folder in the system's file manager: Explorer, Finder, or whatever <c>xdg-open</c>
    /// hands a directory to. Not through <c>cmd</c>: <c>explorer.exe</c> takes the path as its one
    /// argument. Best effort, as the page shows the path as well.
    /// </summary>
    public static void OpenFolder(string dir)
    {
        var command = Platform switch { "win32" => "explorer.exe", "darwin" => "open", _ => "xdg-open" };
        try
        {
            var start = new ProcessStartInfo(command) { UseShellExecute = false, CreateNoWindow = true };
            start.ArgumentList.Add(dir);
            using var process = Process.Start(start);
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            /* no file manager to hand it to; the path is on the page */
        }
    }

    /// <summary>Best effort: the URL is printed in the console as well.</summary>
    public static void Open(string url)
    {
        var (command, arguments) = Command(Platform, url);
        try
        {
            using var process = Process.Start(new ProcessStartInfo(command)
            {
                Arguments = arguments,
                UseShellExecute = false,
                CreateNoWindow = true,
            });
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            /* no browser opener on this system; the printed URL still works */
        }
    }
}
