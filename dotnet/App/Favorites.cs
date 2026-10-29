using System.Text.Json;
using OsuLocalProfiles.Calc;
using OsuLocalProfiles.Clients;
using OsuLocalProfiles.Db;

namespace OsuLocalProfiles;

/// <summary>
/// Whose favourites: one profile's own list, or the one every profile shares (the default). The
/// profile still matters when shared: a card built from local data takes its star ratings from
/// that profile's scores.
/// </summary>
internal sealed record FavoriteScope(long ProfileId, bool Shared);

/// <summary>
/// Favorite Beatmaps, the reading half: src/favorites.ts. A card is drawn from what osu.ppy.sh
/// said when the set was favourited, or failing that from what this machine knows.
/// </summary>
/// <remarks>
/// The local card reads lazer's <c>online.db</c> for a set's other difficulties; until the beatmap
/// index is ported (phase 4) it is built without it, as the TypeScript does with no resolver.
/// </remarks>
internal static class Favorites
{
    private static readonly string[] ModeByRuleset = ["osu", "taiko", "fruits", "mania"];

    private static readonly Dictionary<long, string> StatusName = new()
    {
        [-2] = "graveyard", [-1] = "wip", [0] = "pending", [1] = "ranked", [2] = "approved", [3] = "qualified", [4] = "loved",
    };

    private static (string Table, string Where, object[] Params) Resolve(FavoriteScope scope) => scope.Shared
        ? ("shared_favorite_beatmapsets", "1 = 1", [])
        : ("favorite_beatmapsets", "profile_id = ?", [scope.ProfileId]);

    /// <summary>Every favourited set id, so each row's menu can say Favorite or Unfavorite.</summary>
    public static List<object?> Ids(Database db, FavoriteScope scope)
    {
        var (table, where, args) = Resolve(scope);
        return [.. db.Rows($"SELECT beatmapset_id FROM {table} WHERE {where}", args).Select(r => r["beatmapset_id"])];
    }

    public static double Count(Database db, FavoriteScope scope)
    {
        var (table, where, args) = Resolve(scope);
        return Convert.ToDouble(db.Scalar($"SELECT COUNT(*) AS n FROM {table} WHERE {where}", args));
    }

    /// <summary>What osu.ppy.sh said about a set, as cached, or null.</summary>
    public static JsonElement? DetailsFor(Database db, object? beatmapsetId)
    {
        var data = db.Get("SELECT data FROM beatmapset_details WHERE beatmapset_id = ?", r => r.GetString(0), beatmapsetId);
        return data is not null && JsonText.TryParse(data, out var details) ? details : null;
    }

    /// <summary>The favourites as cards, most recently favourited first, <paramref name="limit"/> at a time.</summary>
    public static List<Dictionary<string, object?>> List(Database db, FavoriteScope scope, long limit)
    {
        var (table, where, args) = Resolve(scope);
        var rows = db.Rows($"""
            SELECT beatmapset_id, favorited_at FROM {table}
             WHERE {where} ORDER BY favorited_at DESC, beatmapset_id DESC LIMIT ?
            """, [.. args, limit]);
        return [.. rows.Select(r => DetailsFor(db, r["beatmapset_id"]) is { } details
            ? FromDetails(details, r["favorited_at"])
            : LocalCard(db, scope.ProfileId, r["beatmapset_id"], r["favorited_at"]))];
    }

    /// <summary>
    /// A card from cached details, each value passed through as stored. A key the details lack is
    /// left out, as <c>JSON.stringify</c> leaves out an undefined one.
    /// </summary>
    private static Dictionary<string, object?> FromDetails(JsonElement d, object? favoritedAt)
    {
        var card = new Dictionary<string, object?>();
        void Put(string key, JsonElement? value)
        {
            if (value is not null) card[key] = value;
        }
        JsonElement? Field(string key) => Js.Get(d, key);
        // `a && a !== b ? a : null`: the original-language name only where it differs.
        object? Different(string key, string romanised)
        {
            var value = Field(key);
            return Js.Truthy(value) && !JsonEquals(value, Field(romanised)) ? value : null;
        }

        Put("id", Field("id"));
        Put("title", Field("title"));
        Put("artist", Field("artist"));
        card["titleUnicode"] = Different("titleUnicode", "title");
        card["artistUnicode"] = Different("artistUnicode", "artist");
        card["creator"] = Js.Truthy(Field("creator")) ? Field("creator") : null;
        card["userId"] = Js.Truthy(Field("userId")) ? Field("userId") : null;
        Put("status", Field("status"));
        Put("nsfw", Field("nsfw"));
        Put("spotlight", Field("spotlight"));
        Put("featuredArtist", Field("featuredArtist"));
        // Details cached before these were kept have neither: unknown, not false.
        card["video"] = Field("video") is { ValueKind: JsonValueKind.True or JsonValueKind.False } video ? video : null;
        card["storyboard"] = Field("storyboard") is { ValueKind: JsonValueKind.True or JsonValueKind.False } sb ? sb : null;
        Put("favouriteCount", Field("favouriteCount"));
        Put("playCount", Field("playCount"));
        Put("date", Field("date"));
        var difficulties = new List<Dictionary<string, object?>>();
        if (Field("difficulties") is { ValueKind: JsonValueKind.Array } list)
        {
            foreach (var x in list.EnumerateArray())
            {
                var difficulty = new Dictionary<string, object?>();
                foreach (var key in new[] { "id", "mode", "stars", "version" })
                {
                    if (Js.Get(x, key) is { } value) difficulty[key] = value;
                }
                difficulties.Add(difficulty);
            }
        }
        card["difficulties"] = difficulties;
        card["source"] = "osu";
        card["favoritedAt"] = favoritedAt;
        return card;
    }

    /// <summary><c>a !== b</c> for two JSON values: same kind and same text or number.</summary>
    private static bool JsonEquals(JsonElement? a, JsonElement? b)
    {
        if (a is null || b is null) return a is null && b is null;
        if (a.Value.ValueKind != b.Value.ValueKind) return false;
        return a.Value.ValueKind switch
        {
            JsonValueKind.String => a.Value.GetString() == b.Value.GetString(),
            JsonValueKind.Number => Js.NumberOf(a.Value) == Js.NumberOf(b.Value),
            JsonValueKind.True or JsonValueKind.False or JsonValueKind.Null => true,
            // Two objects or arrays are never the same object.
            _ => false,
        };
    }

    /// <summary>Mods that leave a difficulty's star rating untouched, so a score with only these can stand in for it.</summary>
    private static readonly HashSet<string> RatingNeutralMods = ["NF", "SD", "PF", "HD", "CL", "MR", "TD", "SV2"];

    public static bool RatingNeutral(string? modsJson) =>
        Mods.Parse(modsJson) is { } mods && mods.All(m => Mods.Acronym(m) is { } a && RatingNeutralMods.Contains(a));

    /// <summary>
    /// A card from local knowledge alone, for a set osu.ppy.sh could not be asked about: every
    /// difficulty the cache holds, star ratings only from this profile's rating-neutral scores,
    /// the mode from a score or the <c>.osu</c> itself. What is not known stays null.
    /// </summary>
    private static Dictionary<string, object?> LocalCard(Database db, long profileId, object? beatmapsetId, object? favoritedAt)
    {
        var cached = db.Rows("""
            SELECT md5, beatmap_id, artist, title, artist_unicode, title_unicode,
                   version, creator, status, osu_path
              FROM beatmaps WHERE beatmapset_id = ?
            """, beatmapsetId);

        var md5s = cached.Select(c => c.Text("md5")).Distinct().ToList();
        var played = new Dictionary<string, (object? Mode, object? Stars)>();
        if (md5s.Count > 0)
        {
            var scores = db.Rows($"""
                SELECT s.beatmap_md5, s.mode, s.stars, s.mods_json FROM scores s
                 WHERE s.profile_id = ? AND {Eligibility.VisibleSql()}
                   AND s.beatmap_md5 IN ({string.Join(",", md5s.Select(_ => "?"))})
                """, [profileId, .. md5s]);
            foreach (var s in scores)
            {
                var md5 = s.Text("beatmap_md5");
                var entry = played.TryGetValue(md5, out var found) ? found : (s["mode"], null);
                if (entry.Stars is null && s["stars"] is not null && RatingNeutral(s.Str("mods_json"))) entry.Stars = s["stars"];
                played[md5] = entry;
            }
        }

        string? ModeOf(string md5, string? osuPath)
        {
            if (played.TryGetValue(md5, out var p) && p.Mode is long or double)
            {
                var m = Convert.ToDouble(p.Mode);
                return m is 0 or 1 or 2 or 3 ? ModeByRuleset[(int)m] : null;
            }
            return osuPath is null ? null : ModeByRuleset[Beatmaps.Mode(osuPath)];
        }

        var difficulties = new List<(object? Id, string? Mode, object? Stars, object? Version)>();
        foreach (var c in cached)
        {
            var md5 = c.Text("md5");
            difficulties.Add((c["beatmap_id"], ModeOf(md5, c.Str("osu_path")),
                played.TryGetValue(md5, out var p) ? p.Stars : null, c["version"] ?? "?"));
        }

        // A difficulty whose mode is still unknown takes the set's: sets are almost always one mode.
        var known = difficulties.Select(d => d.Mode).FirstOrDefault(m => m is not null) ?? "osu";
        var first = cached.FirstOrDefault(c => c["title"] is string { Length: > 0 }) ?? cached.FirstOrDefault();
        var names = first is null ? null : Metadata.Names(first);
        var status = first?["status"] is long code ? StatusName.GetValueOrDefault(code) : null;

        return new Dictionary<string, object?>
        {
            ["id"] = beatmapsetId,
            ["title"] = first?["title"] ?? $"beatmapset {ToText(beatmapsetId)}",
            ["artist"] = first?["artist"] ?? "",
            ["titleUnicode"] = names?.TitleUnicode,
            ["artistUnicode"] = names?.ArtistUnicode,
            ["creator"] = first?["creator"],
            ["userId"] = null,
            ["status"] = status,
            ["nsfw"] = false,
            ["spotlight"] = false,
            ["featuredArtist"] = false,
            ["video"] = null,
            ["storyboard"] = null,
            ["favouriteCount"] = null,
            ["playCount"] = null,
            ["date"] = null,
            ["difficulties"] = difficulties.Select(d => new Dictionary<string, object?>
            {
                ["id"] = d.Id, ["mode"] = d.Mode ?? known, ["stars"] = d.Stars, ["version"] = d.Version,
            }).ToList(),
            ["source"] = "local",
            ["favoritedAt"] = favoritedAt,
        };
    }

    /// <summary>
    /// Bring the two lists together when sharing is switched, so nothing is lost either way: on,
    /// every profile's own favourites join the shared list; off, the shared list is copied into
    /// every profile's own. What was last applied is kept in <c>kv</c>, so this runs once per switch,
    /// including one made by hand in config.json while the app was closed.
    /// </summary>
    public static string? SyncSharing(Database db, bool shared) => db.Serialized(() =>
    {
        var row = db.Get("SELECT value FROM kv WHERE key = 'favoritesShared'", r => r.GetString(0));
        var was = row == "1";
        void Record() => db.Run(
            "INSERT INTO kv (key, value) VALUES ('favoritesShared', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            shared ? "1" : "0");
        if (was == shared)
        {
            if (row is null) Record();
            return null;
        }
        db.Transaction(() =>
        {
            db.Exec(shared
                ? """
                  INSERT OR IGNORE INTO shared_favorite_beatmapsets (beatmapset_id, favorited_at)
                  SELECT beatmapset_id, MAX(favorited_at) FROM favorite_beatmapsets GROUP BY beatmapset_id
                  """
                : """
                  INSERT OR IGNORE INTO favorite_beatmapsets (profile_id, beatmapset_id, favorited_at)
                  SELECT p.id, s.beatmapset_id, s.favorited_at FROM profiles p CROSS JOIN shared_favorite_beatmapsets s
                  """);
            Record();
        });
        return shared ? "merged" : "copied";
    });

    private static string ToText(object? value) => value switch
    {
        null => "null",
        long l => l.ToString(System.Globalization.CultureInfo.InvariantCulture),
        double d => Js.NumberToString(d),
        _ => value.ToString()!,
    };
}
