using System.Text.Json;

namespace OsuLocalProfiles;

/// <summary>Where the app and its data are: src/config.ts's <c>installDir</c>, <c>dataDir</c> and <c>appVersion</c>.</summary>
internal sealed class AppPaths(string installDir)
{
    /// <summary>The folder the app lives in: <c>data/</c>'s parent, and what an update replaces.</summary>
    public string InstallDir { get; } = installDir;

    /// <summary>The profile database, config.json and the user's images. Never touched by an update.</summary>
    public string DataDir => Path.Combine(InstallDir, "data");

    public string WebRoot => Path.Combine(InstallDir, "web");

    /// <summary>
    /// <paramref name="root"/> when given (<c>--root</c>, for development and the parity script),
    /// otherwise the nearest folder above the executable holding <c>package.json</c> and
    /// <c>web/</c>: the install in a package, the repository in a checkout.
    /// </summary>
    public static AppPaths Resolve(string? root)
    {
        if (root is not null) return new AppPaths(Path.GetFullPath(root));
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            if (File.Exists(Path.Combine(dir.FullName, "package.json")) && Directory.Exists(Path.Combine(dir.FullName, "web")))
            {
                return new AppPaths(dir.FullName);
            }
        }
        return new AppPaths(Path.GetFullPath(AppContext.BaseDirectory));
    }

    /// <summary>
    /// The running version, from <c>package.json</c>. Unknown rather than guessed when it cannot be
    /// read: a wrong version would make the update check offer a downgrade, or hide an update.
    /// </summary>
    public string? Version()
    {
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(InstallDir, "package.json")));
            return doc.RootElement.ValueKind == JsonValueKind.Object
                && doc.RootElement.TryGetProperty("version", out var v) && v.ValueKind == JsonValueKind.String
                ? v.GetString()
                : null;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }
}

/// <summary>
/// <c>data/config.json</c>: what the app reads to boot (src/config.ts, <c>loadConfig</c>).
/// </summary>
/// <remarks>
/// Kept as the JSON values themselves, not typed fields, because the Node app spreads the file
/// over its defaults without checking types and passes some values on as they are
/// (<c>/api/app-config</c>). A typed read would answer differently for a hand-edited file.
/// </remarks>
internal sealed class AppConfig
{
    private readonly Dictionary<string, JsonElement> values;

    private AppConfig(Dictionary<string, JsonElement> values) => this.values = values;

    private static Dictionary<string, JsonElement> Defaults() => new()
    {
        ["profileName"] = JsonText.From("Local Profile"),
        ["port"] = JsonText.From(7272),
        ["openBrowser"] = JsonText.From(true),
        ["installRoots"] = JsonText.From(Array.Empty<string>()),
        ["discoveredRoots"] = JsonText.From(Array.Empty<string>()),
        ["searchedForInstalls"] = JsonText.From(false),
        ["language"] = JsonText.From(""),
        ["originalMetadata"] = JsonText.From(false),
        ["font"] = JsonText.From("nunito"),
        ["country"] = JsonText.From(""),
        ["tagline"] = JsonText.From(""),
        ["checkForUpdates"] = JsonText.From(true),
        ["autoUpdate"] = JsonText.From(false),
        ["sharedFavorites"] = JsonText.From(true),
        ["ppSource"] = JsonText.From(""),
    };

    /// <summary>
    /// Keys older versions wrote that mean nothing now, dropped on load: <c>shareOnNetwork</c>
    /// opened the page to the network (never again), <c>backfill</c> was never honoured.
    /// </summary>
    private static readonly string[] RetiredKeys = ["shareOnNetwork", "backfill"];

    public static AppConfig Load(string dataDir)
    {
        var merged = Defaults();
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(dataDir, "config.json")));
            if (doc.RootElement.ValueKind == JsonValueKind.Object)
            {
                foreach (var property in doc.RootElement.EnumerateObject()) merged[property.Name] = property.Value.Clone();
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException)
        {
            /* first run, or unreadable: fall back to defaults */
        }
        foreach (var key in RetiredKeys) merged.Remove(key);
        return new AppConfig(merged);
    }

    /// <summary>A value as stored, or null when the key is not there at all.</summary>
    public JsonElement? this[string key]
    {
        get => values.TryGetValue(key, out var value) ? value : null;
        set
        {
            if (value is { } v) values[key] = v;
            else values.Remove(key);
        }
    }

    /// <summary>
    /// Written back as <c>JSON.stringify(config, null, 2)</c> and a newline: every key, defaults
    /// included, in the order they were first set.
    /// </summary>
    public void Save(string dataDir)
    {
        Directory.CreateDirectory(dataDir);
        using var output = new MemoryStream();
        using (var writer = new Utf8JsonWriter(output, new JsonWriterOptions
        {
            Indented = true,
            IndentSize = 2,
            NewLine = "\n",
            Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        }))
        {
            JsonSerializer.Serialize(writer, values, JsonText.Options);
        }
        File.WriteAllText(Path.Combine(dataDir, "config.json"), System.Text.Encoding.UTF8.GetString(output.ToArray()) + "\n");
    }

    /// <summary>A config list of text, as the Node app reads one: an array's strings.</summary>
    public List<string> Strings(string key) =>
        this[key] is { ValueKind: JsonValueKind.Array } list
            ? [.. list.EnumerateArray().Where(e => e.ValueKind == JsonValueKind.String).Select(e => e.GetString()!)]
            : [];

    /// <summary>
    /// Remember where osu! was found, so the next start goes there first, and that the search ran:
    /// <c>rememberDiscovery</c>. Written only when something changed.
    /// </summary>
    public void RememberDiscovery(Clients.DiscoveryResult discovery, string dataDir)
    {
        var discovered = discovery.Candidates.Where(c => c.Source != "configured").Select(c => c.Root).ToList();
        // `config.searchedForInstalls || discovery.searched`: the stored value itself when it is truthy.
        var current = this["searchedForInstalls"];
        var searched = Js.Truthy(current) ? current!.Value : JsonText.From(discovery.Searched);
        var searchedSame = Js.Truthy(current) || (!discovery.Searched && current is { ValueKind: JsonValueKind.False });
        var remembered = this["discoveredRoots"];
        var same = searchedSame && remembered is { ValueKind: JsonValueKind.Array } list && list.GetArrayLength() == discovered.Count
            && list.EnumerateArray().Select((e, i) => e.ValueKind == JsonValueKind.String && e.GetString() == discovered[i]).All(x => x);
        if (same) return;
        this["discoveredRoots"] = JsonText.From(discovered);
        this["searchedForInstalls"] = searched;
        Save(dataDir);
    }

    public string ProfileName => this["profileName"] is { } name ? Js.ToJsString(name) : "Local Profile";

    /// <summary>The port, as <c>server.listen</c> would take it.</summary>
    public int Port
    {
        get
        {
            var port = Js.ToNumber(this["port"]);
            return double.IsFinite(port) && port is >= 0 and <= 65535 && port == Math.Floor(port) ? (int)port : 7272;
        }
    }

    /// <summary>What the page may read and change of the install: <c>appConfig.get()</c> in src/main.ts.</summary>
    public Dictionary<string, object?> PageView() => new()
    {
        ["openBrowser"] = this["openBrowser"],
        ["sharedFavorites"] = this["sharedFavorites"],
        ["language"] = this["language"],
        ["originalMetadata"] = this["originalMetadata"],
        // A hand-edited value that is neither is Nunito, the default.
        ["font"] = Js.IsString(this["font"], out var font) && font == "system" ? "system" : "nunito",
        ["autoUpdate"] = this["autoUpdate"] is { ValueKind: JsonValueKind.True },
    };

    /// <summary>
    /// config.json's country and tagline: the fallback for a profile that has never edited them,
    /// not the value (<c>configFallbacks</c> in src/http/server.ts).
    /// </summary>
    public Dictionary<string, JsonElement> SettingsFallbacks()
    {
        var fallbacks = new Dictionary<string, JsonElement>();
        foreach (var key in new[] { "country", "tagline" })
        {
            if (this[key] is { } value) fallbacks[key] = value;
        }
        return fallbacks;
    }
}
