import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { Call, Events } from "@wailsio/runtime";
import { X } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LANGS, LANG_LABEL, MESSAGES, initialLang, rememberLang, type Lang } from "./i18n";
import { TraitRow, type RowContext } from "./TraitRow";
import {
  asEdits,
  dedupe,
  explainAt,
  levelsOf,
  matches,
  pad,
  slotLabel,
  type ExplainBand,
  type SigilTrait,
  type TraitInfo,
} from "./traits";

const SERVICE = "main.EditService";
/*
  Mirrors saveFailedEvent in editservice.go. The debounced write happens after the
  call that asked for it has returned, so a failure there has no answer to return
  and arrives as this event instead.
*/
const SAVE_FAILED = "GBFR.SigilEdit.SaveFailed";

/** Whether the list the tool would write is the one it read: same edits, same numbers. */
const sameRecords = (a: SigilTrait[], b: SigilTrait[]) =>
  a.length === b.length &&
  a.every((record, i) =>
    record.values.every((value, slot) => value === b[i].values[slot]),
  );

/** A value as it was a moment ago: the search box filters a 200-row list per keystroke otherwise. */
function useDebounced<T>(value: T, delay = 150): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

export default function App() {
  const [lang, setLang] = useState<Lang>(initialLang);
  const [edits, setEdits] = useState<SigilTrait[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [traits, setTraits] = useState<Record<string, TraitInfo>>({});
  // Per trait, the stretches of levels that share an explanation - most have one, a few
  // change the wording partway (see explainAt).
  const [explains, setExplains] = useState<Record<string, ExplainBand[]>>({});
  const [error, setError] = useState<{ title: string; detail: string } | null>(null);
  const [errorOpen, setErrorOpen] = useState(false);
  // Which traits are open. A trait whose numbers live on one level has nothing to
  // open, so only the traits that span several levels ever land in here.
  const [open, setOpen] = useState<Set<string>>(new Set());
  /*
    The row the pointer is resting in, which is the whole of what a tooltip depends on:
    while the pointer is in a row its explanation is up, and only leaving the row takes
    it away.

    Base UI's own reasons for closing (a press inside the trigger, focus moving from a
    value box to the row) are what took the explanation away mid-row before, so the
    open state is controlled from here instead and the pointer is the only thing that
    changes it - including a tick, which moves the rows rather than the pointer and is
    followed up in resolveHoveredRow.
  */
  const [tipRow, setTipRow] = useState<string | null>(null);
  const listBox = useRef<HTMLDivElement>(null);
  /*
    The scroll offset held across a tick's re-render, or null when no tick is due.

    A tick reorders the list - what is on sorts to the top - and the browser follows the
    box that was just clicked, because it still holds focus: it scrolls the row back into
    view, which is what made a tick feel like the list jumped. The offset goes back in
    the layout effect below, in the same pass that re-points the tooltip at whatever row
    is under the pointer now (the row that was hovered has moved away and another slid
    into its place), so both end up where the pointer is.
  */
  const heldScroll = useRef<number | null>(null);
  /*
    Where the pointer last moved. A tick moves the rows under a pointer that has not
    moved, and moving inside a row fires no enter either, so neither the browser's hover
    nor our own enter/leave can say which row is being hovered after a tick.
  */
  const lastMove = useRef<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    if (heldScroll.current === null) return;
    if (listBox.current) listBox.current.scrollTop = heldScroll.current;
    heldScroll.current = null;
    resolveHoveredRow();
  });
  const [query, setQuery] = useState("");
  const search = useDebounced(query);
  // The search box, so its clear button can hand the caret back to it.
  const searchBox = useRef<HTMLInputElement>(null);

  const t = MESSAGES[lang];

  /*
    Showing a failure both remembers it and opens the dialog. Closing only closes:
    the message stays in state so the exit animation still has something to draw,
    where clearing it on close blanked the dialog for the whole fade-out.
  */
  function showError(next: { title: string; detail: string }) {
    setError(next);
    setErrorOpen(true);
  }

  /*
    Trait names come from the game's own text for the chosen language, so they are
    fetched again whenever it changes. The edit list is language-neutral and is
    deliberately left alone.
  */
  useEffect(() => {
    rememberLang(lang);
    Promise.all([
      Call.ByName(`${SERVICE}.NameMap`, lang),
      Call.ByName(`${SERVICE}.ExplainMap`, lang),
    ])
      .then(([map, texts]) => {
        setNames((map ?? {}) as Record<string, string>);
        setExplains((texts ?? {}) as Record<string, ExplainBand[]>);
      })
      .catch((err) => showError({ title: t.readFailed, detail: String(err) }));
  }, [lang]);

  async function loadAll() {
    const [list, traitMap] = await Promise.all([
      Call.ByName(`${SERVICE}.LoadEdits`) as Promise<SigilTrait[]>,
      Call.ByName(`${SERVICE}.TraitMap`) as Promise<Record<string, TraitInfo>>,
    ]);
    /*
      A record whose key is not a hex hash is not an edit at all: the mod parses the
      key as hex before it looks at any row and skips the record when that fails, so
      the tool ignores it too instead of showing a row that can never write anything.
      A hash the name table does not know is kept: the mod does apply those, and an
      edit nobody can see is worse than one whose name is only a hash.
    */
    // A key that is not hex at all is not an edit the mod can apply either way, but it is
    // still the user's line: it is kept, under its hash as the name, rather than filtered
    // out - dropping it here would delete it from Config.json on the next write, and an
    // edit nobody can see is worse than one whose name is only a hash.
    // What the file holds, as it holds it: two edits for one address can both be there, and
    // a key can be lower case. Reading is what cleans that up, so the raw list is kept to
    // tell whether the file already says what the tool is about to show.
    const raw = (list ?? [])
      .filter((e) => String(e.key ?? "").trim() !== "")
      .map((e) => ({
        ...e,
        // Every table the tool serves is keyed by the uppercase hash, and a key
        // written into Config.json by hand can be lower case. Normalising here is
        // what lets every lookup below use the key as it stands, instead of the
        // half-dozen call sites that used to uppercase it for themselves.
        key: e.key.toUpperCase(),
        // Ten slots, a number or null: a file that is short, or has no values at all,
        // pads with null - the game's own number, which writes nothing.
        values: pad(e.values ?? []),
      }));

    // One edit per address, and nothing but edits (see asEdits). The file is written
    // straight back when the result differs from it: an old file converges on the first
    // open rather than on the next keystroke.
    const { records } = dedupe(asEdits(raw, traitMap ?? {}));
    setEdits(records);
    setTraits(traitMap ?? {});
    if (!sameRecords(records, raw)) {
      Call.ByName(`${SERVICE}.SaveEdits`, records).catch((err) =>
        showError({ title: MESSAGES[lang].writeFailed, detail: String(err) }),
      );
    }
  }

  useEffect(() => {
    loadAll().catch((err) => showError({ title: t.readFailed, detail: String(err) }));
  }, []);

  /*
    A write that failed after the debounce, pushed from the backend - see
    SAVE_FAILED. It gets the same dialog as the immediate failures, because from
    the reader's side they are one thing: the edit is not on disk. Re-subscribed
    when the language changes so the title follows the switch, and the function
    On hands back is the unsubscribe React runs on the way out.
  */
  useEffect(
    () =>
      Events.On(SAVE_FAILED, (event) => {
        showError({ title: t.writeFailed, detail: String(event.data) });
      }),
    [lang],
  );

  /*
    Every trait the game has, not only the edited ones: a row is a trait and its
    checkboxes are the levels that trait is edited at. Finding one is the search
    box's job, so this list is the catalogue rather than a list of additions.
  */
  const rows = useMemo(() => {
    const byKey = new Map<string, SigilTrait[]>();
    for (const record of edits) {
      const held = byKey.get(record.key);
      if (held) held.push(record);
      else byKey.set(record.key, [record]);
    }

    /*
      What is switched on comes first, at both levels: a trait with an enabled level
      sorts above the rest, and inside a trait the enabled levels sort above its other
      rows. What is on is what the game is doing, so it is what has to be found first.
    */
    const keys = [...Object.keys(names)];
    // A hash the tables do not know - a Config.json written by hand, an edit from
    // another build - is kept rather than dropped, because an edit the list cannot
    // show is an edit nobody can see is being applied. It sorts with the rest.
    for (const key of byKey.keys()) {
      if (!(key in names)) keys.push(key);
    }

    const needle = search.trim().toLowerCase();

    return keys
      .map((key) => {
        const info: TraitInfo | undefined = traits[key];
        const records = byKey.get(key) ?? [];
        const byLevel = new Map(records.map((record) => [record.level, record]));
        const label = names[key] ?? key;

        return {
          key,
          label,
          info,
          records,
          byLevel,
          enabled: records.some((record) => record.enabled),
          // Which levels the trait shows, and in what order, is traits.ts's business.
          levels: levelsOf(info, records),
        };
      })
      // The search is by name, or by the hash the tables and Config.json key the trait
      // by - which is how a single row is put on screen by hand.
      .filter((row) => matches(row.label, row.key, needle))
      .sort(
        (a, b) =>
          Number(b.enabled) - Number(a.enabled) ||
          a.label.localeCompare(b.label, lang === "zh" ? "zh-Hans-CN" : lang),
      );
  }, [edits, names, traits, search, lang]);

  /**
   * The edit a level's checkbox starts: nothing typed, so every slot is the game's own.
   *
   * `enabled` is what the caller means by starting one: ticking a level switches it on,
   * typing into it does not (see updateLevel).
   */
  function newRecord(key: string, level: number, enabled: boolean): SigilTrait {
    return {
      enabled,
      key: key,
      level: level,
      // No numbers at all: an untouched slot is null, which leaves the game's own value
      // in place - so ticking a level and changing nothing writes nothing.
      values: pad([]),
    };
  }

  /*
    One level's checkbox. With no edit at that address yet, ticking it is what creates
    one, from the game's own row for that level; unticking switches the edit off and
    keeps its numbers - a switched-off record that carries typed numbers is still saved
    (see isEdit), it is simply not applied. Unticking one that carries nothing the user
    typed leaves no edit at all, and commit drops it.
  */
  function toggleLevel(key: string, level: number) {
    beginTick();
    const at = edits.findIndex((e) => e.key === key && e.level === level);
    if (at < 0) {
      commit([...edits, newRecord(key, level, true)]);
      return;
    }
    commit(edits.map((e, i) => (i === at ? { ...e, enabled: !e.enabled } : e)));
  }

  /** A trait's own checkbox: every level of it at once. */
  function toggleTrait(key: string, nextChecked: boolean) {
    beginTick();
    /*
      A trait nobody has edited has nothing to switch on, so ticking its box did nothing
      at all - which is how 暴君 and 暴击伤害 read as rows that cannot be selected. It now
      selects the trait the way the game uses it: a record at the level the tables call
      the default, which is the level a sigil carries (15 for these). The rest of the
      levels stay underneath for anyone who wants them.

      Switching one off keeps the levels that carry typed numbers and drops the rest
      (commit asks isEdit): what is saved is what is switched on or was typed into.
    */
    if (!edits.some((e) => e.key === key)) {
      const level = traits[key]?.Default;
      if (nextChecked && level) commit([...edits, newRecord(key, level, true)]);
      return;
    }
    commit(edits.map((e) => (e.key === key ? { ...e, enabled: nextChecked } : e)));
  }

  /**
    What a tick does before its re-render: remembers the scroll offset (heldScroll) for
    the layout effect that follows, which puts the viewport back where it was and points
    the tooltip at the row now under the pointer.
  */
  function beginTick() {
    heldScroll.current = listBox.current?.scrollTop ?? null;
  }

  /*
    Which row the pointer is over, asked of the document rather than of a hover event:
    after a tick the rows have moved under a pointer that has not, and moving inside a
    row fires no enter either, so hover events cannot say which row is being hovered.
    Called from the layout effect that follows a tick, so the row found here is the one
    under the pointer now - whether it is the row that was ticked or the one that slid
    into its place - and the tooltip simply follows it.
  */
  function resolveHoveredRow() {
    const at = lastMove.current;
    if (!at) return;
    const row = document.elementFromPoint(at.x, at.y)?.closest("[data-row]");
    const id = row?.getAttribute("data-row") ?? null;
    /*
      The move alone here, where restInRow replays the whole way in: the click that
      caused the tick made Base UI close its popup, and a move is the opening its hover
      accepts - a leave first would only close it again, and our open prop has not
      changed for a row that stayed put.
    */
    row?.dispatchEvent(
      new window.MouseEvent("mousemove", { bubbles: true, clientX: at.x, clientY: at.y }),
    );
    setTipRow(id);
  }

  /*
    The pointer enters and leaves rows; the row it is in is the only thing that decides
    whether a tooltip is up (see tipRow). The only thing that changes it is the pointer
    moving from one row to another - or a tick, which moves the rows instead and is
    handled in resolveHoveredRow.
  */
  function restInRow(id: string, e: PointerEvent<HTMLElement>) {
    /*
      Base UI only lets a tooltip follow the cursor when the event it opened on was a
      mouseenter or a mousemove (useClientPoint checks exactly that), and after a click it
      refuses to let hover open at all until the pointer has left the row and come back.
      Focus a value box, switch windows, come back and sweep in, and the record still says
      focus and its own hover is still blocked - so the first tooltip of the visit anchors
      to the middle of the row, and only the second one lands on the cursor.

      The way in is therefore replayed on the row, in full: leave clears that latch, enter
      is the opening it accepts, move carries the pointer's place. resolveHoveredRow needs
      less than this, because there the popup is already open on the row.
    */
    const at = { bubbles: true, clientX: e.clientX, clientY: e.clientY };
    const row = e.currentTarget;
    row.dispatchEvent(new window.MouseEvent("mouseleave", at));
    row.dispatchEvent(new window.MouseEvent("mouseenter", at));
    row.dispatchEvent(new window.MouseEvent("mousemove", at));
    setTipRow(id);
  }

  function leaveRow(id: string) {
    setTipRow((cur) => (cur === id ? null : cur));
  }

  /*
    A value box. Typing into a level that has no edit yet starts one, the way ticking its
    box does - but it does NOT switch it on: the numbers are the user's and are saved,
    and ticking the box is what puts them into the game. An edit that was typed but never
    applied is a state the list shows plainly (its box is empty), not a surprise.

    Only that first keystroke holds the scroll: creating the record can reorder the row
    the caret is in. Every keystroke after it changes numbers in a row that stays put.
  */
  function updateLevel(key: string, level: number, patch: Partial<SigilTrait>) {
    const at = edits.findIndex((e) => e.key === key && e.level === level);
    if (at < 0) {
      beginTick();
      commit([...edits, { ...newRecord(key, level, false), ...patch }]);
      return;
    }
    commit(
      edits.map((e, i) => {
        if (i !== at) return e;
        const next = { ...e, ...patch };
        // Emptying the last number takes the whole edit away: what made it an edit was that
        // number, so the box goes back to the game's value and commit drops the record
        // (this is the one thing that switches an edit off by itself).
        return next.values.some((value) => value !== null)
          ? next
          : { ...next, enabled: false };
      }),
    );
  }

  function toggleOpen(key: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  /*
    The row is a shortcut for the checkbox it holds. Anything the user actually
    aimed at - a value box, the checkbox, the chevron, the delete button - is a
    shadcn control and carries data-slot, so it keeps its own click; the trigger's
    own slot is not a control, so a click on the row still lands here.
  */
  const isControl = (e: MouseEvent<HTMLElement>) =>
    !!(e.target as HTMLElement).closest(
      '[data-slot]:not([data-slot="tooltip-trigger"])',
    );

  /*
    Every edit goes through here: the list on screen is the whole state, and it is also what
    the running game ends up with. What is not an edit is dropped on the way through
    (asEdits) - so ticking a level and unticking it leaves nothing behind, and emptying every
    box of an edit takes the whole edit away.

    The frontend is deliberately dumb about when the write happens. It hands the whole
    list over on every change and does not wait for an answer; the backend's
    trailing debounce turns a burst of keystrokes into a single Config.json write
    and one live apply, and only a list that cannot be accepted at all comes back
    as a failure worth interrupting for.
  */
  function commit(next: SigilTrait[]) {
    const kept = asEdits(next, traits);
    setEdits(kept);
    Call.ByName(`${SERVICE}.SaveEdits`, kept).catch((err) =>
      showError({ title: MESSAGES[lang].writeFailed, detail: String(err) }),
    );
  }

  /*
    The explanation a row shows: the wording that covers its level (see explainAt), with
    each {N} rewritten as the slot it belongs to (see slotLabel).

    The game's placeholders are 0-based ({0} is the first value); the row shows
    numbers, so the tooltip says {1} for the first one and lets the reader count
    along. Substituting the values was the wrong idea: the numbers are already on
    screen, what is not obvious is which of them means what.
  */
  function slotNotation(key: string, level: number): string {
    return slotLabel(explainAt(explains[key], level));
  }

  /*
    Everything a row needs from here, in one object: the copy, the explanation text, the
    two pointer handlers the tooltip runs on, and the edits a row can ask for. The rows
    themselves live in TraitRow.tsx - what they must not know is how the list is
    filtered, ordered or saved.
  */
  const rowCtx: RowContext = {
    t,
    notationOf: slotNotation,
    rest: restInRow,
    leave: leaveRow,
    toggleLevel,
    toggleTrait,
    toggleOpen,
    updateLevel,
    isControl,
  };

  return (
    <div className="fixed inset-0 flex flex-col p-5 pb-6">
      {/*
        One band above the list: how to find a trait in it, and the language
        switch, which has always sat in that corner. Below it the rows own
        everything.
      */}
      <div className="flex shrink-0 items-center gap-2 border-b pb-4">
        {/*
          No heading: the search box says what the band is for, and a count of edits
          would mix two different things - what is on, and how many records exist -
          in one fraction. The list below is the whole catalogue, so browsing it is
          searching it, and what is typed reaches the list debounced (useDebounced),
          which is what keeps a two-hundred row list from being rebuilt on every
          keystroke.
        */}
        <div className="min-w-0 flex-1">
          <InputGroup>
            <InputGroupInput
              ref={searchBox}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t.searchTrait}
              aria-label={t.searchTrait}
            />
            {/*
              A clear button, only while there is something to clear, and the caret
              goes back into the box: the button is what was just clicked and it is
              about to be gone, so without this the next keystroke would go nowhere.
            */}
            {query !== "" && (
              <InputGroupAddon>
                <InputGroupButton
                  size="icon-xs"
                  aria-label={t.clearSearch}
                  onClick={() => {
                    setQuery("");
                    searchBox.current?.focus();
                  }}
                >
                  <X />
                </InputGroupButton>
              </InputGroupAddon>
            )}
          </InputGroup>
        </div>

        {/*
          One joined group: ButtonGroup squares off everything but the outer
          corners and drops the inner borders, so the three read as one control.
          The label is each language's own short form, so it never needs
          translating, and the chosen one keeps the filled (primary) fill. Set a
          little apart from the controls beside it: those belong to the list, this one
          to the interface - the band's own 8px gap plus 8 more.
        */}
        <ButtonGroup className="ml-2">
          {LANGS.map((code) => (
            <Button
              key={code}
              size="sm"
              variant={code === lang ? "default" : "outline"}
              aria-label={code}
              // Fixed width and no padding: the stock sizes are sized for one
              // glyph, which leaves two letters touching the edges.
              className="w-9 px-0"
              onClick={() => setLang(code)}
            >
              {LANG_LABEL[code]}
            </Button>
          ))}
        </ButtonGroup>
      </div>

      {/*
        The rows stop 16px short of the scrollbar, and the scrollbar's width is
        reserved whether or not the list overflows. Filtering down to one row takes
        the scrollbar away, and an unreserved gutter lets every row widen by its
        width and then snap back when the search is cleared - measured as the row
        edge moving 772 -> 787 px.
      */}
      {/*
        The rows carry a class, not a data-slot: a row's click handler treats any
        data-slot above it as a control (that is how a click on the checkbox or a
        value box keeps its own click), so a data-slot on this container swallowed
        every click on a row and a trait could not be opened.
      */}
      {/*
        The 24px above and below the table sits outside the scrolling box (a margin,
        not padding): padding would be part of the scrollable area, so the scrollbar
        would start at the padding's edge instead of at the first row. Only the top one
        is here - the bottom of the shell's padding is set to the same 24px - so the
        scrollbar sits the same distance from the band and from the window edge.
      */}
      <div
        ref={listBox}
        className="trait-rows mt-6 min-h-0 flex-1 overflow-y-auto pr-4 [scrollbar-gutter:stable]"
        onPointerMove={(e) => {
          lastMove.current = { x: e.clientX, y: e.clientY };
        }}
      >
        {/*
          One provider for the list: which tooltip is open is decided here (see tipRow),
          so base-ui's own open/close timing never comes into it - what the provider is
          still for is the rest of the tooltip's setup, which every row shares.
        */}
        <TooltipProvider>
          {rows.map((row) => (
            /*
              The row under the pointer decides which tooltip is up, so every row is told
              that one id and compares it with its own - see tipRow for why the pointer,
              and not a hover event, is what decides.
            */
            <TraitRow
              key={row.key}
              row={row}
              hoveredId={tipRow}
              isOpen={open.has(row.key)}
              ctx={rowCtx}
            />
          ))}
        </TooltipProvider>

        {rows.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {t.noMatch}
          </p>
        )}
      </div>

      {/*
        A failed write is worth interrupting for - the edit is not on disk, and
        the reason is usually something the user has to fix (Config.json locked by
        something else, a folder that cannot be written). Both kinds of failure
        land here: the immediate one, and the debounced one pushed from the
        backend. Closing only closes: the message stays until the next failure
        replaces it, so the fade-out still has something to draw.
      */}
      <AlertDialog
        open={errorOpen}
        onOpenChange={setErrorOpen}
      >
        {/* No size="sm": that switches the footer to a two-column grid, and this
            dialog has a single button that should sit centred. */}
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{error?.title}</AlertDialogTitle>
            <AlertDialogDescription className="wrap-anywhere">
              {error?.detail}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {/* Stock footer and stock button: below the sm breakpoint the footer is
              a column, so the button stretches on its own. No width of our own. */}
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setErrorOpen(false)}>{t.ok}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
