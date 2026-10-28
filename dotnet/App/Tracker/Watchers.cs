using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;
using OsuLocalProfiles.Clients;
using OsuLocalProfiles.Db;
using OsuLocalProfiles.Replays;

namespace OsuLocalProfiles.Tracker;

/// <summary>
/// Watching osu!'s folders: src/tracker/watcher.ts, songs-watcher.ts, log-watcher.ts and
/// mcosu-watcher.ts. Each debounces the bursts of events one write makes, and hands on what
/// settled; what to do with it is the tracker's.
/// </summary>
internal static partial class Watch
{
    /// <summary>
    /// The directory to watch, resolved through symlinks, junctions and 8.3 names, as
    /// <c>realpathSync.native</c> resolves it. The Node app had to: libuv aborts the process when the
    /// watched path is not the canonical one. The rule stays, so every spelling of a folder is one.
    /// Falls back to the path as given, whose failure to watch is then reportable.
    /// </summary>
    public static string WatchablePath(string dir)
    {
        try
        {
            return (OperatingSystem.IsWindows() ? FinalPathWindows(dir) : RealPathUnix(dir)) ?? dir;
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            return dir;
        }
    }

    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern SafeFileHandle CreateFile(string name, uint access, uint share, nint security, uint creation, uint flags, nint template);

    [DllImport("kernel32.dll", EntryPoint = "GetFinalPathNameByHandleW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, [Out] char[] buffer, uint size, uint flags);

    [DllImport("libc", EntryPoint = "realpath")]
    private static extern nint RealPath([MarshalAs(UnmanagedType.LPUTF8Str)] string path, nint resolved);

    [DllImport("libc", EntryPoint = "free")]
    private static extern void Free(nint pointer);

    private static string? FinalPathWindows(string dir)
    {
        const uint ShareAll = 0x1 | 0x2 | 0x4, OpenExisting = 3, BackupSemantics = 0x02000000;
        using var handle = CreateFile(Path.GetFullPath(dir), 0, ShareAll, 0, OpenExisting, BackupSemantics, 0);
        if (handle.IsInvalid) return null;
        var buffer = new char[32768];
        var length = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Length, 0);
        if (length == 0 || length >= buffer.Length) return null;
        var path = new string(buffer, 0, (int)length);
        // As libuv strips them: \\?\UNC\server\share is \\server\share, \\?\C:\x is C:\x.
        if (path.StartsWith(@"\\?\UNC\", StringComparison.Ordinal)) return @"\\" + path[8..];
        return path.StartsWith(@"\\?\", StringComparison.Ordinal) ? path[4..] : path;
    }

    private static string? RealPathUnix(string dir)
    {
        var resolved = RealPath(dir, 0);
        if (resolved == 0) return null;
        try
        {
            return Marshal.PtrToStringUTF8(resolved);
        }
        finally
        {
            Free(resolved);
        }
    }

    /// <summary>A watcher on a folder already resolved, reporting through one handler.</summary>
    public static FileSystemWatcher Start(string dir, bool recursive, Action<string> onName, Action<Exception>? onError)
    {
        var w = new FileSystemWatcher(WatchablePath(dir))
        {
            IncludeSubdirectories = recursive,
            InternalBufferSize = 64 * 1024,
            NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.CreationTime,
        };
        void Handle(object _, FileSystemEventArgs e)
        {
            if (!string.IsNullOrEmpty(e.Name)) onName(e.Name);
        }
        w.Created += Handle;
        w.Changed += Handle;
        w.Deleted += Handle;
        w.Renamed += (s, e) => Handle(s, e);
        w.Error += (_, e) => onError?.Invoke(e.GetException());
        w.EnableRaisingEvents = true;
        return w;
    }

    public static void Stop(List<FileSystemWatcher> watchers)
    {
        foreach (var w in watchers)
        {
            try
            {
                w.EnableRaisingEvents = false;
                w.Dispose();
            }
            catch (Exception e) when (e is not OutOfMemoryException)
            {
                /* ignore */
            }
        }
        watchers.Clear();
    }

    /// <summary>What <c>fs.statSync</c> says of a path: a file and its size, a folder, or nothing.</summary>
    public static (bool Exists, bool IsFile, long Size) Stat(string path)
    {
        try
        {
            var file = new FileInfo(path);
            if (file.Exists) return (true, true, file.Length);
            return (Directory.Exists(path), false, 0);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException)
        {
            return (false, false, 0);
        }
    }

    /// <summary>
    /// A watch failure worth reading: Linux's inotify limit reads as "no space left", and means
    /// nothing of the sort.
    /// </summary>
    public static string Explain(Exception e)
    {
        if (OperatingSystem.IsLinux() && e is IOException io && (io.HResult & 0xffff) == 28)
        {
            return $"{e.Message}\n  This is the inotify watch limit, not disk space: osu!lazer's file store is\n"
                + "  thousands of directories and Linux watches them one at a time. Raise it with:\n"
                + "    sudo sysctl fs.inotify.max_user_watches=524288\n"
                + "  (add it to /etc/sysctl.conf to keep it across reboots)";
        }
        return e.Message;
    }
}

/// <summary>
/// A timer per key, restarted by each event: a write is several events, and only the last one
/// counts. Callbacks run off the timer, one at a time, and outside any lock a caller holds.
/// </summary>
internal sealed class Debounce : IDisposable
{
    private readonly object gate = new();
    private readonly Dictionary<string, Timer> pending = new(StringComparer.Ordinal);

    public void Schedule(string key, TimeSpan delay, Action action)
    {
        lock (gate)
        {
            if (pending.Remove(key, out var old)) old.Dispose();
            Timer? timer = null;
            timer = new Timer(_ =>
            {
                lock (gate)
                {
                    if (!pending.TryGetValue(key, out var current) || current != timer) return;
                    pending.Remove(key);
                }
                timer!.Dispose();
                action();
            });
            pending[key] = timer;
            timer.Change(delay, Timeout.InfiniteTimeSpan);
        }
    }

    public bool Has(string key)
    {
        lock (gate) return pending.ContainsKey(key);
    }

    public void Cancel(string key)
    {
        lock (gate)
        {
            if (pending.Remove(key, out var old)) old.Dispose();
        }
    }

    public void Clear()
    {
        lock (gate)
        {
            foreach (var t in pending.Values) t.Dispose();
            pending.Clear();
        }
    }

    public void Dispose() => Clear();
}

/// <summary>
/// Watches osu!'s storage for newly written replays, recursively: lazer's store is one tree of
/// thousands of hash-named folders, so each settled file is told apart by its first bytes.
/// </summary>
internal sealed class ReplayWatcher(IReadOnlyList<string> dirs, Action<string> onReplay, Action<string>? onOtherFile = null, Action<Exception>? onError = null)
{
    /// <summary>How long a file's size must stay the same before its write counts as finished.</summary>
    private static readonly TimeSpan Settle = TimeSpan.FromMilliseconds(250);
    private const int SettleAttempts = 20;

    private readonly object gate = new();
    private readonly List<FileSystemWatcher> watchers = [];
    private readonly Debounce pending = new();
    private readonly HashSet<string> seen = new(StringComparer.Ordinal);
    private bool running;

    public void Start()
    {
        lock (gate)
        {
            if (running) return;
            running = true;
        }
        foreach (var dir in dirs)
        {
            if (!Directory.Exists(dir) && !File.Exists(dir)) continue;
            try
            {
                // Resolved for the watch, reported against the folder as configured.
                watchers.Add(Watch.Start(dir, true, name => Queue(NodePath.Join(dir, name)), onError));
            }
            catch (Exception e) when (e is not OutOfMemoryException)
            {
                onError?.Invoke(e);
            }
        }
    }

    public void Stop()
    {
        lock (gate) running = false;
        Watch.Stop(watchers);
        pending.Clear();
    }

    private void Queue(string file)
    {
        lock (gate)
        {
            if (seen.Contains(file)) return;
        }
        pending.Schedule(file, Settle, () => SettleFile(file, 0, -1));
    }

    /// <summary>Wait for the file's size to stop changing, so a half-written replay is never read.</summary>
    private void SettleFile(string file, int attempt, long lastSize)
    {
        lock (gate)
        {
            if (!running) return;
        }
        var (exists, isFile, size) = Watch.Stat(file);
        if (!exists || !isFile) return; // vanished, or a directory event

        if (size == 0 || size != lastSize)
        {
            if (attempt >= SettleAttempts) return;
            pending.Schedule(file, Settle, () => SettleFile(file, attempt + 1, size));
            return;
        }

        lock (gate)
        {
            if (!seen.Add(file)) return;
        }
        var head = Backfill.ReadHead(file, 8);
        if (head is not null && Osr.LooksLikeReplay(head)) onReplay(file);
        else onOtherFile?.Invoke(file);
    }

    /// <summary>Mark files as already processed, so a restart does not hand them on again.</summary>
    public void MarkSeen(IEnumerable<string> files)
    {
        lock (gate)
        {
            foreach (var f in files) seen.Add(f);
        }
    }
}

/// <summary>
/// Watches osu!stable's Songs folders for beatmaps, so a map downloaded mid-session is in the index
/// before its first play is resolved. Only the top level: a new set is a new folder there.
/// </summary>
internal sealed class SongsWatcher(Database db, IReadOnlyList<string> roots, Action<Exception>? onError = null)
{
    /// <summary>osu!stable extracts a set over a second or so; read it once it has stopped changing.</summary>
    private static readonly TimeSpan Settle = TimeSpan.FromMilliseconds(1500);

    /// <summary>How many recently touched entries a flush reads at most.</summary>
    private const int RecentLimit = 100;

    private readonly object gate = new();
    private readonly List<FileSystemWatcher> watchers = [];
    private readonly Debounce pending = new();
    private readonly List<string> recent = [];

    public void Start()
    {
        foreach (var root in roots)
        {
            if (!Directory.Exists(root) && !File.Exists(root)) continue;
            try
            {
                watchers.Add(Watch.Start(root, false, name => Touched(NodePath.Join(root, name)), onError));
            }
            catch (Exception e) when (e is not OutOfMemoryException)
            {
                onError?.Invoke(e);
            }
        }
    }

    public void Stop()
    {
        Watch.Stop(watchers);
        pending.Clear();
        lock (gate) recent.Clear();
    }

    /// <summary>Read everything touched lately now, without waiting: a play's beatmap may be among it.</summary>
    public void Flush()
    {
        pending.Clear();
        List<string> entries;
        lock (gate) entries = [.. recent];
        foreach (var entry in entries) Read(entry);
    }

    private void Touched(string entry)
    {
        lock (gate)
        {
            recent.Remove(entry);
            recent.Add(entry);
            if (recent.Count > RecentLimit) recent.RemoveAt(0);
        }
        pending.Schedule(entry, Settle, () => Read(entry));
    }

    private void Read(string entry)
    {
        var (exists, isFile, size) = Watch.Stat(entry);
        if (!exists) return; // gone again: a temporary file, or a set being replaced
        if (isFile)
        {
            if (IsOsu(entry)) Index(entry, size);
            return;
        }
        string[] names;
        try
        {
            names = [.. Directory.EnumerateFileSystemEntries(entry).Select(p => Path.GetFileName(p))];
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return;
        }
        foreach (var name in names)
        {
            if (!IsOsu(name)) continue;
            var file = NodePath.Join(entry, name);
            var stat = Watch.Stat(file);
            if (stat.Exists) Index(file, stat.Size);
        }
    }

    private void Index(string file, long size)
    {
        var known = db.FirstRow("SELECT size FROM osu_files WHERE path = ?", file);
        if (known?.Num("size") != size) Beatmaps.IndexOneFile(db, file);
    }

    private static bool IsOsu(string name) => Js.ToLower(name).EndsWith(".osu", StringComparison.Ordinal);
}

/// <summary>
/// Follows lazer's newest session log as it is written, handing on each play osu! counted and each
/// attempt it could not submit. Only what is written after the start: what is already in the log
/// is Import past plays' business.
/// </summary>
internal sealed partial class LogWatcher(IReadOnlyList<string> dirs, Action<List<LoggedPlay>> onPlays,
    Action<List<UnsubmittedAttempt>>? onAttempts = null, Action<Exception>? onError = null)
{
    private static readonly TimeSpan Settle = TimeSpan.FromMilliseconds(400);

    /// <summary>How much of the end of the network log to read for a submission's beatmap id.</summary>
    private const int NetworkTailBytes = 512 * 1024;

    private sealed class Followed
    {
        public required string Id;
        public required string Runtime;
        public string? Network;
        public long Offset;
        public string Partial = "";
        public LogSession Session = new();
    }

    private readonly object gate = new();
    private readonly List<FileSystemWatcher> watchers = [];
    private readonly Dictionary<string, Followed> followed = new(StringComparer.Ordinal);
    private readonly Debounce timers = new();
    private bool running;

    [GeneratedRegex(@"\A[0-9]+\.(runtime|network)\.log\z")]
    private static partial Regex LogName();

    public void Start()
    {
        lock (gate)
        {
            if (running) return;
            running = true;
        }
        foreach (var dir in dirs)
        {
            if (!Directory.Exists(dir) && !File.Exists(dir)) continue;
            var sessions = LazerLog.ListLogSessions(dir);
            if (sessions.Count > 0) lock (gate) Follow(dir, sessions[^1], Watch.Stat(sessions[^1].Runtime).Size);
            try
            {
                watchers.Add(Watch.Start(dir, false, name => Queue(dir, name), onError));
            }
            catch (Exception e) when (e is not OutOfMemoryException)
            {
                onError?.Invoke(e);
            }
        }
    }

    public void Stop()
    {
        lock (gate) running = false;
        Watch.Stop(watchers);
        timers.Clear();
        lock (gate) followed.Clear();
    }

    private void Follow(string dir, LogSessionFiles files, long offset) =>
        followed[dir] = new Followed { Id = files.Id, Runtime = files.Runtime, Network = files.Network, Offset = offset };

    private void Queue(string dir, string filename)
    {
        if (!LogName().IsMatch(NodePath.Basename(filename))) return;
        timers.Schedule(dir, Settle, () => Read(dir));
    }

    /// <summary>The bytes from <paramref name="offset"/> to the end, as text; a file that shrank starts again at 0.</summary>
    private static (string Text, long Next)? ReadFrom(string file, long offset)
    {
        try
        {
            using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            var size = stream.Length;
            if (size < offset) return ("", 0);
            if (size == offset) return ("", offset);
            var buf = new byte[size - offset];
            stream.Position = offset;
            var read = stream.ReadAtLeast(buf, buf.Length, throwOnEndOfStream: false);
            return (Encoding.UTF8.GetString(buf, 0, read), offset + read);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    private static string ReadTail(string file, int maxBytes)
    {
        try
        {
            using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            var from = Math.Max(0, stream.Length - maxBytes);
            var buf = new byte[stream.Length - from];
            stream.Position = from;
            var read = stream.ReadAtLeast(buf, buf.Length, throwOnEndOfStream: false);
            return Encoding.UTF8.GetString(buf, 0, read);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return "";
        }
    }

    private void Read(string dir)
    {
        List<LoggedPlay> plays;
        List<UnsubmittedAttempt> attempts;
        try
        {
            lock (gate)
            {
                if (!running) return;
                SwitchSessionIfNewer(dir);
                if (!followed.TryGetValue(dir, out var follow)) return;

                if (ReadFrom(follow.Runtime, follow.Offset) is not { } chunk) return;
                if (chunk.Next < follow.Offset)
                {
                    // Truncated or replaced: start again from the top, with nothing half-read.
                    follow.Offset = chunk.Next;
                    follow.Partial = "";
                    return;
                }
                follow.Offset = chunk.Next;
                if (chunk.Text.Length == 0) return;

                var lines = LazerLog.NewLine().Split(follow.Partial + chunk.Text).ToList();
                follow.Partial = lines[^1];
                lines.RemoveAt(lines.Count - 1);

                var events = follow.Session.FeedEvents(lines);
                plays = events.Plays.Count > 0 ? AttachBeatmaps(follow, events.Plays) : [];
                attempts = [.. events.Attempts.Select(a => a with { Session = follow.Id })];
            }
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            onError?.Invoke(e);
            return;
        }
        try
        {
            if (plays.Count > 0) onPlays(plays);
            if (attempts.Count > 0) onAttempts?.Invoke(attempts);
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            onError?.Invoke(e);
        }
    }

    /// <summary>lazer opened a new session: follow its log from the top.</summary>
    private void SwitchSessionIfNewer(string dir)
    {
        var sessions = LazerLog.ListLogSessions(dir);
        if (sessions.Count == 0) return;
        var latest = sessions[^1];
        if (followed.TryGetValue(dir, out var follow) && Js.StringToNumber(latest.Id) <= Js.StringToNumber(follow.Id)) return;
        Follow(dir, latest, 0);
    }

    /// <summary>The beatmap id each unfinished play was submitted against, from the network log's tail.</summary>
    private static List<LoggedPlay> AttachBeatmaps(Followed follow, List<LoggedPlay> plays)
    {
        var wanted = plays.Any(p => !p.Passed);
        var ids = wanted && follow.Network is not null ? LazerLog.ParseSubmissionBeatmaps(ReadTail(follow.Network, NetworkTailBytes)) : [];
        return [.. plays.Select(p => p with { BeatmapId = ids.TryGetValue(p.Token, out var id) ? id : null })];
    }
}

/// <summary>
/// McOsu plays from McOsu's <c>scores.db</c>, as replays the tracker can take: each entry the file
/// did not have before becomes a built replay under <c>data/mcosu/</c>, handed on like any other.
/// </summary>
internal sealed class McosuWatcher(string root, string dir, Action<string> onReplay, Action<Exception>? onError = null)
{
    /// <summary>McOsu writes the file in one go, but not atomically.</summary>
    private static readonly TimeSpan Settle = TimeSpan.FromMilliseconds(300);

    /// <summary>A read that finds the file cut short is a write in progress; try again, but not for ever.</summary>
    private const int ReadAttempts = 10;

    private readonly object gate = new();
    private readonly Dictionary<string, HashSet<string>> known = new(StringComparer.Ordinal);
    private readonly Debounce pending = new();
    private readonly List<FileSystemWatcher> watchers = [];
    private bool running;
    private bool reportedVersion;

    /// <summary>The scores databases McOsu keeps, whether or not they exist yet: its own, and its VR mode's.</summary>
    public static string[] ScoreFiles(string root) => [NodePath.Join(root, "scores.db"), NodePath.Join(root, "scoresvr.db")];

    private static string EntryKey(McosuScore s) => $"{s.BeatmapMD5}:{Js.NumberToString(s.PlayedAt)}";

    /// <summary>
    /// One McOsu scores file, waiting out a write in progress. An absent or empty file is no plays;
    /// a newer format than this app knows is thrown.
    /// </summary>
    public static async Task<List<McosuScore>> ReadScores(string file)
    {
        for (var attempt = 0; ; attempt++)
        {
            byte[] buf;
            try
            {
                buf = File.ReadAllBytes(file);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException)
            {
                return [];
            }
            if (buf.Length == 0) return [];
            try
            {
                return Mcosu.ParseScores(buf);
            }
            catch (Exception e) when (e is not McosuVersionException && attempt < ReadAttempts - 1 && e is not OutOfMemoryException)
            {
                await Task.Delay(Settle);
            }
        }
    }

    /// <summary>The built replay for one play, written if it is not there already.</summary>
    public static string BuildReplay(string dir, McosuScore score)
    {
        var file = Mcosu.BuiltReplayPath(dir, score.BeatmapMD5, score.PlayedAt);
        if (!File.Exists(file) && !Directory.Exists(file))
        {
            Directory.CreateDirectory(dir);
            File.WriteAllBytes(file, Mcosu.BuildReplay(score));
        }
        return file;
    }

    /// <summary>The replay for every McOsu play since <paramref name="since"/>, never for a stable score McOsu copied in.</summary>
    public static async Task<List<string>> BuildReplays(string root, string dir, double since)
    {
        var built = new List<string>();
        foreach (var file in ScoreFiles(root))
        {
            foreach (var score in await ReadScores(file))
            {
                if (score.ImportedLegacy || score.PlayedAt < since) continue;
                built.Add(BuildReplay(dir, score));
            }
        }
        return built;
    }

    /// <summary>Completes once the files have been read, so what is already there is never taken as new.</summary>
    public async Task Start()
    {
        lock (gate)
        {
            if (running) return;
            running = true;
        }
        foreach (var file in ScoreFiles(root))
        {
            var keys = new HashSet<string>(StringComparer.Ordinal);
            try
            {
                foreach (var score in await ReadScores(file)) keys.Add(EntryKey(score));
            }
            catch (Exception e) when (e is not OutOfMemoryException)
            {
                Report(e);
            }
            lock (gate) known[Js.ToLower(NodePath.Basename(file))] = keys;
        }
        lock (gate)
        {
            if (!running) return;
        }
        try
        {
            // The folder rather than the file: McOsu may not have created scores.db yet.
            watchers.Add(Watch.Start(root, false, name =>
            {
                var lower = Js.ToLower(name);
                bool watched;
                lock (gate) watched = known.ContainsKey(lower);
                if (watched) pending.Schedule(lower, Settle, () => _ = Read(lower));
            }, onError));
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            onError?.Invoke(e);
        }
    }

    public void Stop()
    {
        lock (gate) running = false;
        Watch.Stop(watchers);
        pending.Clear();
    }

    private async Task Read(string name)
    {
        lock (gate)
        {
            if (!running) return;
        }
        List<McosuScore> scores;
        try
        {
            scores = await ReadScores(NodePath.Join(root, name));
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            Report(e);
            return;
        }
        var fresh = new List<McosuScore>();
        lock (gate)
        {
            if (!running) return;
            var seen = known[name];
            foreach (var score in scores)
            {
                if (!seen.Add(EntryKey(score))) continue;
                if (!score.ImportedLegacy) fresh.Add(score);
            }
        }
        foreach (var score in fresh)
        {
            try
            {
                onReplay(BuildReplay(dir, score));
            }
            catch (Exception e) when (e is not OutOfMemoryException)
            {
                onError?.Invoke(e);
            }
        }
    }

    private void Report(Exception e)
    {
        if (e is McosuVersionException)
        {
            lock (gate)
            {
                if (reportedVersion) return;
                reportedVersion = true;
            }
        }
        onError?.Invoke(e);
    }
}
