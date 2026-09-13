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
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { SkillPicker, type PickerItem } from "./SkillPicker";
import { LANGS, LANG_LABEL, MESSAGES, initialLang, rememberLang, type Lang } from "./i18n";

type SkillEdit = {
  Enabled: boolean;
  Key: string;
  Level: number;
  Values: number[];
};

const SERVICE = "main.EditService";
const SLOTS = 10;

/*
  A number input draws its own spinner arrows, which ignore the theme and look
  like a light-mode form control next to everything else. These fields are typed
  into, never stepped.
*/
const NO_SPINNER =
  "[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none";

/** The table stores level N for the level the game calls N+1. */
const shownLevel = (stored: number) => stored + 1;

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
  const addressOfKeep = keepIndex !== undefined ? target(items[keepIndex]) : undefined;

  const winner = new Map<string, number>();
  items.forEach((e, i) => {
    if (!e.Enabled) return;
    const address = target(e);
    if (address === addressOfKeep) {
      winner.set(address, keepIndex!);
    } else if (!winner.has(address)) {
      winner.set(address, i);
    } else if (keepIndex === undefined) {
      winner.set(address, i); // last one wins when normalising from disk
    }
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
function ValueSlots({
  values,
  defaults,
  onChange,
}: {
  values: number[];
  defaults?: number[];
  onChange: (next: number[]) => void;
}) {
  const [touched, setTouched] = useState<ReadonlySet<number>>(new Set());

  const vanillaOf = (i: number) => defaults?.[i] ?? 0;

  return (
    <div className="flex shrink-0 items-center">
      {Array.from({ length: SLOTS }, (_, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <span className="text-muted-foreground/40" aria-hidden>
              |
            </span>
          )}
          <Input
            type="number"
            step="any"
            aria-label={`LevelValue${i + 1}`}
            title={`LevelValue${i + 1} = {${i}}`}
            placeholder={String(vanillaOf(i))}
            // Digits also show when the stored number differs from the game's - a
            // slot edited in Config.json by hand should not look untouched.
            value={touched.has(i) || values[i] !== vanillaOf(i) ? values[i] : ""}
            onChange={(e) => {
              const text = e.target.value;
              const next = [...values];
              next[i] = text === "" ? vanillaOf(i) : Number(text);
              setTouched((prev) => {
                const marked = new Set(prev);
                if (text === "") marked.delete(i);
                else marked.add(i);
                return marked;
              });
              onChange(next);
            }}
            /*
              Bare text, not a field: no border, no fill, no focus ring. The row
              reads as one line of numbers separated by |, and the only chrome left
              is a faint wash on the slot being edited so the caret has a home.
            */
            className={`h-7 w-8 min-w-0 border-0 bg-transparent px-0 text-center text-xs tabular-nums shadow-none focus:bg-muted/50 focus-visible:ring-0 dark:bg-transparent ${NO_SPINNER}`}
          />
        </Fragment>
      ))}
    </div>
  );
}

/** The stored level, shown one higher because that is what the game calls it. */
function LevelInput({
  stored,
  label,
  onChange,
}: {
  stored: number;
  label: string;
  onChange: (stored: number) => void;
}) {
  return (
    /*
      Not an InputGroup: that whole component exists to draw a box around a field
      and its prefix, and this field has no box. A label next to a bare input
      matches the value slots beside it exactly.
    */
    <div className="flex h-7 shrink-0 items-center gap-1">
      <span className="text-xs text-muted-foreground select-none">Lv</span>
      {/* Narrow and left-aligned: centred in a wider box it left a visible gap
          after the label. No gap either - the numerals carry their own side
          bearing, so "Lv15" still reads as two words. Levels are one or two
          digits, which is what w-6 is sized for. */}
      <Input
        type="number"
        aria-label={label}
        value={shownLevel(stored)}
        onChange={(e) => onChange(Number(e.target.value) - 1)}
        className={`h-7 w-6 min-w-0 border-0 bg-transparent px-0 text-left text-xs tabular-nums shadow-none focus:bg-muted/50 focus-visible:ring-0 dark:bg-transparent ${NO_SPINNER}`}
      />
    </div>
  );
}

export default function App() {
  const [lang, setLang] = useState<Lang>(initialLang);
  const [edits, setEdits] = useState<SkillEdit[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [defaults, setDefaults] = useState<Record<string, number[]>>({});
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
    Call.ByName(`${SERVICE}.NameMap`, lang)
      .then((map) => setNames((map ?? {}) as Record<string, string>))
      .catch((err) => setError({ title: t.readFailed, detail: String(err) }));
  }, [lang]);

  /*
    Reloaded-II is a portable folder, so where it lives is discovered at startup
    and can be corrected by hand. Everything the tool shows depends on that
    answer, which is why picking a folder reloads all of it.
  */
  async function loadAll() {
    const [list, defaultMap, dir, root] = await Promise.all([
      Call.ByName(`${SERVICE}.LoadEdits`) as Promise<SkillEdit[]>,
      Call.ByName(`${SERVICE}.DefaultMap`) as Promise<Record<string, number[]>>,
      Call.ByName(`${SERVICE}.ModsDir`) as Promise<string>,
      Call.ByName(`${SERVICE}.ReloadedDir`) as Promise<string>,
    ]);
    const loaded = enforceExclusivity(
      (list ?? []).map((e) => ({ ...e, Values: pad(e.Values ?? []) })),
    );
    setEdits(loaded);
    setDefaults(defaultMap ?? {});
    setModsDir(dir ?? "");
    setReloadedDir(root ?? "");

    // The file on disk may hold several enabled edits for one row; write the
    // normalised list back so what is stored matches what is shown.
    if ((list ?? []).some((e, i) => e.Enabled !== loaded[i].Enabled)) {
      await writeConfig(loaded, true);
    }
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
    Writes are silent on purpose.

    Every edit already saves itself in the background. Announcing each one made
    the line below flicker between two strings on every keystroke and every
    checkbox click, so that line reports state instead - it is derived from the
    edit list and therefore only changes when the list really changes. A failure
    is the one thing worth interrupting for.
  */
  async function writeConfig(items: SkillEdit[], quiet: boolean) {
    if (!quiet) setBusy(true);
    try {
      await Call.ByName(`${SERVICE}.Install`, items);
      setError(null);
    } catch (err) {
      setError({ title: t.writeFailed, detail: String(err) });
    } finally {
      if (!quiet) setBusy(false);
    }
  }

  function install() {
    return writeConfig(edits, false);
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

  function remove(rowIndex: number) {
    commit(enforceExclusivity(edits.filter((_, i) => i !== rowIndex)));
  }

  /*
    A new edit starts from the skill's own vanilla LevelValue1..10 rather than
    zeros, so the only thing to change is the number being tuned. Unknown keys
    fall back to zeros.
  */
  function add() {
    if (!newKey) return;
    const next = [
      ...edits,
      {
        Enabled: true,
        Key: newKey,
        Level: 14,
        Values: pad(defaults[newKey.toUpperCase()] ?? []),
      },
    ];
    setNewKey("");
    commit(enforceExclusivity(next, next.length - 1));
  }

  function commit(next: SkillEdit[]) {
    setEdits(next);
    void writeConfig(next, true);
  }

  const enabledCount = edits.filter((e) => e.Enabled).length;

  return (
    <div className="fixed inset-0 flex flex-col gap-4 p-5">
      <header className="flex items-center justify-between">
        <h1 className="text-sm font-semibold">
          {t.title(enabledCount, edits.length)}
        </h1>

        {/* Three square buttons: the label is the language's own short form, so
            this never needs translating either. */}
        <div className="flex items-center gap-1">
          {LANGS.map((code) => (
            <Button
              key={code}
              size="icon-sm"
              variant={code === lang ? "default" : "outline"}
              aria-label={code}
              onClick={() => setLang(code)}
            >
              {LANG_LABEL[code]}
            </Button>
          ))}
        </div>
      </header>

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
              className="flex cursor-pointer items-center gap-2 border-b py-1.5 last:border-b-0"
            >
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <Checkbox
                  checked={edit.Enabled}
                  aria-label={t.enable(name || edit.Key)}
                  onCheckedChange={() => toggle(index)}
                />

                <span
                  className={`min-w-0 flex-1 truncate text-sm ${
                    edit.Enabled ? "" : "text-muted-foreground"
                  }`}
                  // Names longer than the row allows are truncated; the tooltip is
                  // where the whole one is readable.
                  title={name || edit.Key}
                >
                  {name || <span className="font-mono text-muted-foreground">{edit.Key}</span>}
                </span>

                <LevelInput
                  stored={edit.Level}
                  label={t.level}
                  onChange={(level) => update(index, { Level: level })}
                />

                <ValueSlots
                  values={edit.Values}
                  defaults={defaults[edit.Key.toUpperCase()]}
                  onChange={(values) => update(index, { Values: values })}
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

      {/* Always on screen: adding a skill is the point of the tool, so it does
          not hide behind a button. Picking one is the only thing to cancel. */}
      <div className="flex items-center gap-2">
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
        <Button onClick={add} disabled={!newKey}>
          {t.add}
        </Button>
      </div>

      <footer className="flex items-center gap-4 border-t pt-4">
        {/*
          The label never changes. Swapping it for a progress word resized the
          button by 9px, which slid the target line next to it back and forth.
          The disabled state is the feedback while the write is in flight.
        */}
        <Button
          onClick={install}
          disabled={busy || shown.length === 0 || !reloadedDir}
        >
          {t.install}
        </Button>

        {/*
          One line. Failures do not land here - a write error can be long and its
          useful half is at the end, so it gets a dialog instead. What lands here
          is the one thing that cannot be worked out on its own: where Reloaded-II
          is, when the search came up empty.
        */}
        {reloadedDir === "" ? (
          <div className="flex min-h-4 min-w-0 flex-1 items-center gap-2">
            <span className="truncate text-xs text-muted-foreground">
              {t.noReloaded}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={chooseReloadedDir}
              disabled={busy}
            >
              {t.chooseDir}
            </Button>
          </div>
        ) : reloadedDir ? (
          <div className="min-h-4 min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {t.target(`${modsDir}\\GBFR.SkillEdit`)}
          </div>
        ) : null}
      </footer>

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
