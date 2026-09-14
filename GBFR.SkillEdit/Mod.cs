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

    // Where Log() appends. Seeded with the %TEMP% fallback; Start() moves it
    // into the mod's own folder when the loader can name one.
    private static string _logFile = Path.Combine(Path.GetTempPath(), LogFileName);

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
            if (_loader is IModLoaderV3 v3)
            {
                var path = Path.Combine(v3.GetModConfigDirectory(ModId), ConfigFileName);
                Log($"config path: {path}");

                // Say which of the two failures this is. "no edits applied" alone
                // cannot be told apart from "every edit is switched off", and the
                // answer decides whether the tool is writing to the wrong folder.
                if (!File.Exists(path))
                {
                    Log("FAIL: no Config.json at that path (the tool deploys the edit list here)");
                    return new Config();
                }

                var config = Config.Load(path);
                Log($"config loaded: {config.Edits.Count} edit(s)");
                return config;
            }
            Log("loader is not IModLoaderV3; using built-in defaults");
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
    /// Moves the log into the mod's per-mod user configuration directory,
    /// &lt;Reloaded-II&gt;\User\Mods\GBFR.SkillEdit\ — the same folder the tool
    /// writes Config.json to, resolved the same way LoadConfig() resolves it.
    ///
    /// Why not %TEMP%: it is the wrong lifetime and the wrong audience. It is
    /// shared by every process on the machine, it is cleaned up whenever Windows
    /// or a cleaner feels like it, and the user who has to send us a log has to
    /// know to go look there. The log is produced by this mod, so it lives with
    /// the mod's own files rather than with the loader's user data: one folder
    /// answers both "what is installed" and "what did it do last run".
    ///
    /// Reloaded-II watches this directory, so a log appearing in it could in
    /// principle be read as the mod having changed on disk. That has not been
    /// observed, and if it ever is, this path is the one line to change.
    ///
    /// Falls back to %TEMP% — the value _logFile already holds — when the loader
    /// cannot name the directory, or when it turns out not to be writable. A log
    /// is a nicety, never a reason to stop patching, so every failure here is
    /// swallowed.
    /// </summary>
    private void UseModDirectoryForLog()
    {
        try
        {
            if (_loader is not IModLoaderV2 v2)
                return;

            var dir = v2.GetDirectoryForModId(ModId);
            if (string.IsNullOrWhiteSpace(dir))
                return;

            Directory.CreateDirectory(dir);
            var candidate = Path.Combine(dir, LogFileName);

            // Settle writability now rather than on the first Log() call: if the
            // directory is read-only we want the %TEMP% fallback for the whole
            // run, not a log that starts here and silently loses later lines.
            File.AppendAllText(candidate, string.Empty);
            _logFile = candidate;
        }
        catch
        {
            // Keep %TEMP%.
        }
    }

    private static void Log(string message)
    {
        try
        {
            File.AppendAllText(_logFile, $"{DateTime.Now:HH:mm:ss.fff}  {message}{Environment.NewLine}");
        }
        catch
        {
            // Never let logging take the patch down with it: the first call
            // happens outside Start()'s try, and the log directory can be
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
