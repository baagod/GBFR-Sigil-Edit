using gbfrelink.utility.manager.Interfaces;
using Reloaded.Mod.Interfaces;
using Reloaded.Mod.Interfaces.Internal;

namespace GBFR.SigilEdit;

/// <summary>
/// Patches rows of skill_status.tbl at startup, driven by a user-editable
/// Config.json, and feeds the table back through IDataManager.
///
/// On top of that it can apply the same rows to the game WHILE IT RUNS: the
/// tool signals a named event from its Install button, and HotApply overwrites
/// the table the game already holds in memory - no restart, no hooking.
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
/// Row k starts at 8 + 52k. A patch matches (Key, Level) and writes that row's own
/// LevelValue1..10, so the Level an edit names is the Level field it lands on - the
/// same number the game shows for it. Rows are grouped by Key with Level ascending.
///
/// LevelValue7..10 exist only from the game's 2.0.0 (Endless Ragnarok) release on.
/// A pre-2.0 table has 36-byte rows with the Key at +24, which is why Start()
/// checks the table's shape before touching it.
/// </summary>
public class Mod : IMod
{
    private const string TablePath = "system/table/skill_status.tbl";

    // The two numbers the whole layout hangs on: the file's own header, and one
    // row. The field offsets below are relative to the start of a row.
    private const int FileHeaderSize = 8;
    private const int RowSize = 52;
    private const int KeyOffset = 40;
    private const int LevelOffset = 48;

    private const string ConfigFileName = "Config.json";
    private const string ModId = "GBFR.SigilEdit";
    private const string LogFileName = "GBFR.SigilEdit.log";

    // The edit list lives in %APPDATA%\GBFR.SigilEdit, which the tool writes and
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

    private IModLoader _loader = null!;
    private Config _config = new();

    // Kept for the hot apply: the edit list can be re-applied to the RUNNING
    // game, and that needs the same manager and the same table construction
    // the startup write used.
    private IDataManager? _dm;
    private HotApply? _hotApply;

    public void Start(IModLoaderV1 loaderApi)
    {
        _loader = (IModLoader)loaderApi;

        UseModDirectoryForLog();

        Log("=== GBFR.SigilEdit start (config-driven) ===");

        try
        {
            _config = LoadConfig() ?? new Config();

            if (!_loader.GetController<IDataManager>().TryGetTarget(out var dm) || dm is null)
            {
                Log("FAIL: IDataManager controller not found (is gbfrelink.utility.manager enabled?)");
                return;
            }
            _dm = dm;

            var file = BuildEditedTable(_config, out var applied);

            // Wired before the boot write is looked at, and whether or not it produced a
            // table: a hot apply that is never created is an Install button that silently
            // does nothing. With no table at boot - the archive not readable yet, or a
            // layout this build does not know - the first apply reads the table again and
            // takes the game's own bytes as what memory holds.
            //
            // The builder re-reads Config.json, so what it builds is the config as it
            // stands at that moment, which is what the tool has just written.
            _hotApply = new HotApply(Log, file, BuildTablePair, RegisterWithManager);
            _hotApply.Start();

            if (file is null)
                return;

            if (applied == 0)
            {
                Log($"no edits applied (config held {_config.Edits.Count} edit(s)); not writing the table back");
            }
            else
            {
                dm.AddOrUpdateExternalFile(TablePath, file);
                dm.UpdateIndex();
                Log($"SUCCESS: {applied} edit(s) applied and table written back");
            }
        }
        catch (Exception ex)
        {
            Log("EXCEPTION: " + ex);
        }
    }

    /// <summary>
    /// Produces the table bytes for <paramref name="config"/>: the unaltered table,
    /// with the enabled edits applied onto it.
    ///
    /// Returns null, after logging why, when the table cannot be produced. The
    /// startup write goes through here - one place for the layout check and the row
    /// format, and one place whose log lines say what went wrong.
    /// </summary>
    private byte[]? BuildEditedTable(Config config, out int applied)
    {
        var file = TryReadTable();
        if (file is null)
        {
            applied = 0;
            return null;
        }
        applied = PatchRows(file, config);
        return file;
    }

    /// <summary>
    /// What the hot apply needs from one call: the bytes the game holds, and the bytes the
    /// config asks for. The two differ whenever the boot write did not happen, and the scan
    /// has to look for the former: it locates the copy the game loaded, not the one the tool
    /// wants there.
    ///
    /// The config is re-read here, so what this builds is the file as it stands now - the
    /// tool writes it and then signals.
    /// </summary>
    private (byte[]? Raw, byte[]? Edited) BuildTablePair()
    {
        if (LoadConfig() is not { } config)
            return (null, null);

        var raw = TryReadTable();
        if (raw is null)
            return (null, null);

        var edited = (byte[])raw.Clone();
        PatchRows(edited, config);
        return (raw, edited);
    }

    /// <summary>
    /// The unaltered table out of the game's archive, or null after logging why it cannot be
    /// used: no data manager, nothing returned, or a layout these offsets do not describe.
    /// </summary>
    private byte[]? TryReadTable()
    {
        if (_dm is null)
        {
            Log("FAIL: IDataManager controller not found (is gbfrelink.utility.manager enabled?)");
            return null;
        }

        var file = _dm.GetArchiveFile(TablePath);
        if (file is null || file.Length == 0)
        {
            Log($"FAIL: GetArchiveFile('{TablePath}') returned nothing");
            return null;
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
            return null;
        }

        return file;
    }

    /// <summary>
    /// Writes the enabled edits of <paramref name="config"/> into <paramref name="file"/> in
    /// place, returning how many landed. Every skip says why it skipped.
    /// </summary>
    private int PatchRows(byte[] file, Config config)
    {
        var applied = 0;
        foreach (var edit in config.Edits)
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

            // Checked before the cast, because (uint) turns a negative level into a value in
            // the billions: the row lookup would then fail with "row not found", which reads
            // as a typo in the config rather than as a level the table cannot have.
            if (edit.Level < 1)
            {
                Log($"  skip (level {edit.Level} is below the first level): {edit.Key}");
                continue;
            }

            if (PatchRow(file, key, (uint)edit.Level, edit.Values))
                applied++;
        }

        return applied;
    }

    /// <summary>
    /// Feeds <paramref name="table"/> back through the manager as the served
    /// external file, exactly the calls the startup write makes.
    ///
    /// A hot apply needs this and not just the memory write: the game parses the
    /// table again when it loads saves and screens, and every later parse reads
    /// the served file - without the re-registration those parses would rebuild
    /// rows with the old values and undo the live edit on the spot.
    /// </summary>
    private void RegisterWithManager(byte[] table)
    {
        if (_dm is null)
        {
            Log("hot apply: re-register skipped (no data manager this session)");
            return;
        }

        _dm.AddOrUpdateExternalFile(TablePath, table);
        _dm.UpdateIndex();
        Log("hot apply: table re-registered, future game parses serve the new values");
    }

    /// <summary>
    /// The edit list as it stands on disk, or null when it cannot be read: no
    /// file, no permission, a write caught halfway, a hand edit that broke the
    /// JSON. Null is NOT an empty list - an empty list is a real answer ("every
    /// edit is switched off") and produces the vanilla table, so a hot apply
    /// handed null must do nothing instead of writing those bytes over the game.
    /// </summary>
    private Config? LoadConfig()
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
                return null;
            }

            var config = Config.Load(path);
            Log($"config loaded: {config.Edits.Count} edit(s)");
            return config;
        }
        catch (Exception ex)
        {
            Log("config load failed: " + ex);
        }
        return null;
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
        for (var row = FileHeaderSize; row <= data.Length - RowSize; row += RowSize)
        {
            if (BitConverter.ToUInt32(data, row + KeyOffset) != key)
                continue;
            if (BitConverter.ToUInt32(data, row + LevelOffset) != level)
                continue;

            var before = string.Join(" / ", Enumerable.Range(0, SigilTrait.LevelValueCount)
                .Select(i => BitConverter.ToSingle(data, row + i * 4)));
            var after = string.Join(" / ", Enumerable.Range(0, SigilTrait.LevelValueCount)
                .Select(i => i < values.Length ? values[i] : 0f));

            Log($"  {key:X8} L{level} @0x{row:X}: was {before}");
            Log($"  {key:X8} L{level} @0x{row:X}: now {after}");

            for (var i = 0; i < SigilTrait.LevelValueCount; i++)
            {
                var value = i < values.Length ? values[i] : 0f;
                BitConverter.GetBytes(value).CopyTo(data, row + i * 4);
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
    public void Unload()
    {
        // Stops the waiter and the locate thread. The threads are background, so
        // a process exit takes them anyway; this covers a mod reload while the
        // game keeps running.
        _hotApply?.Dispose();
    }
    public bool CanUnload() => true;
    public bool CanSuspend() => true;
    public Action Disposing => () => { };
}