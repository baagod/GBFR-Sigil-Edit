using System.Text.Json;
using System.Text.Json.Serialization;

namespace GBFR.SigilEdit;

/// <summary>
/// One skill-status override: which row, and the LevelValue slots to write.
///
/// <see cref="Values"/> maps positionally onto the table's LevelValue1..10, which
/// is what a skill's own description uses as {0}, {1}, {2} ... Slots a given skill
/// does not use are simply left at zero. Descriptions are all the information
/// available about a slot's meaning, so it is not modelled here.
/// </summary>
public class SigilTrait
{
    /// <summary>How many LevelValue slots the table has.</summary>
    public const int LevelValueCount = 10;

    public bool Enabled { get; set; } = true;

    /// <summary>skill_status Key as an 8-digit hex hash, e.g. 06719232.</summary>
    public string Key { get; set; } = "";

    /// <summary>The row's Level field: the level the game shows, and where an edit lands.</summary>
    public int Level { get; set; } = 15;

    /// <summary>LevelValue1..10, written in order.</summary>
    public float[] Values { get; set; } = new float[LevelValueCount];
}

/// <summary>
/// The mod's Config.json. Written by the standalone SigilEditTool, read here at
/// startup.
///
/// This type deliberately implements NO Reloaded configuration interface: doing so
/// would make the launcher offer a "Mod configuration" window, and that window
/// cannot render a list (it shows a meaningless Capacity/Count pair). The edit list
/// is managed by the tool instead, so this is plain data.
/// </summary>
public class Config
{
    [JsonPropertyName("Edits")]
    public List<SigilTrait> Edits { get; set; } = [];

    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    /// <summary>
    /// The edit list in <paramref name="path"/>, or an empty one when the file
    /// holds nothing usable. A missing, unreadable or malformed file is left to
    /// throw: the only caller is <see cref="Mod.LoadConfig"/>, which is where the
    /// reason can actually be logged.
    /// </summary>
    public static Config Load(string path)
    {
        var config = JsonSerializer.Deserialize<Config>(File.ReadAllText(path), Options);
        return config?.Edits is { Count: > 0 } ? config : new Config();
    }
}
