using System.Text.Json;
using OsuLocalProfiles.Calc;
using OsuLocalProfiles.Settings;
using OsuLocalProfiles.Update;

namespace OsuLocalProfiles.Http;

/// <summary>
/// <c>/api/state</c>: everything the page needs to start, apart from the profile's figures
/// (src/http/server.ts). The tracker's, the updater's and the osu! installs' fields are their
/// quiet starting values until phases 4 and 5 port them.
/// </summary>
internal static class StateApi
{
    /// <summary>The browser a screenshot would use, or null: src/http/screenshot.ts's candidates, remembered a few minutes.</summary>
    internal static class Browsers
    {
        private static (DateTime At, string? Found)? cache;

        private static IEnumerable<string> Candidates()
        {
            var candidates = new List<string>();
            if (OperatingSystem.IsWindows())
            {
                foreach (var root in new[] { "PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA" }
                    .Select(Environment.GetEnvironmentVariable).Where(r => !string.IsNullOrEmpty(r)))
                {
                    candidates.Add(Path.Combine(root!, "Google/Chrome/Application/chrome.exe"));
                    candidates.Add(Path.Combine(root!, "Microsoft/Edge/Application/msedge.exe"));
                }
            }
            else if (OperatingSystem.IsMacOS())
            {
                candidates.AddRange([
                    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
                    "/Applications/Chromium.app/Contents/MacOS/Chromium",
                ]);
            }
            else
            {
                candidates.AddRange([
                    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
                    "/usr/bin/microsoft-edge", "/usr/bin/brave-browser", "/snap/bin/chromium",
                    "/var/lib/flatpak/exports/bin/org.chromium.Chromium",
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".local/share/flatpak/exports/bin/org.chromium.Chromium"),
                ]);
            }
            foreach (var candidate in candidates) if (File.Exists(candidate) || Directory.Exists(candidate)) yield return candidate;

            // Then whatever is simply on PATH, as a shell would find it.
            var dirs = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries);
            var extensions = OperatingSystem.IsWindows() ? (Environment.GetEnvironmentVariable("PATHEXT") ?? ".EXE").Split(';') : [""];
            foreach (var name in new[] { "google-chrome", "chromium", "chromium-browser", "microsoft-edge" })
            {
                foreach (var dir in dirs)
                {
                    foreach (var extension in extensions)
                    {
                        var candidate = Path.Combine(dir, name + extension);
                        if (File.Exists(candidate)) yield return candidate;
                    }
                }
            }
        }

        public static string? Find()
        {
            if (cache is { } hit && DateTime.UtcNow - hit.At < TimeSpan.FromMinutes(5)) return hit.Found;
            var found = Candidates().FirstOrDefault();
            cache = (DateTime.UtcNow, found);
            return found;
        }
    }

    /// <summary>Scores ingested before the eligibility columns, which a recompute can fill in (countStale).</summary>
    private static double StaleScores(Db.Database db, long profileId) => Convert.ToDouble(db.Scalar("""
        SELECT COUNT(*) AS n FROM scores
         WHERE profile_id = ? AND replay_path IS NOT NULL AND imported_at IS NULL
           AND (map_status IS NULL OR mods_ranked_by IS NULL)
        """, profileId));

    /// <summary>
    /// Scores a different osu! release priced, or one before the release was recorded, that their
    /// replay could price again (outdatedPpCount, outdatedPpSql).
    /// </summary>
    private static double OutdatedPp(Db.Database db, long profileId, string current) => Convert.ToDouble(db.Scalar($"""
        SELECT COUNT(*) AS n FROM scores s
         WHERE s.profile_id = ? AND {Eligibility.VisibleSql()} AND s.replay_path IS NOT NULL AND s.imported_at IS NULL
           AND s.pp IS NOT NULL AND (s.pp_version IS NULL OR s.pp_version <> ?)
        """, profileId, current));

    private static double Count(Db.Database db, string sql, params object?[] args) => Convert.ToDouble(db.Scalar(sql, args));

    public static object Answer(ServerOptions opts, long profileId, bool fromTray)
    {
        var db = opts.Db;
        var tracker = opts.Tracker;
        var profile = Profiles.Get(db, profileId)!;
        var settings = SettingsStore.Get(db, profileId, opts.Config.SettingsFallbacks());
        var version = opts.Paths.Version();
        var (hasAvatar, hasCover) = Identity.ImageState(opts.Paths.DataDir, profileId);

        // The updater's state before any check: nothing found, nothing waiting (phase 5).
        List<VersionNotes> notes = [];
        var update = new
        {
            currentVersion = version,
            latestVersion = (string?)null,
            available = false,
            releaseUrl = (string?)null,
            blocked = (string?)null,
            error = (string?)null,
            checkedAt = (string?)null,
            applying = false,
            notes,
            changelogUrl = Notes.ChangelogUrl,
            nudge = (string?)null,
            ready = (string?)null,
            installOnQuit = false,
            preparing = false,
            prepareError = (string?)null,
            downloadedBytes = (double?)null,
            metered = (bool?)null,
            autoUpdate = opts.Config["autoUpdate"] is { ValueKind: JsonValueKind.True },
            nudgeShown = Notes.NudgeShown(null, notes, Notes.NudgeDismissal(db), Js.Now()),
        };

        return new
        {
            settings,
            app = new
            {
                version,
                update,
                // What this version brought, once, after an update.
                whatsNew = Notes.WhatsNew(db, version, opts.Paths.InstallDir, opts.Paths.DataDir),
                config = opts.Config.PageView(),
                launcher = fromTray ? "tray" : "terminal",
                platform = Browser.Platform,
            },
            profile = new
            {
                id = profile.Id,
                name = profile.Name,
                country = settings.Country,
                tagline = settings.Tagline,
                createdAt = profile.CreatedAt,
                trackingSince = profile.TrackingSince,
                hasAvatar,
                hasCover,
            },
            profiles = Profiles.List(db),
            // A read-only copy tracks nothing: the tracker's fields as they are before anything is tracked.
            tracking = tracker?.IsTracking ?? false,
            scoresThisSession = tracker?.ScoresAdded ?? 0,
            playsFiltered = tracker?.PlaysFiltered ?? 0,
            playsRefused = tracker?.PlaysRefused ?? 0,
            filterNarrowing = TrackingFilter.Narrows(settings.TrackingFilter),
            indexing = tracker?.IndexState ?? new Tracker.IndexState(false, false, "indexing", 0, 0, 0, false, 0, null),
            importing = tracker?.ImportState ?? new Tracker.ImportState(false, "scanning", 0, 0, 0, 0, "import"),
            /*
             * Which osu! release prices scores, and how many of this profile's a different one priced:
             * after an update that brings a pp rework, the ones Settings offers to recalculate.
             */
            ppCalculator = new
            {
                version = opts.Calculator?.Version,
                source = new
                {
                    source = opts.PpSource,
                    version = opts.PpSource.Length == 0 ? null : opts.Calculator?.Version,
                    building = (object?)null,
                    error = opts.CalculatorProblem,
                },
                recalculating = tracker?.IsRecalculating ?? false,
                outdated = opts.Calculator?.Version is { } current ? OutdatedPp(db, profileId, current) : 0,
            },
            // The tracker's profile, as the Node app reads it.
            staleScores = tracker is null ? StaleScores(db, profileId) : tracker.StaleScores,
            // Removed scores, and each attempt of a removed unfinished play.
            hiddenScores = Count(db, """
                SELECT (SELECT COUNT(*) FROM scores WHERE profile_id = ? AND hidden_at IS NOT NULL)
                     + (SELECT COUNT(*) FROM incomplete_plays WHERE profile_id = ? AND hidden_at IS NOT NULL) AS n
                """, profileId, profileId),
            declinedPlays = Count(db, "SELECT COUNT(*) AS n FROM declined_plays WHERE profile_id = ?", profileId),
            unsubmittedAttempts = Stats.UnsubmittedAttemptCount(db, profileId),
            sharing = new { canScreenshot = Browsers.Find() is not null },
            defaultMode = Stats.MostRecentMode(db, profileId),
            modesWithPlays = Stats.ModesWithPlays(db, profileId, Eligibility.Of(settings, opts.StatusKnown)),
            // A brand-new install's one-time offer to import from an osu! account.
            welcome = db.Exists("SELECT 1 AS hit FROM kv WHERE key = ?", "welcomePending"),
            installs = opts.Installs.Select(i => new
            {
                kind = i.Kind,
                // osu!'s development client, a lazer of its own beside release lazer.
                development = i.Development,
                root = i.Root,
                hasOnlineDb = i.OnlineDb is not null,
            }),
        };
    }
}
