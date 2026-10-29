using System.Text.RegularExpressions;

namespace OsuLocalProfiles.Clients;

/// <summary>
/// Options -> osu! folders: src/clients/folders.ts. The page's answer to "it did not find my osu!
/// folder", with three verbs that are deliberately not symmetrical.
/// </summary>
/// <remarks>
/// <b>Add</b> writes to <c>installRoots</c>, the user speaking, never overruled. <b>Remove</b> takes
/// a root out of <c>installRoots</c> and can do nothing else: a folder the app found by itself can
/// only be outranked. <b>Rescan</b> forgets what was remembered and searches from scratch. Nothing
/// restarts: the watchers and the resolver are built once at startup, so a change takes effect on
/// the next start, and <c>needsRestart</c> says so.
/// </remarks>
internal sealed partial class OsuFolders(AppConfig config, Action<AppConfig> save, IReadOnlyList<OsuInstall> tracking,
    DiscoveryResult initial, string builtReplays)
{
    private readonly object gate = new();
    private DiscoveryResult discovery = initial;

    /// <summary>Same folder, written two ways. Windows is case-insensitive; trailing slashes are noise.</summary>
    private static bool SameRoot(string a, string b)
    {
        static string Norm(string p) => OperatingSystem.IsWindows() ? Js.ToLower(NodePath.Resolve(p)) : NodePath.Resolve(p);
        return Norm(a) == Norm(b);
    }

    /// <summary>The folders as the page sees them. "Active" means the tracker is using it now, not after a restart.</summary>
    public object List()
    {
        lock (gate)
        {
            var configured = config.Strings("installRoots");
            var candidates = discovery.Candidates.Select(c => new
            {
                root = c.Root,
                kind = c.Kind,
                development = c.Development,
                configured = configured.Any(r => SameRoot(r, c.Root)),
                active = tracking.Any(i => SameRoot(i.Root, c.Root)),
            }).ToList();
            var wouldTrack = discovery.Installs.Select(i => i.Root).ToList();
            var needsRestart = wouldTrack.Count != tracking.Count || !wouldTrack.All(root => tracking.Any(i => SameRoot(i.Root, root)));
            return new
            {
                candidates,
                tracking = tracking.Select(i => new { root = i.Root, kind = i.Kind, development = i.Development }).ToList(),
                // As stored: config.json's own value, which a hand edit may have made anything.
                searched = config["searchedForInstalls"],
                needsRestart,
            };
        }
    }

    /// <summary>Discovery again over the current config, without searching unless asked.</summary>
    private async Task<object> Refresh(bool force)
    {
        var found = await Discover.Run(config.Strings("installRoots"), force ? [] : config.Strings("discoveredRoots"), builtReplays,
            force: force, noSearch: !force && Js.Truthy(config["searchedForInstalls"]));
        lock (gate)
        {
            discovery = found;
            config["discoveredRoots"] = JsonText.From(found.Candidates.Where(c => c.Source != "configured").Select(c => c.Root).ToList());
            if (found.Searched) config["searchedForInstalls"] = JsonText.From(true);
            save(config);
        }
        return List();
    }

    [GeneratedRegex("^[\"']|[\"']$")]
    private static partial Regex EdgeQuotes();

    /// <summary>
    /// Add a folder by hand, refused with the reason when it holds no osu! install: every way it can
    /// be wrong gets its own sentence, since whoever reaches this has already been failed once.
    /// </summary>
    public Task<object> Add(string input)
    {
        var root = NodePath.Resolve(Js.Trim(EdgeQuotes().Replace(input, "")));
        if (File.Exists(root)) throw new UserError($"{root} is a file, not a folder.");
        if (!Directory.Exists(root)) throw new UserError($"There is no folder at {root}.");

        if (Discover.Classify(root, builtReplays) is null)
        {
            // The commonest mistake by a distance: the folder above the install, the one Explorer calls osu!.
            var inside = new List<string>();
            try
            {
                foreach (var entry in Directory.EnumerateDirectories(root))
                {
                    var dir = NodePath.Join(root, Path.GetFileName(entry));
                    if (Discover.Classify(dir, builtReplays) is not null) inside.Add(dir);
                }
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                /* unreadable: the plain message below is still right */
            }
            if (inside.Count > 0)
            {
                throw new UserError($"{root} is not an osu! folder itself, but it contains {(inside.Count == 1 ? "one" : inside.Count.ToString(System.Globalization.CultureInfo.InvariantCulture))}: "
                    + string.Join(", ", inside.Take(3)));
            }
            throw new UserError($"{root} does not look like an osu! install -- an osu!stable folder has osu!.exe "
                + "in it, an osu!lazer folder has client.realm (client_<number>.realm for osu!'s "
                + "development client), and a McOsu folder has McEngine.exe.");
        }

        lock (gate)
        {
            var roots = config.Strings("installRoots");
            // Newest first: a folder added now outranks one added last month for the same client.
            if (!roots.Any(r => SameRoot(r, root))) config["installRoots"] = JsonText.From(new List<string> { root }.Concat(roots).ToList());
        }
        return Refresh(false);
    }

    /// <summary>Take a folder out of the configured and remembered lists, so a fresh start does not bring it back as found.</summary>
    public object Remove(string root)
    {
        lock (gate)
        {
            config["installRoots"] = JsonText.From(config.Strings("installRoots").Where(r => !SameRoot(r, root)).ToList());
            config["discoveredRoots"] = JsonText.From(config.Strings("discoveredRoots").Where(r => !SameRoot(r, root)).ToList());
            save(config);
            discovery = discovery with
            {
                Candidates = [.. discovery.Candidates.Where(c => !SameRoot(c.Root, root))],
                Installs = [.. discovery.Installs.Where(i => !SameRoot(i.Root, root))],
            };
        }
        return List();
    }

    /// <summary>Search the machine again, from scratch, every drive included.</summary>
    public Task<object> Rescan() => Refresh(true);

    /// <summary>
    /// What a folder change writes: only these three keys, into config.json read afresh, so a hand
    /// edit made while the app runs survives.
    /// </summary>
    public static Action<AppConfig> SaveInto(string dataDir) => next =>
    {
        var current = AppConfig.Load(dataDir);
        foreach (var key in new[] { "installRoots", "discoveredRoots", "searchedForInstalls" }) current[key] = next[key];
        current.Save(dataDir);
    };
}
