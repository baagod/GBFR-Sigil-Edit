using System;
using System.Collections.Generic;
using System.Threading;

namespace GBFR.SkillEdit;

/// <summary>
/// Applies config edits to the game's ALREADY-LOADED skill_status table, so a
/// change takes effect without restarting the game.
///
/// The tool triggers this through a named win32 event rather than a config poll:
/// Install() sets the event after writing Config.json, and until then nothing
/// here wakes up at all.
///
/// Copy addresses are located TWICE, in two different phases:
///   - at BOOT, in the background: copies of the table appear over the first
///     minute as the game loads data, and are rebuilt along the way, so the
///     locate retries until two scan passes return the same address set - only
///     a set that has stopped moving can be trusted to include the copy the
///     game reads. This way the wait is paid during boot, not at the click.
///   - on apply, the cached addresses are re-verified as whole copies in
///     milliseconds, and ONLY a unanimous verify writes without scanning; any
///     miss or failure falls back to the full parallel scan. A cache that is
///     anything less than complete agreement can therefore never produce a
///     "success" that silently missed the game.
/// </summary>
internal sealed class HotApply
{
    /// <summary>
    /// Shared by name with the tool's signalHotApply - the two sides have no
    /// build-time link, so a rename has to touch both.
    /// </summary>
    public const string EventName = "GBFR.SkillEdit.HotApply";

    private readonly Action<string> _log;

    /// <summary>Builds the table bytes for the config as it stands now; null
    /// after it has logged why the table cannot be produced.</summary>
    private readonly Func<byte[]?> _buildTable;

    /// <summary>
    /// Registers the produced table with the data manager, so every parse the
    /// game makes AFTER the apply serves the new values too - a memory write
    /// alone is undone by the next parse the game runs.
    /// </summary>
    private readonly Action<byte[]> _register;

    /// <summary>
    /// The bytes the game was last known to hold - the boot-time table, then
    /// whatever the last apply wrote.
    /// </summary>
    private byte[] _currentTable;

    /// <summary>
    /// Where the table was found last (the boot locate, then every apply).
    /// Applies re-read all of these and compare whole copies - milliseconds
    /// per address - so a usual apply never scans at all.
    /// </summary>
    private List<long> _cachedAddresses = new();

    /// <summary>
    /// Boot-time locate bookkeeping: the previous attempt's address set. A scan
    /// only locks the cache once it repeats the previous set exactly, because
    /// the game keeps creating and dropping copies while it boots and only a
    /// set that has stopped moving is certain to hold the live copy.
    /// </summary>
    private long[]? _prewarmPrevious;

    /// <summary>
    /// When the silent locate runs, and how often it rechecks. The table only
    /// exists once the game has loaded the data files - roughly the first half
    /// of the ~40 s between process start and a readable save - and the game
    /// keeps rebuilding copies while it boots, so the first attempts tend to
    /// find nothing or a set that keeps moving. The gaps cover 3-4 minutes;
    /// beyond that, the first click scans as usual and seeds the same cache.
    /// </summary>
    private const int PrewarmFirstDelayMs = 20_000;
    private const int PrewarmRetryMs = 15_000;
    private const int PrewarmMaxAttempts = 6;

    private EventWaitHandle? _event;
    private volatile bool _stopped;

    public HotApply(Action<string> log, byte[] bootTable, Func<byte[]?> buildTable, Action<byte[]> register)
    {
        _log = log;
        _currentTable = bootTable;
        _buildTable = buildTable;
        _register = register;
    }

    public void Start()
    {
        try
        {
            _event = new EventWaitHandle(false, EventResetMode.AutoReset, EventName, out var created);
            _log($"hot apply: {(created ? "created" : "joined")} event '{EventName}'");
        }
        catch (Exception ex)
        {
            _log($"hot apply: could not create the event ({ex.Message}); live apply is off this session");
            return;
        }

        var waiter = new Thread(WaitLoop) { IsBackground = true, Name = "GBFR.SkillEdit hot apply" };
        waiter.Start();

        // The boot-side locate: does the memory walk while the game boots, so
        // the user never waits for it at the click. It stops on its own once
        // the address set is stable (or the first apply seeds the cache).
        var bootLocator = new Thread(PrewarmLoop) { IsBackground = true, Name = "GBFR.SkillEdit boot locate" };
        bootLocator.Start();
    }

    /// <summary>
    /// Stops the waiter. The event handle itself is not disposed: the waiter
    /// sits inside WaitOne on it, and closing a handle another thread is waiting
    /// on is undefined on Windows. One dormant handle per unload is not a leak
    /// worth racing the waiter for. The waiter exits through the flag alone.
    /// </summary>
    public void Dispose()
    {
        _stopped = true;
        try { _event?.Set(); }
        catch { /* the waiter must not take the shutdown down with it */ }
    }

    private void WaitLoop()
    {
        while (!_stopped)
        {
            // A timeout rather than an infinite wait only so a reload of the mod
            // is noticed even if the flag was set between waits. Nothing is
            // polled here: there is no file to stat and no work to do when the
            // event has not been set.
            if (!_event!.WaitOne(1000))
                continue;
            if (_stopped)
                return;
            try
            {
                Apply();
            }
            catch (Exception ex)
            {
                _log("hot apply EXCEPTION: " + ex);
            }
        }
    }

    private void Apply()
    {
        var newTable = _buildTable();
        if (newTable is null)
            return; // buildTable logged why

        if (newTable.AsSpan().SequenceEqual(_currentTable))
        {
            _log("hot apply: the edit list matches what is already in memory; nothing to do");
            return;
        }

        // Registration first: it is cheap, and if the game parses the table from
        // the served file while this scan is running, the parse must see the new
        // values rather than quietly re-creating rows with the old ones.
        try
        {
            _register(newTable);
        }
        catch (Exception ex)
        {
            _log("hot apply: re-register EXCEPTION (continuing with the memory write): " + ex);
        }

        var sw = System.Diagnostics.Stopwatch.StartNew();

        // Fast path, and the usual one: every copy found at the previous apply
        // is re-verified against the current table by a whole-table readback.
        // That costs milliseconds per address, so in the stable boot the apply
        // finishes before the user switches back to the game. Any miss, any
        // failure, and the full scan runs instead - the fast path is only ever
        // taken on unanimous agreement.
        var candidates = (_cachedAddresses.Count > 0 &&
                          _cachedAddresses.All(address => TableLocator.ContentsMatch(address, _currentTable))
                              ? _cachedAddresses
                              : null)
                         ?? ScanAllCopies(_currentTable, newTable);

        var updated = 0;
        var alreadyCurrent = 0;
        foreach (var address in candidates)
        {
            if (TableLocator.ContentsMatch(address, newTable))
            {
                alreadyCurrent++;
                continue;
            }
            if (TableLocator.WriteCopy(address, newTable))
            {
                _log($"  wrote 0x{address:X}");
                updated++;
            }
            else
            {
                _log($"  FAILED writing 0x{address:X}");
            }
        }

        if (candidates.Count == 0)
        {
            _log("hot apply: FAIL - the table could not be located in memory; the edits still take effect on the next game start");
            return;
        }

        if (updated > 0 || alreadyCurrent == candidates.Count)
        {
            _currentTable = newTable;
            _cachedAddresses = candidates;
            _log($"hot apply: SUCCESS - {updated} in-memory copy/copies updated ({alreadyCurrent} already current) in {sw.ElapsedMilliseconds} ms, live without a restart");
        }
        else
        {
            _log("hot apply: FAIL - no in-memory copy could be written; the edits still take effect on the next game start");
        }
    }

    /// <summary>
    /// The full walk the fast path falls back on: one parallel pass over memory,
    /// matching copies against both the previous and the new table.
    /// </summary>
    private List<long> ScanAllCopies(byte[] previousTable, byte[] newTable)
    {
        var found = TableLocator.FindCopies(previousTable, newTable);
        _log($"hot apply: located {found.Count} in-memory copy/copies: " +
             string.Join(", ", found.ConvertAll(address => $"0x{address:X}")));
        return found;
    }

    /// <summary>
    /// Does the memory walk so the user never does: started with the mod, it
    /// scans in the background until the game's copy set stops moving, then
    /// hands the stable set to the fast path. Seeded with nothing if the game
    /// is still churning when the attempts run out - the first click scans
    /// exactly like today and seeds the cache through success.
    ///
    /// The walk can find nothing on early attempts (the table is not in memory
    /// yet) and partial sets while the game rebuilds copies, which is exactly
    /// why locking waits for a REPEATED set rather than the first hit.
    /// </summary>
    private void PrewarmLoop()
    {
        for (var waited = 0; waited < PrewarmFirstDelayMs && !_stopped; waited += 250)
            Thread.Sleep(250);

        for (var attempt = 0; attempt < PrewarmMaxAttempts && !_stopped; attempt++)
        {
            // An apply that ran while waiting has already seeded the cache with
            // a fresher scan; its work outranks everything done here.
            if (_cachedAddresses.Count > 0)
                return;

            List<long> found;
            try
            {
                found = TableLocator.FindCopies(_currentTable);
            }
            catch (Exception ex)
            {
                _log("boot locate EXCEPTION: " + ex);
                break;
            }

            var set = found.OrderBy(address => address).ToArray();
            if (_prewarmPrevious is not null && _prewarmPrevious.SequenceEqual(set))
            {
                _cachedAddresses = set.ToList();
                _log($"boot locate: copy set stable ({found.Count} copy/copies) after {attempt + 1} attempt(s); live applies skip the scan entirely");
                return;
            }

            _log($"boot locate attempt {attempt + 1}: {found.Count} table copy/copies found; waiting for the set to stabilize");
            _prewarmPrevious = set;

            for (var waited = 0; waited < PrewarmRetryMs && !_stopped; waited += 250)
                Thread.Sleep(250);

            if (_stopped || _cachedAddresses.Count > 0)
                return;
        }

        if (!_stopped && _cachedAddresses.Count == 0)
            _log("boot locate: the copy set never stabilized before the attempts ran out; the first live apply will scan once and seed the cache");
    }
}
