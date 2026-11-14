namespace OsuLocalProfiles.Http;

/// <summary>
/// Profiles -> Import from osu!, while it runs: which step it is on, and how far through that step.
/// <c>Total</c> is 0 when the step cannot say how much there is, and the page's bar then sweeps.
/// </summary>
internal sealed record OsuImportState(bool Active, string Step, double? Mode, int Done, int Total, string? Username);

/// <summary>
/// How far an import from an osu! account has got, kept so a page opened or reloaded meanwhile can
/// show it (<c>/api/state</c>), and sent to every open page as <c>osu-import</c>. The import itself
/// is one request, which carries on whatever the page does.
/// </summary>
internal sealed class OsuImportProgress
{
    private readonly object gate = new();
    private OsuImportState state = new(false, "account", null, 0, 0, null);

    /// <summary>Who hears each change: the live feed.</summary>
    public event Action<OsuImportState>? Changed;

    public OsuImportState State
    {
        get
        {
            lock (gate) return state;
        }
    }

    /// <summary>Begin an import, or false when one is already running: one at a time.</summary>
    public bool TryStart()
    {
        OsuImportState next;
        lock (gate)
        {
            if (state.Active) return false;
            next = state = new OsuImportState(true, "account", null, 0, 0, null);
        }
        Changed?.Invoke(next);
        return true;
    }

    /// <summary>The account it found, which the page names while it copies.</summary>
    public void Named(string username) => Update(s => s with { Username = username });

    /// <summary>A new step, or further through this one.</summary>
    public void Step(string step, int done = 0, int total = 0, double? mode = null) =>
        Update(s => s with { Step = step, Done = done, Total = total, Mode = mode });

    public void Finish()
    {
        OsuImportState next;
        lock (gate) next = state = state with { Active = false };
        Changed?.Invoke(next);
    }

    private void Update(Func<OsuImportState, OsuImportState> change)
    {
        OsuImportState next;
        lock (gate)
        {
            if (!state.Active) return;
            next = state = change(state);
        }
        Changed?.Invoke(next);
    }
}
