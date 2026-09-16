/*
  The tool's pure half: everything about a record that is decided by values alone,
  with no React and no DOM in sight, so it can be read and tested on its own.

  The row list keeps its shape here too (addresses, slots, ordering of a trait's
  levels), because that shape is what Config.json and the mod's table rows are keyed
  by - see the note on dedupe, which is the invariant the whole list rests on.
*/

export type SigilTrait = {
  enabled: boolean;
  key: string;
  level: number;
  /*
    The ten LevelValue slots, positionally. A slot is a number, or null for "the game's own
    value, untouched": the mod writes only the numbers and leaves the rest of the row as it
    found it, so a slot nobody set cannot be overwritten with a stale copy of the game's
    table. What counts as untouched is trimGameValues.
  */
  values: (number | null)[];
};

/**
 * One trait's vanilla numbers per level. Levels is indexed by level - 1, so
 * Levels[3] is the row the game shows as level 4 - which is what a slot's
 * placeholder, and the value an emptied box writes back, have to come from.
 * Rows is every level that carries numbers - the levels the picker offers, which is
 * not the span between the first and the last: 万能药 has rows 15 and 30 with nothing
 * in between.
 */
export type TraitInfo = { Levels: number[][]; Default: number; Rows: number[] };

export const SLOTS = 10;

/** The table row an edit writes: one address per trait hash and level. */
export const addressOf = (key: string, level: number) => `${key}#${level}`;

/**
 * Whether a record is an edit at all, which is what decides if it is saved.
 *
 * Two things make one: it is switched on, or it carries a number. A record with neither is a
 * row the user ticked and unticked, and Config.json holds no such row.
 */
export const isEdit = (record: SigilTrait) =>
  record.enabled || record.values.some((value) => value !== null);

/**
 * The values with the level's own numbers taken back out: a slot holding the game's number is
 * not an input, so it is null - which leaves that part of the row alone and shows the number
 * as a placeholder. This is also what makes an old file read right, since builds before null
 * existed filled every slot with the game's own numbers to write the row back.
 *
 * A level the tables do not know (a hand-added record) keeps its numbers: there is nothing to
 * compare them with, and they may well be what the game needs written.
 */
export const trimGameValues = (
  values: (number | null)[],
  vanilla: number[] | undefined,
) => values.map((value, i) => (value === vanilla?.[i] ? null : value));

/**
 * The records as edits: every slot that only held the game's number emptied, and the records
 * that are then not edits at all dropped. Every path in and out of the list goes through
 * this, so the list, Config.json and the game agree on what an edit is.
 */
export const asEdits = (records: SigilTrait[], info: Record<string, TraitInfo>) =>
  records
    .map((record) => ({
      ...record,
      values: trimGameValues(
        record.values,
        info[record.key]?.Levels?.[record.level - 1],
      ),
    }))
    .filter(isEdit);

export const pad = (values: (number | null)[]) =>
  Array.from({ length: SLOTS }, (_, i) => values[i] ?? null);

/*
  At most one edit per address, which is the invariant the whole list rests on.

  The mod walks the edit list in order and writes every enabled edit into the table
  row its (hash, level) names, so when two of them share an address the last enabled
  one is what the game ends up with (Mod.cs:169 and the patch loop after it). A file
  can still hold both - an older version of this tool wrote them, or someone edited
  Config.json by hand - and the list can only show one of them, so the last enabled
  one is kept (the last of any, when the address holds none that is enabled).
*/
export function dedupe(records: SigilTrait[]): {
  records: SigilTrait[];
  changed: boolean;
} {
  const lastEnabled = new Map<string, number>();
  const lastAny = new Map<string, number>();
  records.forEach((record, i) => {
    const address = addressOf(record.key, record.level);
    lastAny.set(address, i);
    if (record.enabled) lastEnabled.set(address, i);
  });

  const kept = records.filter((record, i) => {
    const address = addressOf(record.key, record.level);
    return i === (lastEnabled.get(address) ?? lastAny.get(address));
  });
  return { records: kept, changed: kept.length !== records.length };
}

/*
  What a box may hold: an optional leading minus sign, digits, and at most one
  decimal point - so "-", "0." and "-.5" are all reachable states, while a second
  minus, a second point, a letter or exponent notation never reach the box. Keeping
  exponent notation out matters: a number input used to accept 1e999, and JSON turns
  that into null, which the tool then saved as a 0.

  No leading zeroes either: 0 is 0, and 00 or 01 are not numbers anyone means. Letting
  them in put text in the box that the committed number could not render back - 00 read
  as 0, so the second 0 looked ignored, and 01 read as 1 while the box showed 01.

  The lengths are the bound on the whole input domain, not decoration: at most 9 digits
  before the point and 6 after it means the largest thing that can be typed is
  999999999.999999. Nothing the game carries comes close (its values run from 0.004 to a
  few tens of thousands), and a number that can never exceed that can never become
  Infinity either - a pasted 400-digit number would otherwise be committed as Infinity,
  and JSON refuses to write those, which left every later save failing.
*/
export const HALF_TYPED = /^-?(0|[1-9]\d{0,8})?(\.\d{0,6})?$/;

/*
  ...and what counts as a number once the box is done with: -3, 30, 0.6, .5

  The digit after the point is required, and that is the whole point: "0." is a state
  on the way to 0.5, and treating it as the number 0 committed it, cleared the half
  typed text and left the next 5 to be typed after a 0 that was already saved - so
  typing 0.5 produced 5.
*/
export const NUMBER = /^-?((0|[1-9]\d{0,8})(\.\d{1,6})?|\.\d{1,6})$/;

/** One slot's number changed: the ten values with that slot set. */
export const withSlot = (values: (number | null)[], i: number, v: number | null) => {
  const next = values.slice();
  next[i] = v;
  return next;
};

/**
 * What one keystroke in one slot does.
 *
 * The box keeps half typed text on screen while it has focus, because "-" and "0." are
 * states on the way to a number and a controlled input cannot show them otherwise;
 * anything that could never become a number is dropped and the box is left as it was.
 * Returned as data rather than applied, so the rule is one function that a test can
 * drive key by key.
 */
export type SlotEdit =
  | { kind: "drop" }
  | { kind: "half"; text: string }
  | { kind: "commit"; values: (number | null)[]; keeps?: string };

export function slotEdit(
  text: string,
  i: number,
  values: (number | null)[],
): SlotEdit {
  /*
    A digit typed into a box that already shows 0 means that digit: the 0 was the box's, not
    something the user asked to keep. So the whole-number part's leading zeroes go before the
    text is judged - "04" is 4, "007" is 7, "00" is 0 - while a zero the decimal point needs
    stays, because 0.5 is not .5.
  */
  const tidied = text.replace(/^(-?)0+(?=\d)/, "$1");

  if (!HALF_TYPED.test(tidied)) return { kind: "drop" };
  if (tidied === "") {
    // Emptied: the slot goes back to the game's own number, which the box shows as a
    // placeholder from here on - null is that, and the game's number is read from the
    // tables rather than written back into the file (see SigilTrait.values).
    return { kind: "commit", values: withSlot(values, i, null) };
  }
  if (!NUMBER.test(tidied)) return { kind: "half", text: tidied };

  /*
    A number: committed now, but the box keeps showing what was typed until it is left
    (see `keeps`). That is not cosmetic. Committing is what the game sees, and it has to
    happen per keystroke; the *text*, though, has to stay the user's, because a prefix of
    a number is often a number itself - 0.0 is 0, 0.00 is 0 - and rendering the box from
    the committed number dropped the rest of what was typed: 0.004 came out as 4, 5.05 as
    50. On blur the box renders the number again, which is what makes 06 read back as 6.
  */
  return {
    kind: "commit",
    values: withSlot(values, i, Number(tidied)),
    keeps: tidied,
  };
}

/**
 * The largest value a box may hold, and the bound the two patterns below encode: 9 digits
 * before the point, 6 after it.
 *
 * Written out because a step has to respect it too. Stepping is the third way a value
 * changes - after typing and a hand-edited file - and without the clamp a box at
 * 999999999 answered an arrow key with 1000000000: ten digits, which its own pattern then
 * refuses, so the box showed a number no keystroke would be accepted on.
 */
export const MAX_VALUE = 999999999.999999;

/** One step of the arrow keys and the wheel, held inside what a box may hold. */
export const stepValue = (value: number, direction: 1 | -1) => {
  const next = Math.round((value + direction) * 100) / 100;
  return Math.abs(next) <= MAX_VALUE ? next : value;
};

/*
  The levels a trait shows: the game's rows that carry numbers, plus any level an edit
  already names, with what is switched on lifted to the top.

  The rows, not the span between them: every level has a table row, but most of them are all
  zeros - 万能药 has values on 15 and 30 only - and an edit pointed at a zero row writes a
  value the game never reads there. traitInfo.Rows is that set (build-assets.js derives it
  the same way).

  A level only the records know about (edited by hand, or left behind by a level the tables
  no longer carry) still gets a row, so it stays visible instead of being applied invisibly.
*/
export function levelsOf(
  info: TraitInfo | undefined,
  records: SigilTrait[],
): number[] {
  const on = new Set(records.filter((record) => record.enabled).map((r) => r.level));
  const levels = new Set<number>(info?.Rows ?? []);
  for (const record of records) levels.add(record.level);

  return [...levels].sort(
    (a, b) => (on.has(a) ? 0 : 1) - (on.has(b) ? 0 : 1) || a - b,
  );
}

/**
 * The name search: a trait is kept when what was typed is in the name, or is the hash
 * the tables and Config.json key it by (which is how one row is put on screen by hand).
 */
export const matches = (label: string, key: string, needle: string) =>
  !needle || label.toLowerCase().includes(needle) || key.toLowerCase().includes(needle);

/** One stretch of levels that share an explanation: the text, from the level it starts at. */
export type ExplainBand = { from: number; text: string };

/**
 * The explanation a level shows: the last band that starts at or below it.
 *
 * The bands are the game's own rows, folded: most skills say the same thing at every level,
 * some change it partway - a 30-level resistance reads "受到的伤害-{0}%" until level 29 and
 * "…免疫" at 30, and one skill has six bands. A level past the last band, which only a
 * hand-edited Config.json can name, is the same rule with nothing extra: no band matches and
 * the last one answers.
 */
export const explainAt = (bands: ExplainBand[] | undefined, level: number) =>
  bands?.findLast((band) => band.from <= level)?.text ?? bands?.[0]?.text ?? "";

/*
  The tooltip is a template, not a sentence with the numbers already in it: {N} is rewritten
  to the slot it stands for, counted from 1 like the ten boxes, so the reader can see which
  box feeds which part of the effect. Whatever else the game's placeholder carries is
  dropped - "{0:.1f}" becomes "{1}", because the slot number is all the tooltip is saying -
  and the "<d>" markers a few explanations carry are markup rather than text.
*/
export const slotLabel = (text: string) =>
  text
    .replace(/\{(\d+)(?::[^}]*)?\}/g, (_, d) => `{${Number(d) + 1}}`)
    .replace(/<\/?[a-z][^>]*>/g, "")
    .trim();
