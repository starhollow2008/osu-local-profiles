using OsuLocalProfiles.Db;

namespace OsuLocalProfiles.Calc;

/// <summary>
/// A beatmap's names, and the same names in the song's own script where they differ:
/// src/calc/metadata.ts. Both are sent and the page picks (roadmap 5.55).
/// </summary>
internal sealed record BeatmapNames(string? Artist, string? Title, string? ArtistUnicode, string? TitleUnicode);

internal static class Metadata
{
    /// <summary>The beatmap columns a query needs to name what was played, aliased <c>b</c>.</summary>
    public const string NameColumns = "b.artist, b.title, b.artist_unicode, b.title_unicode";

    /// <summary>Text that says something: a non-empty string, else null.</summary>
    private static string? TextOf(object? value) => value is string s && s.Length > 0 ? s : null;

    /// <summary>One row's four name columns, with an original-language name only where it differs.</summary>
    public static BeatmapNames Names(Row r) => Names(r["artist"], r["title"], r["artist_unicode"], r["title_unicode"]);

    public static BeatmapNames Names(object? artistValue, object? titleValue, object? artistUnicodeValue, object? titleUnicodeValue)
    {
        var artist = TextOf(artistValue);
        var title = TextOf(titleValue);
        var artistUnicode = TextOf(artistUnicodeValue);
        var titleUnicode = TextOf(titleUnicodeValue);
        return new BeatmapNames(
            artist,
            title,
            artistUnicode == artist ? null : artistUnicode,
            titleUnicode == title ? null : titleUnicode);
    }

    /// <summary>
    /// The same names, with <paramref name="fallback"/> standing in for a title the beatmap cache
    /// does not have: lazer's log's own name for a map that is not installed.
    /// </summary>
    public static BeatmapNames WithFallbackTitle(BeatmapNames n, string? fallback) =>
        n.Title is null && !string.IsNullOrEmpty(fallback) ? n with { Title = fallback, TitleUnicode = null } : n;

    /// <summary><c>artist - title</c>, the way every list writes it. Empty when the beatmap has neither.</summary>
    public static string BeatmapName(BeatmapNames n) =>
        string.Join(" - ", new[] { n.Artist, n.Title }.Where(s => !string.IsNullOrEmpty(s)));

    /// <summary>The same name in the song's own script, or null when it would read the same.</summary>
    public static string? BeatmapNameOriginal(BeatmapNames n)
    {
        if (n.ArtistUnicode is null && n.TitleUnicode is null) return null;
        var original = string.Join(" - ", new[] { n.ArtistUnicode ?? n.Artist, n.TitleUnicode ?? n.Title }.Where(s => !string.IsNullOrEmpty(s)));
        return original.Length == 0 || original == BeatmapName(n) ? null : original;
    }

    /// <summary><c>beatmapName(n) || null</c>.</summary>
    public static string? BeatmapNameOrNull(BeatmapNames n) => BeatmapName(n) is { Length: > 0 } name ? name : null;
}
