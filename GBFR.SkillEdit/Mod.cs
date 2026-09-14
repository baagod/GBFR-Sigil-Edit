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
/// Row layout. Checked against the file and against the table definition of the
/// toolkit that reads this table - GBFRDataTools' skill_status.headers, plus the
/// GameTable.cs that asserts 8 + RowSize * rowCount == file.Length:
///   - 8-byte header: the row count, as an int64.
///   - Rows of 52 bytes:
///       +0   float  LevelValue1 ... +36 float LevelValue10
///       +40  uint   Key (skill hash)
///       +44  uint   LevelDescription
///       +48  uint   Level
///
/// Row k starts at 8 + 52k, so its Key sits at 48 + 52k - and the offsets below
/// are relative to that Key, which is what the patch loop walks. Value1Offset is
/// therefore the next row's LevelValue1: the same skill one level up, because rows
/// are grouped by Key in ascending Level.
///
/// That pairing is load-bearing rather than an accident. SkillEditTool stores a
/// skill's levels as (table level - 1) and labels them stored + 1, so a level N
/// chosen in the tool is written to the row whose Level field is N - the level the
/// tool names. The offsets here and that convention have to move together: change
/// one and every edit shifts by one level.
///
/// LevelValue7..10 exist only from the game's 2.0.0 (Endless Ragnarok) release on.
/// A pre-2.0 table has 36-byte rows with the Key at +24, which is why Start()
/// checks the table's shape before touching it.
/// </summary>
public class Mod : IMod
{
    private const string TablePath = "system/table/skill_status.tbl";

    // The two numbers the whole layout hangs on: the file's own header, and one
    // row. See the class comment for what sits where inside a row.
    private const int FileHeaderSize = 8;
    private const int RowSize = 52;

    // Relative to the Key field - i.e. 40 bytes into the row, not to the row.
    private const int HeaderSize = 48;
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

            // The offsets this mod patches are only the right ones for a table of
            // this shape. A pre-2.0 table has 36-byte rows, and any future column
            // change moves them again: patching then would write into the wrong
            // row, or past the end of one, without saying so.
            if (!HasPatchableLayout(file, out var declaredRows))
            {
                Log($"FAIL: {TablePath} is not the {FileHeaderSize}-byte header + " +
                    $"{RowSize}-byte row table this mod patches: {file.Length} bytes, header says " +
                    $"{declaredRows} row(s). Nothing applied.");
                return;
            }

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
    /// True when the table is the one the offsets above were written against: an
    /// 8-byte header whose row count accounts for the rest of the file in 52-byte
    /// rows - the same identity the toolkit that generates this table asserts when
    /// it reads it. A pre-2.0 table (36-byte rows) and any future column change
    /// both fail this, which is the point: the caller then patches nothing instead
    /// of writing into the wrong row.
    /// </summary>
    private static bool HasPatchableLayout(byte[] data, out long declaredRows)
    {
        declaredRows = data.Length >= FileHeaderSize ? BitConverter.ToInt64(data, 0) : 0;
        return declaredRows > 0 && FileHeaderSize + (long)RowSize * declaredRows == data.Length;
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

            // The values sit in the row after this one (see the class comment), so
            // that row has to belong to the same skill. The last row of a skill's
            // block would otherwise write its numbers over the next skill's first
            // level, and the table's own last row has no row after it at all.
            var target = offset + RowSize;
            if (target + sizeof(uint) > data.Length || BitConverter.ToUInt32(data, target) != key)
            {
                Log($"  {key:X8} L{level} @0x{offset:X}: refusing (values would land on the next skill's row)");
                return false;
            }

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
    /// Appends a line to the log beside the mod's own files.
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