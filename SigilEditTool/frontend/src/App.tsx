import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { Call, Events } from "@wailsio/runtime";
import { ChevronDown, ChevronRight, X } from "lucide-react";

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
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { LANGS, LANG_LABEL, MESSAGES, initialLang, rememberLang, type Lang } from "./i18n";

type SigilTrait = {
  Enabled: boolean;
  Key: string;
  Level: number;
  Values: number[];
  /*
    Which slots someone has actually put a number into, per slot. Only the tool
    uses it, and only to tell apart "this slot shows the game's number" from "this
    slot was typed, and happens to hold the same number" - which is what decides
    whether a slot follows the level. Go ignores the field, so it never reaches
    Config.json or the mod.
  */
  Typed: boolean[];
};

/**
 * One trait's vanilla numbers per level. Levels is indexed by level - 1, so
 * Levels[3] is the row the game shows as level 4 - which is what a slot's
 * placeholder, and the value an emptied box writes back, have to come from.
 * Min/Max are the levels that carry numbers: a trait whose values exist on one
 * level only has Min == Max.
 */
type TraitInfo = { Levels: number[][]; Default: number; Max: number; Min: number };

const SERVICE = "main.EditService";
/*
  Mirrors saveFailedEvent in editservice.go. The debounced write happens after the
  call that asked for it has returned, so a failure there has no answer to return
  and arrives as this event instead.
*/
const SAVE_FAILED = "GBFR.SigilEdit.SaveFailed";
const SLOTS = 10;

/** The typed flags of a level with no edit yet: nobody has typed in any slot. */
const NO_TYPED: boolean[] = Array.from({ length: SLOTS }, () => false);

/** The table row an edit writes: one address per trait hash and level. */
const addressOf = (key: string, level: number) => `${key}#${level}`;

const pad = (values: number[]) =>
  Array.from({ length: SLOTS }, (_, i) => values[i] ?? 0);

/*
  At most one edit per address, which is the invariant the whole list rests on.

  The mod walks the edit list in order and writes every enabled edit into the table
  row its (hash, level) names, so when two of them share an address the last enabled
  one is what the game ends up with (Mod.cs:169 and the patch loop after it). A file
  can still hold both - an older version of this tool wrote them, or someone edited
  Config.json by hand - and the list can only show one of them, so the last enabled
  one is kept (the last of any, when the address holds none that is enabled).
*/
function dedupe(records: SigilTrait[]): { records: SigilTrait[]; changed: boolean } {
  const lastEnabled = new Map<string, number>();
  const lastAny = new Map<string, number>();
  records.forEach((record, i) => {
    const address = addressOf(record.Key, record.Level);
    lastAny.set(address, i);
    if (record.Enabled) lastEnabled.set(address, i);
  });

  const kept = records.filter((record, i) => {
    const address = addressOf(record.Key, record.Level);
    return i === (lastEnabled.get(address) ?? lastAny.get(address));
  });
  return { records: kept, changed: kept.length !== records.length };
}

/** A value as it was a moment ago: the search box filters a 200-row list per keystroke otherwise. */
function useDebounced<T>(value: T, delay = 150): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

/**
 * Ten compact value inputs.
 *
 * Each slot's placeholder is the game's own number for that slot, so an empty box
 * reads as "this one is untouched, it will be written as the game's value".
 *
 * Whether a box is empty is decided by whether the user has typed in it - never by
 * comparing the number to the default. A typed 20 in a slot whose default is 20 is
 * still the user's 20: it stays on screen, and typing 200 into it never wipes what
 * was already typed.
 *
 * Nothing is ever "no input": emptying a box puts that slot back to the game's
 * number, and the table gets a concrete value for every slot either way.
 *
 * A number is what the box shows, not what is typed into it. What is typed has to
 * pass through states that are not numbers yet - "-" on the way to -5, "0." on the
 * way to 0.6 - so the box keeps that half-typed text on screen while it has focus,
 * and drops it on blur. Dropping it is what puts back the value the box started
 * from. As soon as the text is a number it is committed and the box renders from
 * the number instead, which is what makes "06" read back as 6.
 */
/*
  What a box may hold: an optional leading minus sign, digits, and at most one
  decimal point - so "-", "0." and "-.5" are all reachable states, while a second
  minus, a second point, a letter or exponent notation never reach the box. Keeping
  exponent notation out matters: a number input used to accept 1e999, and JSON turns
  that into null, which the tool then saved as a 0.
*/
const HALF_TYPED = /^-?\d*\.?\d*$/;

/** ...and what counts as a number once the box is done with: -3, 30, 0.6, .5 */
const NUMBER = /^-?(\d+(\.\d*)?|\.\d+)$/;

/** The typed flags with one slot set or cleared. */
const withSlot = (typed: boolean[], i: number, set: boolean) => {
  const next = typed.slice();
  next[i] = set;
  return next;
};

function ValueSlots({
  values,
  typed,
  defaults,
  onChange,
}: {
  values: number[];
  typed: boolean[];
  defaults?: number[];
  onChange: (values: number[], typed: boolean[]) => void;
}) {
  // The half-typed text of the box being edited, if any: "-" or "0." cannot be a
  // committed number, so they live here and nowhere else. Dropped on blur.
  const [halfTyped, setHalfTyped] = useState<Record<number, string>>({});

  const vanillaOf = (i: number) => defaults?.[i] ?? 0;

  /*
    The wheel steps a focused box, and the list must not scroll with it.

    React registers wheel listeners as passive, so preventDefault inside an onWheel
    prop does nothing: the browser warns and scrolls the list anyway, while the box
    steps at the same time. The listener therefore has to be a native one, added with
    passive: false - hence the ref, and the latest-props ref that keeps the one
    listener reading the current values.
  */
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef({ values, typed, onChange });
  latest.current = { values, typed, onChange };

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      const target = event.target as HTMLInputElement | null;
      if (!target || document.activeElement !== target) return;
      // Which box it was, by position: the row holds exactly these slots and nothing
      // else, so no index has to be carried through the DOM for this.
      const index = Array.prototype.indexOf.call(element.querySelectorAll("input"), target);
      if (index < 0) return;
      event.preventDefault();
      const { values, typed, onChange } = latest.current;
      const next = [...values];
      next[index] = Math.round((values[index] + (event.deltaY < 0 ? 1 : -1)) * 100) / 100;
      setHalfTyped(({ [index]: _dropped, ...rest }) => rest);
      onChange(next, withSlot(typed, index, true));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  return (
    // The one flexible part of the row: whatever the name and the level do not
    // need goes to the values, and they share it evenly.
    //
    // No cursor-text on the wrapper: each box carries its own, so the I-beam marks
    // exactly the boxes that accept typing, and every box types: a level with no edit
    // yet shows the game's numbers as placeholders and the first keystroke starts it.
    <div ref={host} className="flex min-w-0 flex-1 items-center">
      {Array.from({ length: SLOTS }, (_, i) => (
        <Fragment key={i}>
          {/* Every slot, the first one too: it separates the values from the level
              the same way they are separated from each other. */}
          <span className="shrink-0 text-muted-foreground/40" aria-hidden>
            |
          </span>
          <Input
            type="text"
            inputMode="decimal"
            aria-label={`LevelValue${i + 1}`}
            placeholder={String(vanillaOf(i))}
            // Digits also show when the stored number differs from the game's - a
            // slot edited in Config.json by hand should not look untouched.
            value={
              halfTyped[i] ??
              (typed[i] || values[i] !== vanillaOf(i) ? String(values[i]) : "")
            }
            onChange={(e) => {
              const text = e.target.value;

              // A keystroke that could never become a number - a second minus, a
              // second point, a letter, exponent notation - is dropped, and the box
              // is left showing what it already had.
              if (!HALF_TYPED.test(text)) return;

              if (text === "") {
                // Emptied: the game's own number goes back, its placeholder shows
                // again, and the slot follows the level from here on.
                setHalfTyped(({ [i]: _dropped, ...rest }) => rest);
                const next = [...values];
                next[i] = vanillaOf(i);
                onChange(next, withSlot(typed, i, false));
                return;
              }

              if (!NUMBER.test(text)) {
                // Still half-typed: on screen until it is a number, or until the
                // box is left, which puts back the value it started from.
                setHalfTyped((prev) => ({ ...prev, [i]: text }));
                return;
              }

              // A number: committed, and rendered from the number from here on, so
              // "06" reads back as 6.
              setHalfTyped(({ [i]: _dropped, ...rest }) => rest);
              const next = [...values];
              next[i] = Number(text);
              onChange(next, withSlot(typed, i, true));
            }}
            onBlur={() => setHalfTyped(({ [i]: _dropped, ...rest }) => rest)}
            /*
              Stepping by one, which a number input would have given for free: these
              boxes have to hold "-" and "0." to be typed into, and a number input
              cannot report those. A step replaces whatever was half typed, because
              the number is what the box is for from then on.
            */
            onKeyDown={(e) => {
              // Escape lets go of the box: the list is read with the pointer, so leaving a
              // slot is a blur and nothing else. Whatever was half typed goes back with it,
              // because that is what onBlur already does.
              if (e.key === "Escape") {
                e.currentTarget.blur();
                return;
              }
              if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
              // Otherwise the arrow moves the caret to the end of the box, and on a
              // list that scrolls it would scroll that too.
              e.preventDefault();
              const next = [...values];
              next[i] =
                Math.round((values[i] + (e.key === "ArrowUp" ? 1 : -1)) * 100) / 100;
              setHalfTyped(({ [i]: _dropped, ...rest }) => rest);
              onChange(next, withSlot(typed, i, true));
            }}
            /*
              Bare text, not a field: no border, no fill, no focus ring. The row
              reads as one line of numbers separated by |, and the only chrome left
              is a faint wash on the slot being edited so the caret has a home.

              The box is the height of the row: the row has no padding of its own,
              so the wash that marks the focused slot covers the row top to bottom,
              and a click anywhere in that band lands in the box. A trait's row and
              its levels' rows are then the same height (the multi-level row is h-11
              for the same reason).

              Every box on the row types, whether or not the level is on: a level with
              no edit yet shows the game's numbers as placeholders, and the first
              keystroke or step starts the edit (see updateLevel). So there is no
              disabled state to paint around - only the placeholder, which is what an
              untouched slot in an edited level shows too.
            */
            className="h-11! min-w-0 flex-1 border-0 bg-transparent px-0 text-center text-xs md:text-xs tabular-nums shadow-none focus:bg-muted/50 focus-visible:ring-0 dark:bg-transparent"
          />
        </Fragment>
      ))}
    </div>
  );
}

/**
 * The level a row edits, as text: the level is part of the address the row writes,
 * not a field of its own. A trait that spans several levels opens one row per level,
 * and one whose numbers live on a single level says so here.
 */
function LevelLabel({ level }: { level: number }) {
  return (
    <span className="w-12 shrink-0 text-sm leading-7 text-muted-foreground tabular-nums select-none">
      Lv {level}
    </span>
  );
}

export default function App() {
  const [lang, setLang] = useState<Lang>(initialLang);
  const [edits, setEdits] = useState<SigilTrait[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [traits, setTraits] = useState<Record<string, TraitInfo>>({});
  const [explains, setExplains] = useState<Record<string, string>>({});
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
  /*
    A tick reorders the list - what is on sorts to the top - and the browser follows the
    box that was just clicked, because it still holds focus: it scrolls the row back
    into view, which is what made a tick feel like the list jumped. The offset is taken
    before the tick's re-render and put back after it, so the list moves under the
    pointer instead of moving the viewport.

    The same re-render is when the row under the pointer changes: what was hovered moved
    away and another row slid into its place, so the tooltip is re-pointed at whatever is
    under the pointer now (see resolveHoveredRow) rather than being closed and reopened -
    closing it meant a bubble that vanished and faded back in a moment later, anchored to
    the row instead of the pointer.
  */
  const listBox = useRef<HTMLDivElement>(null);
  const heldScroll = useRef<number | null>(null);
  const ticked = useRef(false);
  /*
    Where the pointer last moved. A tick moves the rows under a pointer that has not
    moved, and moving inside a row fires no enter either, so neither the browser's hover
    nor our own enter/leave can say which row is being hovered after a tick.
  */
  const lastMove = useRef<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    if (!ticked.current) return;
    ticked.current = false;
    if (listBox.current && heldScroll.current !== null) {
      listBox.current.scrollTop = heldScroll.current;
    }
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
        setExplains((texts ?? {}) as Record<string, string>);
      })
      .catch((err) => showError({ title: t.readFailed, detail: String(err) }));
  }, [lang]);

  async function loadAll() {
    const [list, traitMap] = await Promise.all([
      Call.ByName(`${SERVICE}.LoadEdits`) as Promise<SigilTrait[]>,
      Call.ByName(`${SERVICE}.TraitMap`) as Promise<Record<string, TraitInfo>>,
    ]);
    /*
      A record whose Key is not a hex hash is not an edit at all: the mod parses the
      Key as hex before it looks at any row and skips the record when that fails, so
      the tool ignores it too instead of showing a row that can never write anything.
      A hash the name table does not know is kept: the mod does apply those, and an
      edit nobody can see is worse than one whose name is only a hash.
    */
    const hexKey = /^[0-9a-f]{1,8}$/i;
    const loaded = (list ?? [])
      .filter((e) => hexKey.test(String(e.Key ?? "").trim()))
      .map((e) => {
        // Every table the tool serves is keyed by the uppercase hash, and a Key
        // written into Config.json by hand can be lower case. Normalising here is
        // what lets every lookup below use the Key as it stands, instead of the
        // half-dozen call sites that used to uppercase it for themselves.
        const key = e.Key.toUpperCase();
        const values = pad(e.Values ?? []);
        // A number that is not the level's own was put there by someone - by hand
        // in Config.json, or on a level this edit has since left - so it counts as
        // typed and stops following the level.
        const vanilla = traitMap?.[key]?.Levels?.[e.Level - 1];
        return {
          ...e,
          Key: key,
          Values: values,
          Typed: values.map((value, i) => value !== (vanilla?.[i] ?? value)),
        };
      });
    // A file can hold two edits for one address. Only one of them can ever be in
    // effect, and the list has room for exactly one, so the pruned list is written
    // straight back: the file then says what the tool shows and the game does.
    const { records, changed } = dedupe(loaded);
    setEdits(records);
    setTraits(traitMap ?? {});
    if (changed) {
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
      const held = byKey.get(record.Key);
      if (held) held.push(record);
      else byKey.set(record.Key, [record]);
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
        const byLevel = new Map(records.map((record) => [record.Level, record]));
        const label = names[key] ?? key;

        const levels = new Set<number>();
        if (info) {
          // The levels the trait's own numbers live on. A trait whose values exist
          // on one level only has Min == Max, and is a row with no children.
          for (let level = info.Min; level <= info.Max; level++) levels.add(level);
        }
        // A level only the records know about - edited by hand, or left behind by a
        // level the tables no longer carry - still gets a row, so it stays visible
        // instead of being applied invisibly.
        for (const record of records) levels.add(record.Level);

        // Enabled levels first, then the levels carrying a switched-off edit, then
        // the untouched ones - each group in ascending order.
        const rank = (level: number) => {
          const record = byLevel.get(level);
          return record ? (record.Enabled ? 0 : 1) : 2;
        };

        return {
          key,
          label,
          info,
          records,
          byLevel,
          enabled: records.some((record) => record.Enabled),
          levels: [...levels].sort((a, b) => rank(a) - rank(b) || a - b),
        };
      })
      // The trait's hash matches too, so a row can be found by the number the tables
      // and Config.json use - which is how a single row is put on screen for testing.
      .filter(
        (row) =>
          !needle ||
          row.label.toLowerCase().includes(needle) ||
          row.key.toLowerCase().includes(needle),
      )
      .sort(
        (a, b) =>
          Number(b.enabled) - Number(a.enabled) ||
          a.label.localeCompare(b.label, "zh-Hans-CN"),
      );
  }, [edits, names, traits, search]);

  /** The edit a level's checkbox starts, from the game's own row for that level. */
  function newRecord(key: string, level: number): SigilTrait {
    return {
      Enabled: true,
      Key: key,
      Level: level,
      // The level's own numbers, not zeros: leaving every slot alone has to write
      // the game's row back untouched. Nothing is typed yet, so every slot still
      // reads as the game's number and follows the level.
      Values: pad(traits[key]?.Levels?.[level - 1] ?? []),
      Typed: Array.from({ length: SLOTS }, () => false),
    };
  }

  /*
    One level's checkbox. With no edit at that address yet, ticking it is what
    creates one; unticking only switches the edit off - the numbers stay, and they
    are still there when it is ticked again.
  */
  function toggleLevel(key: string, level: number) {
    beginTick();
    const at = edits.findIndex((e) => e.Key === key && e.Level === level);
    if (at < 0) {
      commit([...edits, newRecord(key, level)]);
      return;
    }
    commit(edits.map((e, i) => (i === at ? { ...e, Enabled: !e.Enabled } : e)));
  }

  /** A trait's own checkbox: every level of it at once. */
  function toggleTrait(key: string, enable: boolean) {
    beginTick();
    /*
      A trait nobody has edited has nothing to switch on, so ticking its box did nothing
      at all - which is how 暴君 and 暴击伤害 read as rows that cannot be selected. It now
      selects the trait the way the game uses it: a record at the level the tables call
      the default, which is the level a sigil carries (15 for these). The rest of the
      levels stay underneath for anyone who wants them, and unticking still just switches
      off what is there.
    */
    if (!edits.some((e) => e.Key === key)) {
      const level = traits[key]?.Default;
      if (enable && level) commit([...edits, newRecord(key, level)]);
      return;
    }
    commit(edits.map((e) => (e.Key === key ? { ...e, Enabled: enable } : e)));
  }

  /**
    What a tick does before its re-render: keeps the list's scroll offset (see
    heldScroll) and asks for the hovered row to be worked out again (see the layout
    effect) - a tick reorders the rows, and both the viewport and the tooltip have to
    end up where the pointer is rather than where the row that moved went.
  */
  function beginTick() {
    heldScroll.current = listBox.current?.scrollTop ?? null;
    ticked.current = true;
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
    /*
      The move that would have carried the pointer onto this row is replayed on it, at
      the place the pointer already is. Base UI only lets a tooltip follow the cursor when
      its own hover opened it (useClientPoint checks that the opening event was a
      mouseenter or a mousemove), and a tick produces no hover at all - without this, the
      tooltip that follows the pointer anchors to the middle of the row instead.
    */
    if (row) {
      row.dispatchEvent(
        new window.MouseEvent("mousemove", { bubbles: true, clientX: at.x, clientY: at.y }),
      );
    }
    setTipRow(row?.getAttribute("data-row") ?? null);
  }

  /*
    The pointer enters and leaves rows; the row it is in is the only thing that decides
    whether a tooltip is up (see tipRow). The only thing that changes it is the pointer
    moving from one row to another - or a tick, which moves the rows instead and is
    handled in resolveHoveredRow.
  */
  function restInRow(id: string, e: PointerEvent<HTMLElement>) {
    /*
      Whichever way the tooltip opens, Base UI only lets it follow the cursor if the
      opening event on its record is a mouseenter or a mousemove (useClientPoint checks
      exactly that), and after a click it refuses to let hover open at all until the
      pointer has left and come back. Focus a value box, switch windows, come back and
      sweep into the row, and the record still says focus, its own hover is still blocked
      - so the first tooltip of the visit anchors to the row, and only the second one,
      after the blocked attempt has cleared the latch, lands on the cursor.

      The way in is therefore replayed in full on the row: leave (which clears that
      latch), enter (which is the hover opening Base UI will accept), then the move that
      carries the pointer's place.
    */
    const row = e.currentTarget;
    const at = { bubbles: true, clientX: e.clientX, clientY: e.clientY };
    row.dispatchEvent(new window.MouseEvent("mouseleave", at));
    row.dispatchEvent(new window.MouseEvent("mouseenter", at));
    row.dispatchEvent(new window.MouseEvent("mousemove", at));
    setTipRow(id);
  }

  function leaveRow(id: string) {
    setTipRow((cur) => (cur === id ? null : cur));
  }

  function updateLevel(key: string, level: number, patch: Partial<SigilTrait>) {
    beginTick();
    /*
      Typing into a level that has no edit yet starts one, the way ticking its box does:
      every box on the row is typeable whether or not the level is on (the numbers shown
      are the game's own until then), and an edit that was typed but never applied would
      be the surprise. The rest of the record is the game's row for that level.
    */
    const at = edits.findIndex((e) => e.Key === key && e.Level === level);
    if (at < 0) {
      commit([...edits, { ...newRecord(key, level), ...patch }]);
      return;
    }
    commit(edits.map((e, i) => (i === at ? { ...e, ...patch } : e)));
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
    Every edit goes through here: the list on screen is the whole state, and it is
    also what the running game ends up with.

    The frontend is deliberately dumb about when that happens. It hands the whole
    list over on every change and does not wait for an answer; the backend's
    trailing debounce turns a burst of keystrokes into a single Config.json write
    and one live apply, and only a list that cannot be accepted at all comes back
    as a failure worth interrupting for.
  */
  function commit(next: SigilTrait[]) {
    setEdits(next);
    Call.ByName(`${SERVICE}.SaveEdits`, next).catch((err) =>
      showError({ title: MESSAGES[lang].writeFailed, detail: String(err) }),
    );
  }

  /*
    The trait's own explanation, with each {N} rewritten as the slot it belongs to.

    The game's placeholders are 0-based ({0} is the first value); the row shows
    numbers, so the tooltip says {1} for the first one and lets the reader count
    along. Substituting the values was the wrong idea: the numbers are already on
    screen, what is not obvious is which of them means what.
  */
  function slotNotation(key: string): string {
    const text = explains[key];
    if (!text) return "";
    return text.replace(/\{(\d+)\}/g, (_, d) => `{${Number(d) + 1}}`);
  }

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
          One provider for the list, at a short delay: the browser's own title took
          about a second, and moving down the rows shows each one straight away
          once the first is up.
        */}
        <TooltipProvider delay={300}>
          {rows.map((row) => {
            const notation = slotNotation(row.key);
            const on = row.records.filter((record) => record.Enabled).length;
            const allOn = row.records.length > 0 && on === row.records.length;
            const isOpen = open.has(row.key);

            /*
              One level of a trait: its checkbox - ticking it is what starts an
              edit there - its level, its ten slots, and, only while an edit
              exists, the way to drop it. A level with no edit shows the game's own
              numbers as placeholders in boxes that cannot be typed into.

              Every row has the same shape and carries the trait's own tooltip: the
              description covers the whole row, so any part of the row is a
              reasonable place to ask.
            */
            const levelRow = (level: number, nested: boolean) => {
              const record = row.byLevel.get(level);
              return (
                <Tooltip
                  key={addressOf(row.key, level)}
                  open={Boolean(notation) && tipRow === addressOf(row.key, level)}
                  disabled={!notation}
                  disableHoverablePopup
                  trackCursorAxis="x"
                >
                  {/*
                    The trigger is the whole row, its checkbox included: the trait's
                    explanation is worth asking for anywhere on the row, and the box is
                    where the pointer already is when a level is being switched.

                    Whether the tooltip is open is decided here, from the pointer alone -
                    see the note on tipRow. What is left to base-ui is the placement,
                    and the two switches it needs: the popup sits over the row above the
                    one being hovered, so it must not take the pointer (or that row can
                    never be hovered) and it must not stay open while the pointer is
                    inside the popup's own box.

                    A div, not the button a trigger renders by default: the row holds
                    value boxes and a checkbox, and interactive content cannot live
                    inside a button.
                  */}
                  <TooltipTrigger
                    data-row={addressOf(row.key, level)}
                    onPointerEnter={(e) => restInRow(addressOf(row.key, level), e)}
                    onPointerLeave={() => leaveRow(addressOf(row.key, level))}
                    render={
                      <div
                        className={`flex items-center gap-2 border-b last:border-b-0 ${
                          nested ? "pl-9" : ""
                        }`}
                      />
                    }
                  >
                    <Checkbox
                      checked={record?.Enabled ?? false}
                      // 2px of room on the left: the row's first child is the box, and
                      // a focus ring grows outward, so without this the container's edge
                      // clipped the ring.
                      className="ml-0.5"
                      aria-label={t.enable(`${row.label} Lv${level}`)}
                      onCheckedChange={() => toggleLevel(row.key, level)}
                    />

                    {!nested && (
                      <span
                        /*
                          A fixed width, not a flexible one: the name and the
                          level have to stay together, and the value boxes are
                          what should absorb a wider window. 217px covers the
                          longest name in any of the three languages
                          ("スーパーアルティメットJust回避"), with only a few
                          pixels to spare; anything longer truncates, with the
                          tooltip carrying the whole one.
                        */
                        className="w-[217px] shrink-0 truncate text-sm"
                      >
                        {row.label}
                      </span>
                    )}

                    <LevelLabel level={level} />

                    <ValueSlots
                      values={
                        record ? record.Values : pad(row.info?.Levels?.[level - 1] ?? [])
                      }
                      typed={record ? record.Typed : NO_TYPED}
                      defaults={row.info?.Levels?.[level - 1]}
                      onChange={(values, typed) =>
                        updateLevel(row.key, level, { Values: values, Typed: typed })
                      }
                    />
                  </TooltipTrigger>
                  {/*
                    Above the row and centred on it: every row reads the same way,
                    and the list under the pointer is never covered. Wider than the
                    stock bubble, and keeping the line breaks the game's own text
                    has - some explanations are three lines of parameters, and a
                    one-line bubble would cut them off.
                  */}
                  <TooltipContent
                    side="top"
                    align="center"
                    className="max-w-md items-start whitespace-pre-line data-open:animate-none data-closed:animate-none"
                  >
                    {notation}
                  </TooltipContent>
                </Tooltip>
              );
            };

            /*
              A trait whose numbers live on a single level is just that row. One
              that spans several opens into them - the edited levels first,
              ascending, the untouched ones after them - and its own checkbox is
              then all of its levels at once: ticked when they are all on, mixed
              when some are, empty when none are.
            */
            if (row.levels.length === 1) return levelRow(row.levels[0], false);

            return (
              <Fragment key={row.key}>
                <Tooltip
                  open={Boolean(notation) && tipRow === row.key}
                  disabled={!notation}
                  disableHoverablePopup
                  trackCursorAxis="x"
                >
                  <TooltipTrigger
                    data-row={row.key}
                    onPointerEnter={(e) => restInRow(row.key, e)}
                    onPointerLeave={() => leaveRow(row.key)}
                    /*
                      The trigger is the row, checkbox included, and the row is also
                      what opens the trait: a click anywhere but on a control toggles
                      it (the chevron is an icon, not a second control).
                    */
                    render={
                      <div
                        onClick={(e) => {
                          if (isControl(e)) return;
                          toggleOpen(row.key);
                        }}
                        className="flex h-11 items-center gap-2 border-b"
                      />
                    }
                  >
                    <span className="relative ml-0.5 inline-flex shrink-0">
                      <Checkbox
                        checked={allOn}
                        indeterminate={on > 0 && !allOn}
                        aria-label={t.enable(row.label)}
                        onCheckedChange={() => toggleTrait(row.key, !allOn)}
                      />
                      {on > 0 && !allOn && (
                        /*
                          A dash of the row's making, because the geometry is the whole
                          point of it: a horizontal stroke has to sit on the centre of a
                          pixel row or it blurs across two. Lucide's minus puts its line
                          at y=12 of a 24-unit box, which is exactly y=7.0 of the 14px
                          the indicator draws at - a pixel boundary, and it came out
                          fuzzy next to the check. This is the same line (lucide's
                          x 5..19, stroke 2.3 of 24) in a 14-unit box where y=7.5 is the
                          middle of row 7, so it renders solid.
                        */
                        <svg
                          aria-hidden
                          viewBox="0 0 14 14"
                          className="pointer-events-none absolute inset-0 m-auto size-3.5 text-primary-foreground"
                        >
                          <line
                            x1="2.92"
                            y1="7.5"
                            x2="11.08"
                            y2="7.5"
                            stroke="currentColor"
                            strokeWidth="1.34"
                            strokeLinecap="round"
                          />
                        </svg>
                      )}
                    </span>

                    <span className="w-[217px] shrink-0 truncate text-sm">
                      {row.label}
                    </span>

                    <span className="flex-1" />

                    {/*
                      The disclosure, as a plain icon: no click of its own, no
                      background of its own. Opening the trait is the row's job - the
                      row is what the pointer is on when it means "this trait" - and an
                      icon that answered a click would be a second, quieter control for
                      the same thing. As a ghost button it also painted a wash under the
                      pointer, which read as a button with something to do.
                    */}
                    <span
                      aria-hidden
                      className="grid size-7 shrink-0 place-content-center text-muted-foreground"
                    >
                      {isOpen ? (
                        <ChevronDown className="size-4" />
                      ) : (
                        <ChevronRight className="size-4" />
                      )}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent
                    side="top"
                    align="center"
                    className="max-w-md items-start whitespace-pre-line data-open:animate-none data-closed:animate-none"
                  >
                    {notation}
                  </TooltipContent>
                </Tooltip>

                {isOpen && row.levels.map((level) => levelRow(level, true))}
              </Fragment>
            );
          })}
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
