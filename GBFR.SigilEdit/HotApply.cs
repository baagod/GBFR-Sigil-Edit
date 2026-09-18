using System;
using System.Collections.Generic;
using System.Threading;

namespace GBFR.SigilEdit;

/// <summary>
/// Applies config edits to the game's ALREADY-LOADED skill_status table, so a
/// change takes effect without restarting the game.
///
/// The tool triggers this through a named win32 event rather than a config poll:
/// every save of the edit list sets the event - signing the file and waking this
/// up are the same act - and until then nothing here wakes up at all.
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
    public const string EventName = "GBFR.SigilEdit.HotApply";

    private readonly Action<string> _log;

    /// <summary>
    /// Reads the table and builds what the config asks for: the first is the bytes the game
    /// holds, which the scan looks for, and the second is what they are replaced with. Either
    /// is null, after a log line saying why, when the table cannot be read or its layout is
    /// not the one this build patches.
    /// </summary>
    private readonly Func<(byte[]? Raw, byte[]? Edited)> _build;

    /// <summary>
    /// Registers the produced table with the data manager, so every parse the
    /// game makes AFTER the apply serves the new values too - a memory write
    /// alone is undone by the next parse the game runs.
    /// </summary>
    private readonly Action<byte[]> _register;

    /// <summary>
    /// The bytes the game was last known to hold - the boot-time table, then whatever the last
    /// apply wrote. Null until something is known: the boot write cannot always read the table,
    /// and the first apply then takes the game's own bytes as what memory holds.
    /// </summary>
    private byte[]? _currentTable;

    /// <summary>
    /// Where the table was found last (the boot locate, then every apply).
    /// Applies re-read all of these and compare whole copies - milliseconds
    /// per address - so a usual apply never scans at all.
    /// </summary>
    private List<long> _cachedAddresses = new();

    /// <summary>
    /// How long to wait before the silent locate, and why one pass is enough.
    ///
    /// The delay runs from mod start, and the scan it triggers costs 5 to 6 seconds, so it
    /// has to finish before the player can interact. Measured on this machine: the table is
    /// in memory 27 seconds after process start, a save finishes loading at about 70, and
    /// the mod starts about 4 seconds in. 45 therefore puts the scan at roughly 49 s and its
    /// end at 55 s - while the player is still on a loading screen, with about 15 seconds of
    /// slack before they can click apply. Waiting 60 started the scan as the save finished
    /// loading: neither hidden behind the load nor early enough to be ready for an immediate
    /// click.
    ///
    /// One pass is enough: FindCopies has no early exit, so a single pass returns every
    /// copy that exists at that moment. Scanning later would find MORE copies (measured:
    /// 1 at 67 s, 4 at 86 s, 7 at 465 s), but a short cache is not a correctness problem -
    /// every read of it is re-verified with ContentsMatch, and a miss costs one scan on
    /// the next apply.
    /// </summary>
    private const int PrewarmDelayMs = 45_000;

    private EventWaitHandle? _event;
    private volatile bool _stopped;

    public HotApply(
        Action<string> log,
        byte[]? bootTable,
        Func<(byte[]? Raw, byte[]? Edited)> build,
        Action<byte[]> register)
    {
        _log = log;
        _currentTable = bootTable;
        _build = build;
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

        var waiter = new Thread(WaitLoop) { IsBackground = true, Name = "GBFR.SigilEdit hot apply" };
        waiter.Start();

        // The boot-side locate: does the memory walk while the game boots, so
        // the user never waits for it at the click. It stops on its own once
        // the address set is stable (or the first apply seeds the cache).
        var bootLocator = new Thread(PrewarmLoop) { IsBackground = true, Name = "GBFR.SigilEdit boot locate" };
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
            // The event is what wakes this loop. The one-second timeout is only a
            // backstop for the shutdown: if Dispose's Set() threw, the flag still
            // gets re-checked instead of this thread parking here forever.
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
        var (raw, newTable) = _build();
        if (newTable is null)
        {
            _log("hot apply: nothing to apply - the table could not be read, or its layout is not the one this build patches (see the lines above)");
            return;
        }

        /*
          Nothing is known about what memory holds when the boot write could not read the
          table: the game loaded its own copy, and that is what the scan has to look for.
          Everything below then treats `current` as "the bytes in memory", exactly as at boot.
        */
        if (_currentTable is null || _currentTable.Length == 0)
        {
            if (raw is null)
            {
                _log("hot apply: the table cannot be read yet; nothing to do this time");
                return;
            }
            _currentTable = raw;
        }
        var current = _currentTable;

        if (newTable.AsSpan().SequenceEqual(current))
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
        var candidates = WithoutOwnCopies(newTable, () =>
            (_cachedAddresses.Count > 0 &&
             _cachedAddresses.All(address => TableLocator.ContentsMatch(address, current))
                 ? _cachedAddresses
                 : null)
            ?? ScanAllCopies(current, newTable));

        var updated = 0;
        var alreadyCurrent = 0;
        var failed = 0;
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
                failed++;
            }
        }

        if (candidates.Count == 0)
        {
            _log("hot apply: FAIL - no in-memory copy located; the edit list is re-registered, but the game's loaded table was left alone");
            return;
        }

        if (failed == 0 && (updated > 0 || alreadyCurrent == candidates.Count))
        {
            _currentTable = newTable;
            _cachedAddresses = candidates;
            _log($"hot apply: SUCCESS - {updated} in-memory copy/copies updated ({alreadyCurrent} already current) in {sw.ElapsedMilliseconds} ms, live without a restart");
            return;
        }

        // Nothing is cached and the table stays the previous one: a copy that did
        // not take the write still holds those bytes, and keeping them as "what
        // the game has" is what lets the next apply find that copy again instead
        // of losing track of it for good.
        _log(failed > 0 && (updated > 0 || alreadyCurrent > 0)
            ? $"hot apply: PARTIAL - {updated} in-memory copy/copies updated, {failed} could NOT be written ({alreadyCurrent} already current) in {sw.ElapsedMilliseconds} ms; the game may still be reading a copy that holds the old values"
            : "hot apply: FAIL - no in-memory copy could be written; the edit list is re-registered, but the loaded table still holds the old values");
    }

    /// <summary>
    /// Runs a locate with this mod's own copies of the table pinned, and drops
    /// their addresses from what it returns: the one the game was last believed
    /// to hold, plus - while an apply is running - the buffer that apply just
    /// built. A locate finds those buffers like any other copy, because they hold
    /// the table and sit in writable private memory, but a write to one of them
    /// proves nothing about the game, and a candidate set that holds nothing but
    /// them must not be able to pass for a finished apply. Pinning is what keeps
    /// the addresses it is dropped by valid for the length of the walk.
    /// </summary>
    private List<long> WithoutOwnCopies(byte[]? built, Func<List<long>> locate)
    {
        var pins = new List<System.Runtime.InteropServices.GCHandle>(2);
        foreach (var table in new[] { _currentTable, built })
        {
            if (table is not null)
                pins.Add(System.Runtime.InteropServices.GCHandle.Alloc(
                    table, System.Runtime.InteropServices.GCHandleType.Pinned));
        }

        try
        {
            var found = locate();
            foreach (var pin in pins)
            {
                var own = pin.AddrOfPinnedObject().ToInt64();
                found.RemoveAll(address => address == own);
            }
            return found;
        }
        finally
        {
            foreach (var pin in pins)
                pin.Free();
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
    /// Does the memory walk so the user never does: started with the mod, it waits for
    /// the delay PrewarmDelayMs documents, then scans ONCE and hands whatever it found
    /// to the fast path.
    ///
    /// One pass is enough, and repeated passes are worse. FindCopies has no early exit,
    /// so a single pass returns every copy that exists at that moment. The previous
    /// version instead waited for two passes to agree, which on this game either locked
    /// in a partial set or, when the game kept rebuilding copies, gave up after minutes
    /// having found the table every time.
    ///
    /// A short cache is not a correctness problem: every read of it is re-verified
    /// with ContentsMatch, and a miss costs one scan on the next apply.
    /// </summary>
    private void PrewarmLoop()
    {
        /*
          Nothing to look for until something is known about what memory holds: the boot
          write could not read the table, so the first apply adopts the game's own bytes and
          scans then. Skipped rather than scanned so the log does not fill with failures for
          a table nobody has read yet.
        */
        if (_currentTable is null || _currentTable.Length == 0)
            return;

        for (var waited = 0; waited < PrewarmDelayMs && !_stopped; waited += 250)
            Thread.Sleep(250);

        if (_stopped || _cachedAddresses.Count > 0)
            return; // an apply during the wait already seeded the cache

        var scan = System.Diagnostics.Stopwatch.StartNew();
        List<long> found;
        try
        {
            var current = _currentTable;
            found = WithoutOwnCopies(null, () => TableLocator.FindCopies(current));
        }
        catch (Exception ex)
        {
            _log("boot locate EXCEPTION: " + ex);
            return;
        }
        scan.Stop();

        if (_stopped || _cachedAddresses.Count > 0)
            return;

        if (found.Count == 0)
        {
            _log($"boot locate: no table copy found in {scan.ElapsedMilliseconds} ms; the first live apply scans as usual and seeds the cache");
            return;
        }

        _cachedAddresses = found.OrderBy(address => address).ToList();
        _log($"boot locate: {found.Count} copy/copies found in {scan.ElapsedMilliseconds} ms; live applies skip the scan entirely");
    }
}
