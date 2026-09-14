import { Fragment, useEffect, useMemo, useState } from "react";
import { Call } from "@wailsio/runtime";
import { Trash2 } from "lucide-react";

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
import { SkillPicker, type PickerItem } from "./SkillPicker";
import { LANGS, LANG_LABEL, MESSAGES, initialLang, rememberLang, type Lang } from "./i18n";

type SkillEdit = {
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
 * One skill's vanilla numbers per level. Levels is indexed by level - 1, so
 * Levels[3] is the row the game shows as level 4 - which is what a slot's
 * placeholder, and the value an emptied box writes back, have to come from.
 * Min/Max are the levels that carry numbers: a skill whose values exist on one
 * level only has Min == Max.
 */
type SkillInfo = { Levels: number[][]; Default: number; Max: number; Min: number };

const SERVICE = "main.EditService";
const SLOTS = 10;

/*
  A number input draws its own spinner arrows, which ignore the theme and look
  like a light-mode form control next to everything else. These fields are typed
  into, never stepped.
*/
const NO_SPINNER =
  "[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none";

/** Two edits collide when they write the same row: same hash and same level. */
const target = (e: SkillEdit) => `${e.Key}@${e.Level}`;

/*
  A row's React key must not depend on that row's own fields.

  Keying on the row address made changing the Level swap the key, so React tore
  the row down and rebuilt it mid-keystroke and the caret fell out of the input
  after a single character. The hash plus the position in the unsorted list is
  stable for every edit that does not add or remove a row.
*/
const rowId = (e: SkillEdit, index: number) => `${e.Key}#${index}`;

const pad = (values: number[]) =>
  Array.from({ length: SLOTS }, (_, i) => values[i] ?? 0);

/*
  Enforce "at most one enabled edit per row address".

  Which survivor to keep depends on why we are normalising:
    - keepIndex given (a user just clicked that row): that row wins, everything
      else writing the same address is switched off.
    - no keepIndex (data freshly read from disk): the LAST enabled edit wins,
      matching the mod's own "later entry overrides earlier" rule.

  Without the keepIndex case, ticking a row that sits earlier in the list would be
  undone by its own normalisation and the user could never select it.
*/
function enforceExclusivity(items: SkillEdit[], keepIndex?: number): SkillEdit[] {
  // The address the clicked row writes; nothing is kept when normalising from disk.
  const keep = keepIndex !== undefined ? target(items[keepIndex]) : undefined;

  const winner = new Map<string, number>();
  items.forEach((e, i) => {
    if (!e.Enabled) return;
    const address = target(e);
    if (address === keep) winner.set(address, keepIndex!);
    else if (keepIndex === undefined || !winner.has(address)) winner.set(address, i);
  });

  return items.map((e, i) =>
    e.Enabled && winner.get(target(e)) !== i ? { ...e, Enabled: false } : e,
  );
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
 */
/*
  What a value box may hold while it is being typed: an optional minus sign, digits,
  and at most one decimal point - so "-", "0." and "-.5" are all reachable states.
  A keystroke or paste that would put anything else in the box is simply dropped,
  which is how exponent notation stays out: a number input used to accept 1e999, and
  JSON turns that into null, which the tool then saved as a 0.
*/
const PARTIAL_NUMBER = /^-?\d*\.?\d*$/;

/** ...and what counts as a number once the box is done with: -3, 30, 0.6, .5 */
const NUMBER = /^-?(\d+(\.\d*)?|\.\d+)$/;

/** The typed flags with one slot set or cleared. */
const withSlot = (typed: boolean[], i: number, set: boolean) => {
  const next = typed.slice();
  next[i] = set;
  return next;
};

/**
 * What an edit's values become when it moves to another level: a slot nobody has
 * typed follows the level, and one that was typed keeps its number - even when that
 * number happens to equal the level's own, which is why this cannot be decided by
 * comparing values.
 */
function valuesForLevel(
  values: number[],
  typed: boolean[],
  now: number[] | undefined,
): number[] {
  if (!now) return values;
  return values.map((value, i) => (typed[i] ? value : (now[i] ?? value)));
}

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
  // What is actually in a box while it has focus. Without this a half-typed "-" or
  // "0." could not stay on screen: the box would snap back to the committed number
  // on the next render. Dropped on blur, so a half-typed entry falls back to the
  // value it started from.
  const [drafts, setDrafts] = useState<Record<number, string>>({});

  const vanillaOf = (i: number) => defaults?.[i] ?? 0;

  return (
    // The one flexible part of the row: whatever the name and the level do not
    // need goes to the values, and they share it evenly.
    <div className="flex min-w-0 flex-1 items-center">
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
              drafts[i] ??
              (typed[i] || values[i] !== vanillaOf(i) ? String(values[i]) : "")
            }
            onChange={(e) => {
              const text = e.target.value;
              if (!PARTIAL_NUMBER.test(text)) return;

              // Whatever survived the filter is what the box shows from here.
              setDrafts((prev) => ({ ...prev, [i]: text }));

              if (text === "") {
                // Emptied: the game's own value goes back, its placeholder shows
                // again, and the slot follows the level from here on.
                const next = [...values];
                next[i] = vanillaOf(i);
                onChange(next, withSlot(typed, i, false));
                return;
              }

              // A number commits. Anything else is half-typed, so it stays on screen
              // and the committed numbers are left alone until it becomes one.
              if (NUMBER.test(text)) {
                const next = [...values];
                next[i] = Number(text);
                onChange(next, withSlot(typed, i, true));
              }
            }}
            onBlur={() => setDrafts(({ [i]: _dropped, ...rest }) => rest)}
            /*
              Bare text, not a field: no border, no fill, no focus ring. The row
              reads as one line of numbers separated by |, and the only chrome left
              is a faint wash on the slot being edited so the caret has a home.
            */
            className="h-7 min-w-0 flex-1 border-0 bg-transparent px-0 text-center text-xs md:text-xs tabular-nums shadow-none focus:bg-muted/50 focus-visible:ring-0 dark:bg-transparent"
          />
        </Fragment>
      ))}
    </div>
  );
}

/**
 * The level the game shows for this row, with the skill's own range beside it and
 * the field clamped to that range. A skill whose numbers exist on one level only
 * has min == max, and the field then says so rather than accepting a level the game
 * keeps empty.
 */
function LevelInput({
  level,
  min,
  max,
  label,
  onChange,
}: {
  level: number;
  min: number;
  max: number;
  label: string;
  onChange: (level: number) => void;
}) {
  return (
    /*
      Not an InputGroup: that whole component exists to draw a box around a field
      and its prefix, and this field has no box. A label next to a bare input
      matches the value slots beside it exactly.
    */
    <div className="flex h-7 shrink-0 items-center gap-0.5">
      {/*
        leading-7 on the text and h-7 with no padding on the input: otherwise the
        three sit in boxes of different heights and the digits drift off the
        baseline the labels are on.
      */}
      <span className="text-sm leading-7 text-muted-foreground select-none">Lv</span>
      <Input
        type="number"
        aria-label={label}
        min={min}
        max={max}
        value={level}
        onChange={(e) => {
          const typed = Number(e.target.value);
          const wanted = Number.isFinite(typed) ? Math.round(typed) : min;
          onChange(Math.max(min, Math.min(max, wanted)));
        }}
        // Narrow and left-aligned, so the digits sit against "Lv" and the
        // separator that follows them.
        className={`h-7 w-5 min-w-0 border-0 bg-transparent px-0 py-0 ml-0.5 text-left text-sm tabular-nums shadow-none focus:bg-muted/50 focus-visible:ring-0 dark:bg-transparent ${NO_SPINNER}`}
      />
      <span className="text-sm leading-7 text-muted-foreground tabular-nums select-none">
        / {max}
      </span>
    </div>
  );
}

export default function App() {
  const [lang, setLang] = useState<Lang>(initialLang);
  const [edits, setEdits] = useState<SkillEdit[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [skills, setSkills] = useState<Record<string, SkillInfo>>({});
  const [explains, setExplains] = useState<Record<string, string>>({});
  // Where Reloaded-II usually lands, shown greyed until a folder is picked.
  const [defaultDir, setDefaultDir] = useState("");
  const [modsDir, setModsDir] = useState("");
  // "" once we know Reloaded-II cannot be found; null while still asking.
  const [reloadedDir, setReloadedDir] = useState<string | null>(null);
  const [error, setError] = useState<{ title: string; detail: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [newKey, setNewKey] = useState("");

  const t = MESSAGES[lang];

  /*
    Skill names come from the game's own text for the chosen language, so they are
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
      .catch((err) => setError({ title: t.readFailed, detail: String(err) }));
  }, [lang]);

  /*
    The Reloaded-II folder is the user's to name: it is portable, and everything
    the tool shows depends on the answer, which is why picking one reloads all of it.
  */
  async function loadAll() {
    const [list, skillMap, dir, root, fallback] = await Promise.all([
      Call.ByName(`${SERVICE}.LoadEdits`) as Promise<SkillEdit[]>,
      Call.ByName(`${SERVICE}.SkillMap`) as Promise<Record<string, SkillInfo>>,
      Call.ByName(`${SERVICE}.ModsDir`) as Promise<string>,
      Call.ByName(`${SERVICE}.ReloadedDir`) as Promise<string>,
      Call.ByName(`${SERVICE}.DefaultReloadedDir`) as Promise<string>,
    ]);
    const loaded = enforceExclusivity(
      (list ?? []).map((e) => {
        const values = pad(e.Values ?? []);
        // A number that is not the level's own was put there by someone - by hand
        // in Config.json, or on a level this edit has since left - so it counts as
        // typed and stops following the level.
        const vanilla = skillMap?.[e.Key.toUpperCase()]?.Levels?.[e.Level - 1];
        return {
          ...e,
          Values: values,
          Typed: values.map((value, i) => value !== (vanilla?.[i] ?? value)),
        };
      }),
    );
    setEdits(loaded);
    setSkills(skillMap ?? {});
    setModsDir(dir ?? "");
    setReloadedDir(root ?? "");
    setDefaultDir(fallback ?? "");

    // The file on disk may hold several enabled edits for one row. Nothing is
    // written here: the normalised list is what the Install button writes.
  }

  useEffect(() => {
    loadAll().catch((err) => setError({ title: t.readFailed, detail: String(err) }));
  }, []);

  async function chooseReloadedDir() {
    try {
      const chosen = (await Call.ByName(
        `${SERVICE}.ChooseReloadedDir`,
        lang,
      )) as string;
      if (!chosen) return; // cancelled
      await loadAll();
    } catch (err) {
      setError({ title: t.chooseFailed, detail: String(err) });
    }
  }

  /** Every skill that has a display name, alphabetical. */
  const pickerItems: PickerItem[] = useMemo(
    () =>
      Object.entries(names)
        .map(([value, label]) => ({ value, label }))
        .sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN")),
    [names],
  );

  const shown = useMemo(() => {
    const label = (e: SkillEdit) => names[e.Key] ?? e.Key;
    return edits
      .map((edit, index) => ({ edit, index }))
      .sort((a, b) => {
        const byName = label(a.edit).localeCompare(label(b.edit), "zh-Hans-CN");
        return byName !== 0 ? byName : a.index - b.index;
      });
  }, [edits, names]);

  /*
    Installing is the only thing that writes.

    Editing the list changes what is on screen and nothing else, so the mod's files
    and Config.json change only when the user asks for it - a keystroke used to
    re-deploy the whole mod. A failure is therefore only possible from the button,
    and is the one thing worth interrupting for.
  */
  async function install(items: SkillEdit[]) {
    setBusy(true);
    try {
      await Call.ByName(`${SERVICE}.Install`, items);
      setError(null);
    } catch (err) {
      setError({ title: t.writeFailed, detail: String(err) });
    } finally {
      setBusy(false);
    }
  }

  /*
    Flip one checkbox and re-apply the invariant, keeping the row the user just
    clicked and clearing any other edit that writes the same address.
  */
  function toggle(rowIndex: number) {
    const flipped = edits.map((item, i) =>
      i === rowIndex ? { ...item, Enabled: !item.Enabled } : item,
    );
    commit(
      enforceExclusivity(flipped, flipped[rowIndex].Enabled ? rowIndex : undefined),
    );
  }

  /** Replace one edit, then re-apply the invariant around it. */
  function update(rowIndex: number, patch: Partial<SkillEdit>) {
    const next = edits.map((item, i) =>
      i === rowIndex ? { ...item, ...patch } : item,
    );
    commit(enforceExclusivity(next, next[rowIndex].Enabled ? rowIndex : undefined));
  }

  /*
    Moving to another level takes the untouched slots with it.

    A slot nobody has typed is only showing the game's number, so it becomes the new
    level's number. Whatever was typed stays exactly as typed - including a number
    that happens to equal one of the levels' own, which is the case the old
    compare-the-values rule got wrong.
  */
  function changeLevel(rowIndex: number, level: number) {
    const edit = edits[rowIndex];
    const now = skills[edit.Key.toUpperCase()]?.Levels?.[level - 1];
    update(rowIndex, { Level: level, Values: valuesForLevel(edit.Values, edit.Typed, now) });
  }

  function remove(rowIndex: number) {
    commit(enforceExclusivity(edits.filter((_, i) => i !== rowIndex)));
  }

  /*
    A new edit starts from the skill's own vanilla LevelValue1..10 rather than
    zeros, so the only thing to change is the number being tuned, and on the level
    that skill keeps its values on - which is not 15 for every skill. Unknown keys
    fall back to the old behaviour.
  */
  function add() {
    if (!newKey) return;
    const key = newKey.toUpperCase();
    // The row of the level the edit starts on, not some other level's numbers:
    // leaving every slot alone has to write the game's own row back untouched.
    const level = skills[key]?.Default ?? 15;
    const next = [
      ...edits,
      {
        Enabled: true,
        Key: newKey,
        Level: level,
        Values: pad(skills[key]?.Levels?.[level - 1] ?? []),
        // Nothing is typed yet: every slot starts out as the level's own numbers,
        // so they all follow the level until someone sets one.
        Typed: Array.from({ length: SLOTS }, () => false),
      },
    ];
    setNewKey("");
    commit(enforceExclusivity(next, next.length - 1));
  }

  /** Every edit goes through here: the list on screen is the whole state. */
  function commit(next: SkillEdit[]) {
    setEdits(next);
  }

  /*
    The skill's own explanation, with each {N} rewritten as the slot it belongs to.

    The game's placeholders are 0-based ({0} is the first value); the row shows
    numbers, so the tooltip says {1} for the first one and lets the reader count
    along. Substituting the values was the wrong idea: the numbers are already on
    screen, what is not obvious is which of them means what.
  */
  function slotNotation(key: string): string {
    const text = explains[key.toUpperCase()];
    if (!text) return "";
    return text.replace(/\{(\d+)\}/g, (_, d) => `{${Number(d) + 1}}`);
  }

  const enabledCount = edits.filter((e) => e.Enabled).length;

  return (
    <div className="fixed inset-0 flex flex-col gap-4 p-5">
      {/*
        Two bands, both above the list. The first is what installing means right
        now - where it goes, the button that does it, and the language switch,
        which has always sat in that corner. The second is what is about to be
        added. Below them the rows own everything.
      */}
      <div className="flex shrink-0 items-center gap-2">
        {/* Both rows label their control with the same fixed width, so the two
            inputs sit in one column instead of the second one being indented by
            the first one's missing label. */}
        <span className="w-28 shrink-0 text-sm font-semibold whitespace-nowrap">
          {t.installTo}
        </span>

        {/*
          The folder itself is the control, the way the skill picker works: one
          outlined box that opens a dialog. Until one is chosen the box shows
          where Reloaded-II usually lands, greyed like any placeholder - nothing
          is searched for.
        */}
        <Button
          variant="outline"
          onClick={chooseReloadedDir}
          disabled={busy}
          aria-label={t.chooseReloaded}
          title={reloadedDir || defaultDir}
          // Hand cursor: this box is a control that opens a dialog, not a button
          // that does something, and it reads as a field.
          className="min-w-0 flex-1 cursor-pointer justify-start font-normal"
        >
          <span
            className={`truncate text-xs ${
              reloadedDir ? "text-muted-foreground" : "text-muted-foreground/50"
            }`}
          >
            {reloadedDir ? `${modsDir}\\GBFR.SkillEdit` : defaultDir}
          </span>
        </Button>

        {/*
          The label never changes. Swapping it for a progress word resized the
          button by 9px, which slid the target line next to it back and forth.
          The disabled state is the feedback while the write is in flight.
        */}
        <Button
          onClick={() => install(edits)}
          disabled={busy || shown.length === 0 || !reloadedDir}
        >
          {t.install}
        </Button>

        {/*
          One joined group: ButtonGroup squares off everything but the outer
          corners and drops the inner borders, so the three read as one control.
          The label is each language's own short form, so it never needs
          translating, and the chosen one keeps the filled (primary) fill.
        */}
        <ButtonGroup>
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

      <div className="flex shrink-0 items-center gap-2 border-b pb-4">
        <h1 className="w-28 shrink-0 text-sm font-semibold whitespace-nowrap">
          {t.title(enabledCount, edits.length)}
        </h1>

        <div className="min-w-0 flex-1">
          <SkillPicker
            items={pickerItems}
            value={newKey}
            placeholder={t.pickSkill}
            searchPlaceholder={t.searchSkill}
            emptyLabel={t.noMatch}
            onSelect={setNewKey}
          />
        </div>

        {/* 108px = the language group's 3 x 36, so the two rows' right edges line
            up on the same grid. */}
        <Button onClick={add} disabled={!newKey} className="w-[108px] shrink-0">
          {t.add}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown.map(({ edit, index }) => {
          const name = names[edit.Key] ?? "";
          return (
            <div
              key={rowId(edit, index)}
              onClick={(e) => {
                /*
                  The row is a shortcut for its own checkbox. Anything the user
                  actually aimed at - a value box, the level field, the picker, the
                  delete button, the checkbox itself - is a shadcn component and
                  carries data-slot, so it keeps its own click.
                */
                if ((e.target as HTMLElement).closest("[data-slot]")) return;
                toggle(index);
              }}
              /*
                On the row rather than on the name: the labels describe the row as
                a whole, so any part of it is a reasonable place to ask. Nothing
                in the row carries a title of its own, so the hover always lands
                here.
              */
              title={slotNotation(edit.Key) || undefined}
              className="flex cursor-pointer items-center gap-2 border-b py-1.5 last:border-b-0"
            >
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <Checkbox
                  checked={edit.Enabled}
                  aria-label={t.enable(name || edit.Key)}
                  onCheckedChange={() => toggle(index)}
                />

                <span
                  /*
                    A fixed width, not a flexible one: the name and the level have
                    to stay together, and the value boxes are what should absorb a
                    wider window. 222px clears the longest name in any of the three
                    languages ("スーパーアルテイメットJust回避"); anything longer
                    truncates, with the tooltip carrying the whole one.
                  */
                  className={`w-[222px] shrink-0 truncate text-sm ${
                    edit.Enabled ? "" : "text-muted-foreground"
                  }`}
                >
                  {name || <span className="font-mono text-muted-foreground">{edit.Key}</span>}
                </span>

                <LevelInput
                  level={edit.Level}
                  min={skills[edit.Key.toUpperCase()]?.Min ?? 1}
                  max={skills[edit.Key.toUpperCase()]?.Max ?? 15}
                  label={t.level}
                  onChange={(level) => changeLevel(index, level)}
                />

                {/*
                  Keyed by the level so a half-typed entry is dropped when the level
                  moves: the number being typed was for the level it was typed on.
                */}
                <ValueSlots
                  key={edit.Level}
                  values={edit.Values}
                  typed={edit.Typed}
                  defaults={skills[edit.Key.toUpperCase()]?.Levels?.[edit.Level - 1]}
                  onChange={(values, typed) => update(index, { Values: values, Typed: typed })}
                />

                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t.remove(name || edit.Key)}
                  onClick={() => remove(index)}
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
          );
        })}

        {shown.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {t.empty}
          </p>
        )}
      </div>



      {/*
        A failed write is worth interrupting for - the edit is not on disk, and
        the reason is usually something the user has to fix (a running game holds
        the DLL open, a folder is read-only). Closing it clears the error.
      */}
      <AlertDialog
        open={error !== null}
        onOpenChange={(open) => {
          if (!open) setError(null);
        }}
      >
        {/* No size="sm": that switches the footer to a two-column grid, and this
            dialog has a single button that should sit centred. */}
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{error?.title}</AlertDialogTitle>
            <AlertDialogDescription className="break-words">
              {error?.detail}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {/* Stock footer and stock button: below the sm breakpoint the footer is
              a column, so the button stretches on its own. No width of our own. */}
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setError(null)}>{t.ok}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
