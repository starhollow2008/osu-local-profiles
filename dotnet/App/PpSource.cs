using OsuLocalProfiles.Calc;
using OsuLocalProfiles.Tracker;

namespace OsuLocalProfiles;

/// <summary>A build under way: from where, and the last line <c>dotnet</c> printed.</summary>
internal sealed record PpSourceBuilding(string Source, string Line);

/// <summary>What prices scores, as the page reads it (src/pp-source.ts, <c>PpSourceState</c>).</summary>
/// <param name="Source">The source in use, or empty for the release.</param>
/// <param name="Version">What that source's pp is labelled, while it is in use.</param>
/// <param name="Error">Why the last build or switch did not happen, until the next one starts.</param>
internal sealed record PpSourceState(string Source, string? Version, PpSourceBuilding? Building, string? Error);

/// <summary>
/// <see cref="PpSourceState"/>, and <c>now</c>: what the source folder would be labelled if it were
/// built now. It differs from <c>version</c> once the player has changed their source since it was
/// built, and the page offers a rebuild then.
/// </summary>
internal sealed record PpSourceView(string Source, string? Version, PpSourceBuilding? Building, string? Error, string? Now);

/// <summary>What the switch needs from the tracker, so the tests can stand in for it.</summary>
internal sealed record PpSourceTracker(
    Func<OfficialCalculator, Action, Task<RecomputeResult>> SwitchCalculator,
    Func<string?> CalculatorVersion,
    Func<bool> Recalculating)
{
    public static PpSourceTracker Of(PlayTracker tracker) =>
        new(tracker.SwitchCalculator, () => tracker.CalculatorVersion, () => tracker.IsRecalculating);
}

/// <summary>
/// Settings, pp calculator: price every score with the player's own osu! source, or with the release
/// this app ships, and switch between the two (roadmap 5.70; src/pp-source.ts).
/// </summary>
/// <remarks>
/// A switch is always whole: the new calculator takes over every profile and every score is
/// recalculated with it (<see cref="PlayTracker.SwitchCalculator"/>), so no total ever adds pp from two
/// formulas. And it never falls back. If the source's helper will not build or start, nothing changes
/// (the calculator in use stays in use) and the page is told why; if it will not start at a launch,
/// the app prices nothing that session rather than quietly using the release
/// (<see cref="StartupCalculator"/>), the same as when the release's calculator cannot load.
/// </remarks>
internal sealed class PpSource
{
    private const string RecalculatingRefusal = "scores are being recalculated; switch once that has finished";

    private readonly PpSourceTracker tracker;
    private readonly string dataDir;
    private readonly string program;
    private readonly Func<string> getSource;
    private readonly Action<string> setSource;
    private readonly Func<(OfficialCalculator? Calculator, string? Problem)> release;
    private readonly object gate = new();
    private PpSourceBuilding? building;
    private string? error;
    /// <summary>A switch under way, from its first check to its last: one at a time.</summary>
    private bool switching;

    /// <summary>Every change to <see cref="State"/>, for the live feed's <c>pp-source</c> event.</summary>
    public event Action<PpSourceState>? Changed;

    /// <param name="program">This app's <c>tools/PpCalculator/Program.cs</c>.</param>
    /// <param name="getSource">The source config.json names.</param>
    /// <param name="setSource">How to change it.</param>
    /// <param name="startupProblem">Why the launch started with no calculator for the configured source, if it did.</param>
    /// <param name="release">The release's calculator, in-process; replaced in tests.</param>
    public PpSource(PpSourceTracker tracker, string dataDir, string program, Func<string> getSource, Action<string> setSource,
        string? startupProblem = null, Func<(OfficialCalculator?, string?)>? release = null)
    {
        this.tracker = tracker;
        this.dataDir = dataDir;
        this.program = program;
        this.getSource = getSource;
        this.setSource = setSource;
        this.release = release ?? OfficialCalculator.Create;
        error = startupProblem;
    }

    /// <summary>
    /// The calculator a launch starts with. With a source configured, only the helper built from it,
    /// never the release in its place, which would reprice the profile with a formula nobody chose.
    /// Null, with the reason, when there is none to be had.
    /// </summary>
    public static async Task<(OfficialCalculator? Calculator, string? Problem)> StartupCalculator(string source, string dataDir)
    {
        if (source.Length == 0) return OfficialCalculator.Create();
        var helper = SourceHelper.Read(dataDir);
        if (helper is null || !SourceHelper.SameFolder(helper.Source, source))
        {
            return (null, $"no calculator has been built from your osu! source at {source}");
        }
        var calculator = await OfficialCalculator.Start(SourceHelper.Candidate(helper), helper.Version);
        return (calculator, calculator is null ? $"the calculator built from your osu! source ({helper.Version}) would not start" : null);
    }

    /// <summary>Cheap: what is in use and under way.</summary>
    public PpSourceState State()
    {
        var source = getSource();
        lock (gate) return new PpSourceState(source, source.Length == 0 ? null : tracker.CalculatorVersion(), building, error);
    }

    /// <summary><see cref="State"/>, and what the source folder would be labelled now, which asks git.</summary>
    public PpSourceView View()
    {
        var now = State();
        string? current = null;
        if (now.Source.Length > 0)
        {
            try
            {
                current = SourceHelper.SourceVersion(now.Source);
            }
            catch (Exception e) when (e is InvalidOperationException or IOException or UnauthorizedAccessException)
            {
                current = null;
            }
        }
        return new PpSourceView(now.Source, now.Version, now.Building, now.Error, current);
    }

    private void OnChanged() => Changed?.Invoke(State());

    private PpSourceState Fail(string message)
    {
        lock (gate)
        {
            error = message;
            building = null;
        }
        OnChanged();
        return State();
    }

    /// <summary>
    /// Hand <paramref name="calculator"/> to the tracker, reprice everything with it, and remember
    /// <paramref name="source"/> as the one in use. Refused, with nothing changed, if a recalculation
    /// began meanwhile.
    /// </summary>
    private async Task<PpSourceState> SwitchTo(OfficialCalculator calculator, string source)
    {
        if (tracker.Recalculating())
        {
            calculator.Dispose();
            return Fail(RecalculatingRefusal);
        }
        try
        {
            await tracker.SwitchCalculator(calculator, () =>
            {
                setSource(source);
                lock (gate) error = null;
                OnChanged();
            });
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            // The recalculation reports its own progress; a failure in it is not a failed switch.
            lock (gate) error = $"switched, but recalculating failed: {e.Message}";
        }
        OnChanged();
        return State();
    }

    /// <summary>One switch at a time, whatever it does.</summary>
    private async Task<PpSourceState> Exclusive(Func<Task<PpSourceState>> run)
    {
        string? refused;
        lock (gate)
        {
            refused = switching
                ? building is not null ? "your osu! source is already being built" : "the calculator is already being switched"
                : tracker.Recalculating() ? RecalculatingRefusal : null;
            if (refused is null) switching = true;
        }
        if (refused is not null) return Fail(refused);
        try
        {
            return await run();
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            return Fail(e.Message);
        }
        finally
        {
            lock (gate)
            {
                switching = false;
                building = null;
            }
        }
    }

    /// <summary>
    /// Build (when needed) and switch to <paramref name="source"/>'s calculator. Runs up to its first
    /// wait before returning, so <see cref="State"/> then says what it decided: a refusal, or a build begun.
    /// </summary>
    public Task<PpSourceState> Use(string source) => Exclusive(async () =>
    {
        if (SourceHelper.CheckOsuSource(source) is { } problem) return Fail(problem);
        string version;
        try
        {
            version = SourceHelper.SourceVersion(source);
        }
        catch (InvalidOperationException e)
        {
            return Fail(e.Message);
        }

        // In use already, exactly as the source is now: nothing to do.
        var inUse = getSource();
        if (inUse.Length > 0 && SourceHelper.SameFolder(inUse, source) && tracker.CalculatorVersion() == version)
        {
            lock (gate) error = null;
            OnChanged();
            return State();
        }

        // Built from exactly this source as it is now: start that rather than build it again.
        var helper = SourceHelper.Read(dataDir);
        if (helper is null || !SourceHelper.SameFolder(helper.Source, source) || helper.Version != version)
        {
            lock (gate)
            {
                building = new PpSourceBuilding(source, "");
                error = null;
            }
            OnChanged();
            long last = 0;
            try
            {
                helper = await SourceHelper.Build(source, dataDir, program, line =>
                {
                    lock (gate) building = new PpSourceBuilding(source, line);
                    // Enough to show it is moving, without a message per line the compiler prints.
                    if (Js.Now() - last > 500)
                    {
                        last = Js.Now();
                        OnChanged();
                    }
                });
            }
            catch (Exception e) when (e is InvalidOperationException or IOException or UnauthorizedAccessException)
            {
                return Fail(e.Message);
            }
            lock (gate) building = null;
        }

        var calculator = await OfficialCalculator.Start(SourceHelper.Candidate(helper), helper.Version);
        if (calculator is null)
        {
            return Fail($"it built, but the calculator from your osu! source ({helper.Version}) would not start");
        }
        return await SwitchTo(calculator, source);
    });

    /// <summary>Switch back to the bundled release.</summary>
    public Task<PpSourceState> UseRelease() => Exclusive(async () =>
    {
        var (calculator, _) = release();
        if (calculator is null) return Fail("this app's own pp calculator would not start");
        return await SwitchTo(calculator, "");
    });
}
