using gbfrelink.utility.manager.Interfaces;
using Reloaded.Mod.Interfaces;
using Reloaded.Mod.Interfaces.Internal;

namespace GBFR.SkillEdit;

/// <summary>
/// Patches rows of skill_status.tbl at startup, driven by a user-editable
/// Config.json, and feeds the table back through IDataManager.
///
/// No static .tbl ships with the mod: the table is read from the game archive,
/// edited in memory, and written back.
///
/// Row layout (verified against the file):
///   - 48-byte header. Proven by phase analysis: all 15 occurrences of Key
///     0x06719232 sit at absolute offsets congruent to 48 (mod 52), and no other
///     phase matches any of them. So rows begin at 48 + 52k.
///   - Rows of 52 bytes:
///       +0   uint   Key (skill hash)
///       +4   uint   LevelDescription
///       +8   uint   Level
///       +12  float  LevelValue1
///       +16  float  LevelValue2
///       +20  float  LevelValue3
///       +24  float  LevelValue4 ... through +48 (LevelValue10)
///
/// The stored Level is one lower than the level shown in game: the row carrying a
/// sigil's real numbers has Level == 14 and is displayed as Lv 15.
/// </summary>
public class Mod : IMod
{
    private const string TablePath = "system/table/skill_status.tbl";
    private const int HeaderSize = 48;
    private const int RowSize = 52;
    private const int LevelOffset = 8;
    private const int Value1Offset = 12;

    private const string ConfigFileName = "Config.json";
    private const string ModId = "GBFR.SkillEdit";
    private const string LogFileName = "GBFR.SkillEdit.log";

    // The edit list lives in %APPDATA%\GBFR.SkillEdit, which the tool writes and
    // this reads. Chosen over %TEMP%, which a disk cleanup empties - the edit list
    // is the user's data - and over the mod's own folder under Mods\, which would
    // mean two places holding state. ApplicationData cannot fail to resolve, so
    // both sides compute the same folder directly.
    private static readonly string ConfigDir =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), ModId);

    private static readonly string ConfigFile = Path.Combine(ConfigDir, ConfigFileName);

    // Where Log() appends. Empty until Start() resolves it, and empty for the
    // whole run if the loader cannot name the folder, in which case there is no
    // log at all.
    private static string _logFile = string.Empty;

    // Whether this run has written its first line yet, so the file is started over
    // once per launch instead of growing across every launch.
    private static bool _logStarted;

    private ILogger _logger = null!;
    private IModLoader _loader = null!;
    private Config _config = new();

    public void Start(IModLoaderV1 loaderApi)
    {
        _loader = (IModLoader)loaderApi;
        _logger = (ILogger)_loader.GetLogger();

        UseModDirectoryForLog();

        Log("=== GBFR.SkillEdit start (config-driven) ===");

        try
        {
            _config = LoadConfig();

            if (!_loader.GetController<IDataManager>().TryGetTarget(out var dm) || dm is null)
            {
                Log("FAIL: IDataManager controller not found (is gbfrelink.utility.manager enabled?)");
                return;
            }

            var file = dm.GetArchiveFile(TablePath);
            if (file is null || file.Length == 0)
            {
                Log($"FAIL: GetArchiveFile('{TablePath}') returned nothing");
                return;
            }
            Log($"read {file.Length} bytes");

            var applied = 0;
            foreach (var edit in _config.Edits)
            {
                if (!edit.Enabled)
                {
                    Log($"  skip (disabled): {edit.Key}");
                    continue;
                }

                if (!uint.TryParse(edit.Key, System.Globalization.NumberStyles.HexNumber, null, out var key))
                {
                    Log($"  skip (key is not an 8-digit hex hash yet): {edit.Key}");
                    continue;
                }

                if (PatchRow(file, key, (uint)edit.Level, edit.Values))
                    applied++;
            }

            if (applied == 0)
            {
                Log($"no edits applied (config held {_config.Edits.Count} edit(s)); not writing the table back");
                return;
            }

            dm.AddOrUpdateExternalFile(TablePath, file);
            dm.UpdateIndex();
            Log($"SUCCESS: {applied} edit(s) applied and table written back");
        }
        catch (Exception ex)
        {
            Log("EXCEPTION: " + ex);
        }
    }

    private Config LoadConfig()
    {
        try
        {
            var path = ConfigFile;
            Log($"config path: {path}");

            // Say which of the two failures this is. "no edits applied" alone
            // cannot be told apart from "every edit is switched off", and the
            // answer decides whether the tool is writing to the wrong folder.
            if (!File.Exists(path))
            {
                Log($"FAIL: no Config.json at {path} (the tool writes the edit list here)");
                return new Config();
            }

            var config = Config.Load(path);
            Log($"config loaded: {config.Edits.Count} edit(s)");
            return config;
        }
        catch (Exception ex)
        {
            Log("config load failed, using defaults: " + ex);
        }
        return new Config();
    }

    /// <summary>
    /// Walks the table at its 52-byte stride, matches (Key, Level), and writes
    /// <paramref name="values"/> over LevelValue1..N. Missing trailing values are
    /// written as zero so the row ends up exactly as the tool described it.
    /// </summary>
    private static bool PatchRow(byte[] data, uint key, uint level, float[] values)
    {
        for (var offset = HeaderSize; offset <= data.Length - RowSize; offset += RowSize)
        {
            if (BitConverter.ToUInt32(data, offset) != key)
                continue;
            if (BitConverter.ToUInt32(data, offset + LevelOffset) != level)
                continue;

            var at = offset + Value1Offset;
            var before = string.Join(" / ", Enumerable.Range(0, SkillEdit.LevelValueCount)
                .Select(i => BitConverter.ToSingle(data, at + i * 4)));
            var after = string.Join(" / ", Enumerable.Range(0, SkillEdit.LevelValueCount)
                .Select(i => i < values.Length ? values[i] : 0f));

            Log($"  {key:X8} L{level} @0x{offset:X}: was {before}");
            Log($"  {key:X8} L{level} @0x{offset:X}: now {after}");

            for (var i = 0; i < SkillEdit.LevelValueCount; i++)
            {
                var value = i < values.Length ? values[i] : 0f;
                BitConverter.GetBytes(value).CopyTo(data, at + i * 4);
            }
            return true;
        }

        Log($"  {key:X8} L{level}: row not found");
        return false;
    }

    /// <summary>
    /// Points the log at the mod's own folder, resolved once in Start().
    ///
    /// The mod produces the log, so it lives with the mod's files - and that is
    /// the first place anyone looks when a patch does not take. If the loader
    /// cannot name the folder, logging is skipped for the run rather than sent
    /// somewhere else: one location, nothing to keep in sync.
    /// </summary>
    private void UseModDirectoryForLog()
    {
        try
        {
            if (_loader is IModLoaderV2 v2)
            {
                _logFile = Path.Combine(v2.GetDirectoryForModId(ModId), LogFileName);
            }
        }
        catch
        {
            _logFile = string.Empty;
        }
    }

    /// <summary>
    /// Appends a line to this run's log, starting the file over on the first call
    /// so it always describes the launch you are looking at rather than every
    /// launch before it.
    ///
    /// Nothing here may throw: the first call happens outside Start()'s try, and a
    /// log is never a reason to stop patching.
    /// </summary>
    private static void Log(string message)
    {
        if (_logFile.Length == 0)
            return;

        try
        {
            if (!_logStarted)
            {
                File.WriteAllText(_logFile, string.Empty);
                _logStarted = true;
            }
            File.AppendAllText(_logFile, $"{DateTime.Now:HH:mm:ss.fff}  {message}{Environment.NewLine}");
        }
        catch
        {
            // Never let logging take the patch down with it: the first call
            // happens outside Start()'s try, and the log file can be
            // missing, full or read-only at any point.
        }
    }

    public void Suspend() { }
    public void Resume() { }
    public void Unload() { }
    public bool CanUnload() => true;
    public bool CanSuspend() => true;
    public Action Disposing => () => { };
}