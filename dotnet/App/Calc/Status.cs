namespace OsuLocalProfiles.Calc;

/// <summary>osu!'s beatmap <c>approved</c> values (src/clients/beatmaps.ts, <c>Status</c>).</summary>
internal static class Status
{
    public const int Graveyard = -2;
    public const int Wip = -1;
    public const int Pending = 0;
    public const int Ranked = 1;
    public const int Approved = 2;
    public const int Qualified = 3;
    public const int Loved = 4;

    /// <summary>
    /// Stored in <c>scores.map_status</c> when the beatmap is not in <c>online.db</c> at all: it was
    /// never submitted, or the local copy is newer than lazer's cache.
    /// </summary>
    public const int Unresolved = -3;

    public static bool AwardsPp(int? status) => status is Ranked or Approved;

    /// <summary>
    /// The beatmap states a profile can choose to count, by the name the setting uses, in the
    /// order the TypeScript object lists them (<c>UNRANKED_MAP_STATUSES</c>).
    /// </summary>
    public static readonly (string Name, int Value)[] UnrankedMapStatuses =
    [
        ("loved", Loved),
        ("qualified", Qualified),
        ("pending", Pending),
        ("wip", Wip),
        ("graveyard", Graveyard),
        ("unsubmitted", Unresolved),
    ];

    public static int? UnrankedMapStatus(string name)
    {
        foreach (var (key, value) in UnrankedMapStatuses)
        {
            if (key == name) return value;
        }
        return null;
    }
}
