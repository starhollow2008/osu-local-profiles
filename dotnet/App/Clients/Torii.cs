using System.Text.Json;

namespace OsuLocalProfiles.Clients;

/// <summary>
/// The mods two osu!lazer forks add, Torii (ShikkesoraSIM/torii-osu) and Ritsu (Azuuryy/ritsu, built
/// on Torii, with Modosu's training mods). Both write lazer's replays with their own acronyms in
/// them, so their plays are lazer plays. osu!'s calculator reads an acronym it does not have as an
/// UnknownMod and prices the play as if it were not there, which is right only for the mods that
/// leave the beatmap and its difficulty alone.
/// </summary>
/// <remarks>
/// Read from their source: Torii at <c>a2628b3</c> and Ritsu at <c>7e28ddd</c>, both 2026-11. Ritsu's
/// Miss Challenge is <c>MC</c>, which is also McOsu's own mod here: on a play osu! scores as stable
/// it is McOsu's, and on any other it is Miss Challenge.
/// </remarks>
internal static class Torii
{
    /// <summary>Mods that change only sound, visuals or when the play fails: priced as osu! prices the play without them.</summary>
    public static readonly HashSet<string> Priced = ["HS", "PA", "ME", "MC"];

    /// <summary>Mods that move, add, remove or retime objects, or change the map's difficulty: no pp.</summary>
    public static readonly HashSet<string> Unpriced =
        ["CG", "DCY", "DFK", "ECH", "HFR", "HST", "NL", "PMR", "RDV2", "RSL", "SA", "SOT", "SWG"];

    /// <summary>The folder each keeps its own data in, beside lazer's <c>osu</c>: <c>%APPDATA%</c> on Windows.</summary>
    public static readonly (string Client, string Folder)[] DataFolders = [("torii", "osu-torii"), ("ritsu", "Ritsu")];

    /// <summary>
    /// The clients with mods of their own on this machine, which the page offers those mods for:
    /// McOsu and neomod by a folder of theirs tracked or found, Torii and Ritsu by their own data
    /// folder, or a lazer folder that is one of those. <paramref name="machine"/> null looks at no folders.
    /// </summary>
    public static List<string> ClientsWithOwnMods(IEnumerable<(string Kind, string Root)> folders, DetectEnvironment? machine)
    {
        var found = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var (kind, root) in folders)
        {
            if (kind is "mcosu" or "neomod") found.Add(kind);
            var name = NodePath.Basename(NodePath.Resolve(root));
            foreach (var (client, folder) in DataFolders)
                if (string.Equals(name, folder, StringComparison.OrdinalIgnoreCase)) found.Add(client);
        }
        if (machine is not null)
            foreach (var home in Detect.LazerDataHomes(machine))
                foreach (var (client, folder) in DataFolders)
                    if (Directory.Exists(NodePath.Join(home, folder))) found.Add(client);
        return [.. found];
    }

    /// <summary>Whether a lazer play carries a mod osu!'s calculator cannot price.</summary>
    public static bool ChangesBeatmap(IEnumerable<JsonElement>? mods) =>
        mods is not null && mods.Any(m => Calc.Mods.Acronym(m) is { } a && Unpriced.Contains(a));
}
