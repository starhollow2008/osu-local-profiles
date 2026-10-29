using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace OsuLocalProfiles.Clients;

/// <summary>
/// One request at a time to osu!, at most one a second, shared by everything the app asks of it:
/// src/clients/request-gate.ts. osu! asks to stay under 60 requests a minute; told to slow down
/// (429), the whole gate waits as long as osu! says before anything else is asked.
/// </summary>
internal sealed class RequestGate(double intervalMs, Func<double>? now = null, Func<double, Task>? sleep = null)
{
    private readonly Func<double> now = now ?? (() => Js.Now());
    private readonly Func<double, Task> sleep = sleep ?? (ms => Task.Delay(TimeSpan.FromMilliseconds(ms)));
    private readonly object gate = new();
    /// <summary>The earliest the next request may start.</summary>
    private double next;
    /// <summary>The turns already promised, so each waits for the one before it.</summary>
    private Task queue = Task.CompletedTask;

    /// <summary>Run <paramref name="task"/> once its turn comes. Turns start the interval apart, in the order asked.</summary>
    public Task<T> Run<T>(Func<Task<T>> task)
    {
        Task turn;
        lock (gate)
        {
            turn = Turn(queue);
            queue = turn;
        }
        return After(turn, task);
    }

    private async Task Turn(Task previous)
    {
        await previous;
        // Read again after each wait: a pause can arrive while this turn is already waiting.
        for (var wait = Next() - now(); wait > 0; wait = Next() - now()) await sleep(wait);
        lock (gate) next = now() + intervalMs;
    }

    private double Next()
    {
        lock (gate) return next;
    }

    private static async Task<T> After<T>(Task turn, Func<Task<T>> task)
    {
        await turn;
        return await task();
    }

    /// <summary>Hold every request still to come: osu! asked the app to slow down.</summary>
    public void PauseFor(double ms)
    {
        lock (gate) next = Math.Max(next, now() + ms);
    }

    /// <summary>The longest a Retry-After is taken at its word, and what a 429 without one waits.</summary>
    public const double MaxPauseMs = 5 * 60_000;
    public const double DefaultPauseMs = 60_000;

    /// <summary>
    /// How long a 429 says to wait: <c>Retry-After</c> in seconds or as a date, held to between a
    /// second and <see cref="MaxPauseMs"/>, or <see cref="DefaultPauseMs"/> when it says nothing usable.
    /// </summary>
    public static double RetryAfterMs(string? header, double now)
    {
        var raw = header is null ? "" : Js.Trim(header);
        var ms = double.NaN;
        if (raw.Length > 0 && raw.All(char.IsAsciiDigit)) ms = Js.StringToNumber(raw) * 1000;
        else if (raw != "") ms = Js.DateParse(raw) - now;
        if (!double.IsFinite(ms)) return DefaultPauseMs;
        return Math.Min(MaxPauseMs, Math.Max(1000, ms));
    }
}

internal sealed record EarnedMedal(string Slug, double AchievedAt);

/// <summary>An osu! account as its public profile page shows it.</summary>
internal sealed record OsuWebUser(
    double Id,
    string Username,
    string? AvatarUrl,
    string? CoverUrl,
    string? CountryCode,
    string? PageRaw,
    List<string> PreviousUsernames,
    List<EarnedMedal> Medals);

internal sealed record BeatmapsetDifficulty(double Id, string Mode, double Stars, string Version);

/// <summary>A beatmapset as the Favorite Beatmaps card draws it, in the order <c>JSON.stringify</c> stores it.</summary>
internal sealed record BeatmapsetDetails(
    double Id,
    string Title,
    string Artist,
    string? TitleUnicode,
    string? ArtistUnicode,
    string Creator,
    double UserId,
    string Status,
    bool Nsfw,
    bool Spotlight,
    bool FeaturedArtist,
    bool Video,
    bool Storyboard,
    double FavouriteCount,
    double PlayCount,
    string? Date,
    List<BeatmapsetDifficulty> Difficulties);

/// <summary>
/// A score as osu! holds it, reduced to what a <c>scores</c> row needs: src/clients/osu-web.ts's
/// <c>OsuWebScore</c>. Ids are text, as the app stores them.
/// </summary>
internal sealed record OsuWebScore(
    string Id,
    string? LegacyScoreId,
    double Mode,
    string BeatmapMD5,
    double BeatmapId,
    double? BeatmapsetId,
    string? Artist,
    string? Title,
    string? Version,
    string? Creator,
    int MapStatus,
    double? BeatmapStars,
    List<JsonElement> Mods,
    Dictionary<string, double> Statistics,
    Dictionary<string, double> MaximumStatistics,
    double Accuracy,
    double MaxCombo,
    double TotalScore,
    double? ClassicTotalScore,
    double? LegacyTotalScore,
    string Grade,
    bool Passed,
    bool LegacyPerfect,
    bool Ranked,
    double? Pp,
    double PlayedAt,
    double? WeightPercentage);

/// <summary>A score as its page gives it, with who set it.</summary>
internal sealed record LinkedScore(OsuWebScore Score, LinkedPlayer Player);

internal sealed record LinkedPlayer(double? Id, string Name);

/// <summary>What osu! says an account stands at, for one ruleset.</summary>
internal sealed record OsuWebStanding(double? TotalPp, double? GlobalRank, double? CountryRank);

/// <summary>One of an account's rank events, as its profile's Recent lists them.</summary>
internal sealed record RankEvent(double Id, double At, double Rank, string Grade, int Mode, double BeatmapId);

internal sealed record DownloadedImage(byte[] Bytes, string Extension);

/// <summary>osu! answered, and has no account by that name or id, as opposed to not answering at all.</summary>
internal sealed class NoSuchUser(string message) : Exception(message);

/// <summary>osu! still asked the app to slow down after it waited as long as osu! said.</summary>
internal sealed class SlowDown() : Exception("osu! asked this app to slow down; try again in a few minutes");

/// <summary>
/// osu!'s public website, read with no credentials and no API: src/clients/osu-web.ts. Every
/// request runs because a button was pressed (or after a play, for rank events), goes through one
/// gate, and fails with a message worth showing. The pages are a private detail of osu-web, so
/// one in any other shape is refused rather than half-read.
/// </summary>
internal sealed partial class OsuWeb
{
    /// <summary>How long to wait for an answer before giving up.</summary>
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    /// <summary>Avatars and covers are small; anything larger is a sign of a wrong URL.</summary>
    private const int MaxImageBytes = 8 * 1024 * 1024;

    private const string UserAgent = "osu-local-profiles (local profile tracker; one request per user action)";

    /// <summary>How many times a request told to slow down (429) is asked again, after the wait osu! asks.</summary>
    private const int SlowDownRetries = 2;

    private readonly HttpClient http;
    private readonly RequestGate gate;

    public OsuWeb(HttpMessageHandler handler, RequestGate gate)
    {
        http = new HttpClient(handler) { Timeout = System.Threading.Timeout.InfiniteTimeSpan };
        this.gate = gate;
    }

    /// <summary>The one the app uses: every request it makes to osu!, one a second at most.</summary>
    public static OsuWeb Shared { get; } = new(
        new SocketsHttpHandler { AllowAutoRedirect = true, AutomaticDecompression = DecompressionMethods.All },
        new RequestGate(1000));

    /// <summary>An answer, read as <c>fetch</c> leaves it: status, headers, and the body once asked for.</summary>
    internal sealed class Answer(HttpResponseMessage response)
    {
        public int Status => (int)response.StatusCode;
        public bool Ok => Status is >= 200 and <= 299;

        public string? Header(string name) =>
            response.Headers.TryGetValues(name, out var values) || response.Content.Headers.TryGetValues(name, out values)
                ? string.Join(", ", values)
                : null;

        public Task<byte[]> Bytes() => response.Content.ReadAsByteArrayAsync();

        /// <summary><c>response.text()</c>: UTF-8 whatever the headers say, a byte-order mark dropped.</summary>
        public async Task<string> Text()
        {
            var text = new UTF8Encoding(false).GetString(await Bytes());
            return text.StartsWith((char)0xFEFF) ? text[1..] : text;
        }
    }

    /// <summary>
    /// One request through the gate. The timeout runs from when the request starts, not while it
    /// waits its turn, and covers the answer's headers. Told to slow down, the whole gate waits.
    /// </summary>
    private async Task<Answer> FetchWithTimeout(string url, string accept)
    {
        for (var attempt = 0; ; attempt++)
        {
            var response = await gate.Run(async () =>
            {
                using var cancel = new CancellationTokenSource(Timeout);
                var request = new HttpRequestMessage(HttpMethod.Get, url);
                request.Headers.TryAddWithoutValidation("accept", accept);
                request.Headers.TryAddWithoutValidation("user-agent", UserAgent);
                return new Answer(await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancel.Token));
            });
            if (response.Status != 429) return response;
            gate.PauseFor(RequestGate.RetryAfterMs(response.Header("retry-after"), Js.Now()));
            if (attempt >= SlowDownRetries) throw new SlowDown();
        }
    }

    /// <summary>The request, or why it could not be made: osu! asking to slow down says so, anything else is <paramref name="message"/>.</summary>
    private async Task<Answer> Fetch(string url, string accept, string message)
    {
        try
        {
            return await FetchWithTimeout(url, accept);
        }
        catch (SlowDown)
        {
            throw;
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            throw new InvalidOperationException(message, e);
        }
    }

    private static Exception Answered(int status) => new InvalidOperationException($"osu.ppy.sh answered {status}");

    /* ------------------------------------------------------------- reading values */

    private static string? Str(JsonElement? v) => v is { ValueKind: JsonValueKind.String } s ? s.GetString() : null;

    private static double? Num(JsonElement? v) => v is { ValueKind: JsonValueKind.Number } n && Js.NumberOf(n) is var d && double.IsFinite(d) ? d : null;

    /// <summary>A score id as the text it is stored as, or null for one <c>JSON.parse</c> had to round.</summary>
    private static string? Id(JsonElement? v) =>
        v is { ValueKind: JsonValueKind.Number } n && Js.NumberOf(n) is var d && d == Math.Floor(d) && Math.Abs(d) <= 9007199254740991
            ? Js.NumberToString(d)
            : null;

    /// <summary><c>JSON.parse</c>, or null where it would throw.</summary>
    private static JsonElement? Parse(string text) => JsonText.TryParse(text, out var value) ? value : null;

    /// <summary>Undo the HTML escaping osu-web applies to the <c>data-initial-data</c> attribute.</summary>
    private static string DecodeInitialData(string attribute) => attribute
        .Replace("&quot;", "\"")
        .Replace("&#039;", "'")
        .Replace("&apos;", "'")
        .Replace("&lt;", "<")
        .Replace("&gt;", ">")
        // & last, or it would corrupt the entities decoded above.
        .Replace("&amp;", "&");

    [GeneratedRegex("data-initial-data=\"([^\"]*)\"")]
    private static partial Regex InitialData();

    /* -------------------------------------------------------------------- users */

    /// <summary>
    /// The medals an account holds: <c>user.user_achievements</c> by osu!'s numeric id, named by the
    /// page's own <c>achievements</c> list. One the list does not name, or with no readable date, is left out.
    /// </summary>
    public static List<EarnedMedal> EarnedMedals(JsonElement payload)
    {
        var slugs = new Dictionary<double, string>();
        if (Js.Get(payload, "achievements") is { ValueKind: JsonValueKind.Array } achievements)
        {
            foreach (var a in achievements.EnumerateArray())
            {
                if (Num(Js.Get(a, "id")) is { } id && Js.Get(a, "id")!.Value.ValueKind == JsonValueKind.Number
                    && Str(Js.Get(a, "slug")) is { } slug)
                {
                    slugs[id] = slug;
                }
            }
        }
        var output = new List<EarnedMedal>();
        if (Js.Get(Js.Get(payload, "user"), "user_achievements") is { ValueKind: JsonValueKind.Array } held)
        {
            foreach (var u in held.EnumerateArray())
            {
                var slug = Num(Js.Get(u, "achievement_id")) is { } id ? slugs.GetValueOrDefault(id) : null;
                var achievedAt = Str(Js.Get(u, "achieved_at")) is { } at ? Js.DateParse(at) : double.NaN;
                if (slug is not null && double.IsFinite(achievedAt)) output.Add(new EarnedMedal(slug, achievedAt));
            }
        }
        return output;
    }

    [GeneratedRegex(@"osu\.ppy\.sh/(?:users|u)/([^/?#\s]+)", RegexOptions.IgnoreCase)]
    private static partial Regex ProfileUrl();

    // JavaScript's \w is ASCII.
    [GeneratedRegex(@"^[A-Za-z0-9_ \-\[\]]{1,32}\z")]
    private static partial Regex UsernameShape();

    /// <summary>
    /// Whatever the user pasted, reduced to what osu! can look up: an id, a username, or a profile
    /// link. Null when there is nothing usable. A malformed escape in it throws, as JavaScript's does.
    /// </summary>
    public static string? ParseUserQuery(string? input)
    {
        var raw = Js.Trim(input ?? "");
        if (raw.Length == 0) return null;
        var fromUrl = ProfileUrl().Match(raw);
        var candidate = Js.DecodeUriComponent(fromUrl.Success ? fromUrl.Groups[1].Value : raw);
        return UsernameShape().IsMatch(candidate) ? candidate : null;
    }

    /// <summary>The public user object osu-web renders the profile page from, or null when the page is not in that shape.</summary>
    public static OsuWebUser? ExtractUser(string html)
    {
        var match = InitialData().Match(html);
        if (!match.Success) return null;
        if (Parse(DecodeInitialData(match.Groups[1].Value)) is not { } payload) return null;
        var user = Js.Get(payload, "user");
        if (user is not { ValueKind: JsonValueKind.Object } || Js.Get(user, "id") is not { ValueKind: JsonValueKind.Number } idElement) return null;
        var id = Js.NumberOf(idElement);
        var country = Js.Get(user, "country");
        var page = Js.Get(user, "page");
        var pageRaw = Str(Js.Get(page, "raw"));
        return new OsuWebUser(
            id,
            Str(Js.Get(user, "username")) ?? Js.NumberToString(id),
            Str(Js.Get(user, "avatar_url")),
            Str(Js.Get(user, "cover_url")),
            Str(Js.Get(user, "country_code")) ?? Str(Js.Get(country, "code")),
            pageRaw is not null && Js.Trim(pageRaw) != "" ? pageRaw : null,
            Js.Get(user, "previous_usernames") is { ValueKind: JsonValueKind.Array } previous
                ? [.. previous.EnumerateArray().Select(n => Str(n)).Where(n => !string.IsNullOrEmpty(n)).Select(n => n!)]
                : [],
            EarnedMedals(payload));
    }

    /// <summary>Look up one osu! account, on an explicit press. Throws with a message worth showing.</summary>
    public async Task<OsuWebUser> LookupUser(string query)
    {
        var clean = ParseUserQuery(query)
            ?? throw new InvalidOperationException("that does not look like an osu! username, user id or profile link");
        var response = await Fetch($"https://osu.ppy.sh/users/{Uri.EscapeDataString(clean)}", "text/html",
            "could not reach osu.ppy.sh -- check your connection, or type a name instead");
        if (response.Status == 404) throw new NoSuchUser($"osu! has no user called \"{clean}\"");
        if (!response.Ok) throw Answered(response.Status);
        return ExtractUser(await response.Text()) ?? throw new InvalidOperationException(
            "osu.ppy.sh answered, but its profile page was not in the expected shape. Upload an image and type a name instead.");
    }

    private static readonly Dictionary<string, string> ExtensionFor = new(StringComparer.Ordinal)
    {
        ["image/png"] = ".png",
        ["image/jpeg"] = ".jpg",
        ["image/webp"] = ".webp",
        ["image/gif"] = ".gif",
    };

    /// <summary>Fetch one image, to be copied into <c>data/</c> and served from there from then on.</summary>
    public async Task<DownloadedImage> DownloadImage(string url)
    {
        var response = await Fetch(url, "image/*", "could not download that image");
        if (!response.Ok) throw new InvalidOperationException($"downloading the image failed ({response.Status})");
        var type = Js.ToLower(Js.Trim((response.Header("content-type") ?? "").Split(';')[0]));
        if (!ExtensionFor.TryGetValue(type, out var extension))
        {
            throw new InvalidOperationException($"that is not an image this can use ({(type.Length > 0 ? type : "unknown type")})");
        }
        var bytes = await response.Bytes();
        if (bytes.Length == 0) throw new InvalidOperationException("that image was empty");
        if (bytes.Length > MaxImageBytes) throw new InvalidOperationException("that image is too large (8MB max)");
        return new DownloadedImage(bytes, extension);
    }

    /* -------------------------------------------------------------- beatmapsets */

    private static readonly string[] Modes = ["osu", "taiko", "fruits", "mania"];

    /// <summary>Statuses whose card shows <c>ranked_date</c>; the rest show <c>last_updated</c>.</summary>
    private static readonly HashSet<string> RankedDateStatuses = ["ranked", "approved", "loved", "qualified"];

    [GeneratedRegex(@"<script id=""json-beatmapset"" type=""application/json"">\s*([\s\S]*?)\s*</script>")]
    private static partial Regex BeatmapsetScript();

    /// <summary>The beatmapset osu-web renders its page from, reduced to what the card draws, or null.</summary>
    public static BeatmapsetDetails? ExtractBeatmapset(string html)
    {
        var match = BeatmapsetScript().Match(html);
        return match.Success && Parse(match.Groups[1].Value) is { } raw ? BeatmapsetFromJson(raw) : null;
    }

    /// <summary>One beatmapset object as osu-web serialises it (its page, or a favourites list), or null if it is not one.</summary>
    public static BeatmapsetDetails? BeatmapsetFromJson(JsonElement raw)
    {
        if (Num(Js.Get(raw, "id")) is not { } id || Str(Js.Get(raw, "title")) is not { } title
            || Str(Js.Get(raw, "artist")) is not { } artist || Str(Js.Get(raw, "status")) is not { } status)
        {
            return null;
        }
        var difficulties = new List<BeatmapsetDifficulty>();
        if (Js.Get(raw, "beatmaps") is { ValueKind: JsonValueKind.Array } beatmaps)
        {
            foreach (var b in beatmaps.EnumerateArray())
            {
                var mode = Str(Js.Get(b, "mode"));
                if (mode is null || !Modes.Contains(mode) || Num(Js.Get(b, "id")) is not { } bid
                    || Num(Js.Get(b, "difficulty_rating")) is not { } stars || Str(Js.Get(b, "version")) is not { } version)
                {
                    continue;
                }
                difficulties.Add(new BeatmapsetDifficulty(bid, mode, stars, version));
            }
        }
        var date = RankedDateStatuses.Contains(status) ? Str(Js.Get(raw, "ranked_date")) : Str(Js.Get(raw, "last_updated"));
        return new BeatmapsetDetails(
            id, title, artist,
            Str(Js.Get(raw, "title_unicode")),
            Str(Js.Get(raw, "artist_unicode")),
            Str(Js.Get(raw, "creator")) ?? "",
            Num(Js.Get(raw, "user_id")) ?? 0,
            status,
            Js.Get(raw, "nsfw") is { ValueKind: JsonValueKind.True },
            Js.Get(raw, "spotlight") is { ValueKind: JsonValueKind.True },
            Js.Get(raw, "track_id") is { ValueKind: not JsonValueKind.Null },
            Js.Get(raw, "video") is { ValueKind: JsonValueKind.True },
            Js.Get(raw, "storyboard") is { ValueKind: JsonValueKind.True },
            Num(Js.Get(raw, "favourite_count")) ?? 0,
            Num(Js.Get(raw, "play_count")) ?? 0,
            date ?? Str(Js.Get(raw, "last_updated")),
            difficulties);
    }

    private static bool IsWholePositive(double n) => double.IsFinite(n) && n == Math.Floor(n) && n > 0;

    private const int FavouritesPage = 100;

    /// <summary>
    /// Every beatmapset an account has favourited, newest first, a hundred a request until a page
    /// comes back empty or adds nothing new. <paramref name="onPage"/> hears how many are read so far.
    /// </summary>
    public async Task<List<BeatmapsetDetails>> FetchFavouriteBeatmapsets(double userId, Action<int>? onPage = null)
    {
        if (!IsWholePositive(userId)) throw new InvalidOperationException("not a user id");
        const string shapeError = "the favourites were not in the shape expected; osu! may have changed them";
        var sets = new List<BeatmapsetDetails>();
        var seen = new HashSet<double>();
        var offset = 0;
        while (true)
        {
            var response = await Fetch(
                $"https://osu.ppy.sh/users/{Js.NumberToString(userId)}/beatmapsets/favourite?limit={FavouritesPage}&offset={offset}",
                "application/json", "could not reach osu.ppy.sh");
            if (!response.Ok) throw Answered(response.Status);
            if (Parse(await response.Text()) is not { ValueKind: JsonValueKind.Array } list) throw new InvalidOperationException(shapeError);
            if (list.GetArrayLength() == 0) break;
            var before = seen.Count;
            foreach (var raw in list.EnumerateArray())
            {
                if (raw.ValueKind == JsonValueKind.Object && BeatmapsetFromJson(raw) is { } set && seen.Add(set.Id)) sets.Add(set);
            }
            onPage?.Invoke(sets.Count);
            if (seen.Count == before) break;
            offset += list.GetArrayLength();
        }
        return sets;
    }

    /// <summary>One request for one beatmapset, because the user favourited it.</summary>
    public async Task<BeatmapsetDetails> FetchBeatmapset(double beatmapsetId)
    {
        if (!IsWholePositive(beatmapsetId)) throw new InvalidOperationException("not a beatmapset id");
        var response = await Fetch($"https://osu.ppy.sh/beatmapsets/{Js.NumberToString(beatmapsetId)}", "text/html", "could not reach osu.ppy.sh");
        if (response.Status == 404) throw new InvalidOperationException("osu! has no beatmapset with that id");
        if (!response.Ok) throw Answered(response.Status);
        return ExtractBeatmapset(await response.Text())
            ?? throw new InvalidOperationException("the beatmapset page was not in the shape expected; osu! may have changed it");
    }

    /* --------------------------------------------------------- one score, by link */

    [GeneratedRegex(@"^[0-9]{1,19}\z")]
    private static partial Regex BareScoreId();

    [GeneratedRegex(@"^(?:https?://)?(?:www\.|lazer\.)?osu\.ppy\.sh/scores/(?:(osu|taiko|fruits|mania)/)?([0-9]{1,19})/?(?:[?#].*)?\z", RegexOptions.IgnoreCase)]
    private static partial Regex ScoreLinkShape();

    /// <summary>
    /// Where osu! shows one score: a bare number is a solo id, and the ruleset form (a legacy id)
    /// is kept exactly as it came, since the same number under the other form is another score.
    /// </summary>
    public static string? ParseScoreLink(string input)
    {
        var text = Js.Trim(input);
        if (BareScoreId().IsMatch(text)) return $"scores/{text}";
        var match = ScoreLinkShape().Match(text);
        if (!match.Success) return null;
        return match.Groups[1].Success ? $"scores/{Js.ToLower(match.Groups[1].Value)}/{match.Groups[2].Value}" : $"scores/{match.Groups[2].Value}";
    }

    [GeneratedRegex(@"<script id=""json-show"" type=""application/json"">([\s\S]*?)</script>")]
    private static partial Regex ScorePageScript();

    /// <summary>The score a score page embeds, with who set it, or null when it has none in that shape.</summary>
    public static LinkedScore? ExtractScorePage(string html)
    {
        var match = ScorePageScript().Match(html);
        if (!match.Success || Parse(match.Groups[1].Value) is not { } raw || ScoreFromJson(raw) is not { } score) return null;
        var user = Js.Get(raw, "user");
        var id = Js.Get(raw, "user_id") is { ValueKind: JsonValueKind.Number } n ? Js.NumberOf(n) : (double?)null;
        return new LinkedScore(score, new LinkedPlayer(id, Str(Js.Get(user, "username")) ?? ""));
    }

    /// <summary>One score, from its link, asked of its public page.</summary>
    public async Task<LinkedScore> FetchLinkedScore(string input)
    {
        var where = ParseScoreLink(input) ?? throw new InvalidOperationException("that is not a link to a score on osu.ppy.sh");
        var response = await Fetch($"https://osu.ppy.sh/{where}", "text/html", "could not reach osu.ppy.sh");
        if (response.Status == 404) throw new InvalidOperationException("osu! has no score at that link -- it may have been replaced by a better one");
        if (!response.Ok) throw Answered(response.Status);
        return ExtractScorePage(await response.Text())
            ?? throw new InvalidOperationException("the score page was not in the shape expected; osu! may have changed it");
    }

    /// <summary>A beatmap's <c>.osu</c> file, as osu! serves it to anyone. Whether it is the right version is the caller's to check.</summary>
    public async Task<byte[]> FetchBeatmapFile(double beatmapId)
    {
        if (!IsWholePositive(beatmapId)) throw new InvalidOperationException("not a beatmap id");
        var response = await Fetch($"https://osu.ppy.sh/osu/{Js.NumberToString(beatmapId)}", "text/plain", "could not reach osu.ppy.sh");
        if (response.Status == 404) throw new InvalidOperationException("osu! has no beatmap with that id");
        if (!response.Ok) throw Answered(response.Status);
        return await response.Bytes();
    }

    /* ------------------------------------------------------------------- scores */

    /// <summary>osu-web's status names, to osu!'s <c>approved</c> enum.</summary>
    private static readonly Dictionary<string, int> StatusForName = new(StringComparer.Ordinal)
    {
        ["graveyard"] = -2, ["wip"] = -1, ["pending"] = 0, ["ranked"] = 1, ["approved"] = 2, ["qualified"] = 3, ["loved"] = 4,
    };

    public static string OsuWebMode(double mode) => Modes[(int)mode];

    /// <summary>Finite numbers of an object (or a list's), in the order <c>Object.entries</c> gives them.</summary>
    private static Dictionary<string, double> Counts(JsonElement? v)
    {
        var output = new Dictionary<string, double>(StringComparer.Ordinal);
        if (v is not { ValueKind: JsonValueKind.Object or JsonValueKind.Array } value) return output;
        foreach (var (key, item) in Js.Entries(value))
        {
            if (Num(item) is { } n) output[key] = n;
        }
        return output;
    }

    /// <summary>
    /// One score object as osu-web serialises it, or null if it is not one. A score with no usable
    /// id is dropped: it could never be matched to its replay.
    /// </summary>
    public static OsuWebScore? ScoreFromJson(JsonElement raw)
    {
        var ruleset = Num(Js.Get(raw, "ruleset_id"));
        var beatmap = Js.Get(raw, "beatmap");
        var set = Js.Get(raw, "beatmapset");
        var checksum = Str(Js.Get(beatmap, "checksum"));
        var beatmapId = Num(Js.Get(beatmap, "id")) ?? Num(Js.Get(raw, "beatmap_id"));
        var endedAt = Str(Js.Get(raw, "ended_at"));
        var grade = Str(Js.Get(raw, "rank"));
        var acc = Num(Js.Get(raw, "accuracy"));

        if (Id(Js.Get(raw, "id")) is not { } soloId) return null;
        if (ruleset is not { } mode || mode < 0 || mode > 3) return null;
        if (checksum is null || beatmapId is null || endedAt is null) return null;
        if (grade is null || acc is null) return null;
        var playedAt = Js.DateParse(endedAt);
        if (!double.IsFinite(playedAt)) return null;

        var mods = new List<JsonElement>();
        if (Js.Get(raw, "mods") is { ValueKind: JsonValueKind.Array } list)
        {
            foreach (var m in list.EnumerateArray())
            {
                if (Str(Js.Get(m, "acronym")) is not { } acronym) continue;
                var settings = Js.Get(m, "settings");
                mods.Add(settings is { ValueKind: JsonValueKind.Object or JsonValueKind.Array } s
                    ? JsonText.From(new Dictionary<string, object?> { ["acronym"] = acronym, ["settings"] = s })
                    : JsonText.From(new Dictionary<string, object?> { ["acronym"] = acronym }));
            }
        }

        var statusName = Str(Js.Get(beatmap, "status"));
        return new OsuWebScore(
            soloId,
            Id(Js.Get(raw, "legacy_score_id")),
            mode,
            checksum,
            beatmapId.Value,
            Num(Js.Get(beatmap, "beatmapset_id")) ?? Num(Js.Get(set, "id")),
            Str(Js.Get(set, "artist")),
            Str(Js.Get(set, "title")),
            Str(Js.Get(beatmap, "version")),
            Str(Js.Get(set, "creator")),
            // A status osu! has since renamed counts as unresolved rather than as ranked.
            statusName is not null && StatusForName.TryGetValue(statusName, out var status) ? status : Calc.Status.Unresolved,
            Num(Js.Get(beatmap, "difficulty_rating")),
            mods,
            Counts(Js.Get(raw, "statistics")),
            Counts(Js.Get(raw, "maximum_statistics")),
            acc.Value,
            Num(Js.Get(raw, "max_combo")) ?? 0,
            Num(Js.Get(raw, "total_score")) ?? 0,
            Num(Js.Get(raw, "classic_total_score")),
            Num(Js.Get(raw, "legacy_total_score")),
            grade,
            Js.Get(raw, "passed") is { ValueKind: JsonValueKind.True },
            Js.Get(raw, "legacy_perfect") is { ValueKind: JsonValueKind.True },
            Js.Get(raw, "ranked") is { ValueKind: JsonValueKind.True },
            Num(Js.Get(raw, "pp")),
            playedAt,
            Num(Js.Get(Js.Get(raw, "weight"), "percentage")));
    }

    private const int ScoresPage = 100;
    private const int MaxScorePages = 20;

    /// <summary>One page-by-page read of a user's best or pinned scores, until a page comes back empty.</summary>
    private async Task<List<OsuWebScore>> FetchScoreList(double userId, string list, double mode)
    {
        if (!IsWholePositive(userId)) throw new InvalidOperationException("not a user id");
        const string shapeError = "the scores were not in the shape expected; osu! may have changed them";
        var scores = new List<OsuWebScore>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var offset = 0;
        for (var page = 0; page < MaxScorePages; page++)
        {
            var response = await Fetch(
                $"https://osu.ppy.sh/users/{Js.NumberToString(userId)}/scores/{list}?mode={OsuWebMode(mode)}&limit={ScoresPage}&offset={offset}",
                "application/json", "could not reach osu.ppy.sh");
            if (!response.Ok) throw Answered(response.Status);
            if (Parse(await response.Text()) is not { ValueKind: JsonValueKind.Array } items) throw new InvalidOperationException(shapeError);
            if (items.GetArrayLength() == 0) break;
            foreach (var raw in items.EnumerateArray())
            {
                if (raw.ValueKind == JsonValueKind.Object && ScoreFromJson(raw) is { } score && seen.Add(score.Id)) scores.Add(score);
            }
            // Advanced by what osu! returned, so a short page still walks on.
            offset += items.GetArrayLength();
        }
        return scores;
    }

    /// <summary>An account's best performances for one ruleset, in osu!'s own order, which the weighting depends on.</summary>
    public Task<List<OsuWebScore>> FetchBestPerformances(double userId, double mode) => FetchScoreList(userId, "best", mode);

    /// <summary>The scores an account has pinned to its profile, in the order osu! lists them.</summary>
    public Task<List<OsuWebScore>> FetchPinnedScores(double userId, double mode) => FetchScoreList(userId, "pinned", mode);

    /// <summary>osu!'s own total pp and global rank for one ruleset, read for the bonus pp an import cannot work out.</summary>
    public async Task<OsuWebStanding> FetchStanding(double userId, double mode)
    {
        if (!IsWholePositive(userId)) throw new InvalidOperationException("not a user id");
        var response = await Fetch($"https://osu.ppy.sh/users/{Js.NumberToString(userId)}/{OsuWebMode(mode)}", "text/html", "could not reach osu.ppy.sh");
        if (!response.Ok) throw Answered(response.Status);
        return ExtractStanding(await response.Text());
    }

    /// <summary>The <c>statistics</c> block of the profile payload; every field optional.</summary>
    public static OsuWebStanding ExtractStanding(string html)
    {
        var empty = new OsuWebStanding(null, null, null);
        var match = InitialData().Match(html);
        if (!match.Success || Parse(DecodeInitialData(match.Groups[1].Value)) is not { } payload) return empty;
        var stats = Js.Get(Js.Get(payload, "user"), "statistics");
        if (!Js.Truthy(stats)) return empty;
        return new OsuWebStanding(Num(Js.Get(stats, "pp")), Num(Js.Get(stats, "global_rank")), Num(Js.Get(stats, "country_rank")));
    }

    private static readonly Dictionary<string, int> RulesetForMode = new(StringComparer.Ordinal) { ["osu"] = 0, ["taiko"] = 1, ["fruits"] = 2, ["mania"] = 3 };

    [GeneratedRegex(@"/beatmaps/([0-9]+)")]
    private static partial Regex BeatmapUrl();

    /// <summary>The rank events in a recent-activity page; anything else it lists is left.</summary>
    public static List<RankEvent> RankEventsFromJson(JsonElement? list)
    {
        var output = new List<RankEvent>();
        if (list is not { ValueKind: JsonValueKind.Array } items) return output;
        foreach (var raw in items.EnumerateArray())
        {
            if (raw.ValueKind != JsonValueKind.Object || Str(Js.Get(raw, "type")) != "rank") continue;
            var url = Js.Get(Js.Get(raw, "beatmap"), "url") is { ValueKind: not JsonValueKind.Null } u ? Js.ToJsString(u) : "";
            var found = BeatmapUrl().Match(url);
            var beatmapId = found.Success ? Js.StringToNumber(found.Groups[1].Value) : double.NaN;
            var created = Js.Get(raw, "createdAt") is { ValueKind: not JsonValueKind.Null } c ? c
                : Js.Get(raw, "created_at") is { ValueKind: not JsonValueKind.Null } c2 ? c2 : (JsonElement?)null;
            var at = Js.DateParse(created is { } when ? Js.ToJsString(when) : "");
            var modeName = Js.Get(raw, "mode") is { } m ? Js.ToJsString(m) : "undefined";
            if (Js.Get(raw, "id") is not { ValueKind: JsonValueKind.Number } id || Js.Get(raw, "rank") is not { ValueKind: JsonValueKind.Number } rank
                || Str(Js.Get(raw, "scoreRank")) is not { } grade)
            {
                continue;
            }
            if (!RulesetForMode.TryGetValue(modeName, out var mode) || !IsWholePositive(beatmapId) || !double.IsFinite(at)) continue;
            output.Add(new RankEvent(Js.NumberOf(id), at, Js.NumberOf(rank), grade, mode, beatmapId));
        }
        return output;
    }

    /// <summary>An account's latest rank events: one request, for the 100 newest events of every kind.</summary>
    public async Task<List<RankEvent>> FetchRankEvents(double userId)
    {
        if (!IsWholePositive(userId)) throw new InvalidOperationException("not a user id");
        var response = await Fetch($"https://osu.ppy.sh/users/{Js.NumberToString(userId)}/recent_activity?limit=100&offset=0",
            "application/json", "could not reach osu.ppy.sh");
        if (!response.Ok) throw Answered(response.Status);
        if (Parse(await response.Text()) is not { } list)
        {
            throw new InvalidOperationException("the recent activity was not in the shape expected; osu! may have changed it");
        }
        return RankEventsFromJson(list);
    }
}
