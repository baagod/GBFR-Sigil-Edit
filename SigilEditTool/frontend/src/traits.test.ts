/*
  The rules the list rests on, driven directly instead of through a browser: these are
  the ones that decide what Config.json ends up holding, so a table here is worth more
  than another screenshot.

  The first block is the regression that motivated the file: typing 0.5 used to reach
  the table as 5, because "0." counted as a number and was committed (and the half typed
  text cleared) the moment the point was typed.
*/
import { describe, expect, it } from "vitest";
import {
  addressOf,
  dedupe,
  HALF_TYPED,
  levelsOf,
  matches,
  NUMBER,
  pad,
  slotEdit,
  stepValue,
  type SigilTrait,
  type TraitInfo,
} from "./traits";

const record = (
  Key: string,
  Level: number,
  Enabled: boolean,
  Values: number[] = [],
): SigilTrait => ({
  Enabled,
  Key,
  Level,
  Values: pad(Values),
  Typed: Array.from({ length: 10 }, () => false),
});

/*
  A stand-in for one value box: it shows what the user has typed (half typed text while
  it is not a number yet, otherwise the committed number), and a keystroke is appended
  to what is shown - which is what the browser does with the caret at the end.
*/
function type(value: number, keys: string) {
  let values = [value];
  let typed = [false];
  let half: string | undefined;
  for (const ch of keys) {
    const shown = half ?? (typed[0] ? String(values[0]) : "");
    const edit = slotEdit(shown + ch, 0, values, typed, () => 0);
    if (edit.kind === "drop") continue;
    if (edit.kind === "half") {
      half = edit.text;
      continue;
    }
    half = edit.keeps;
    values = edit.values;
    typed = edit.typed;
  }
  return { value: values[0], typed: typed[0], shown: half ?? String(values[0]) };
}

describe("a keystroke in a value box", () => {
  it("types decimals, including the ones that start with a point", () => {
    expect(type(0, "0.5")).toMatchObject({ value: 0.5, typed: true });
    expect(type(0, "-3.25").value).toBe(-3.25);
    expect(type(0, ".5").value).toBe(0.5);
    expect(type(0, "0.004").value).toBe(0.004);
  });

  it("types plain numbers", () => {
    expect(type(0, "20000").value).toBe(20000);
    expect(type(0, "-7").value).toBe(-7);
  });

  it("keeps a half typed number on screen instead of committing it", () => {
    expect(type(0, "0.").shown).toBe("0.");
    expect(type(0, "-").shown).toBe("-");
    expect(type(3, "3.").value).toBe(3);
  });

  it("drops what could never become a number, and the box carries on", () => {
    // A dropped keystroke leaves the box exactly as it was - including its half typed
    // text - so the next digit is typed after whatever was already there.
    for (const text of ["1-", "1..", "1e", "1a"]) {
      expect(slotEdit(text, 0, [1], [true], () => 0), text).toEqual({ kind: "drop" });
    }
    expect(type(0, "1-2").value).toBe(12);
    expect(type(0, "1..2").value).toBe(1.2);
  });

  it("puts the game's number back when the box is emptied", () => {
    const edit = slotEdit("", 0, [5], [true], () => 3);
    expect(edit).toEqual({ kind: "commit", values: [3], typed: [false] });
  });
});

describe("the two patterns", () => {
  it("treats a trailing point as half typed, not as a number", () => {
    for (const text of ["0.", "5.", "-2."]) {
      expect(HALF_TYPED.test(text), text).toBe(true);
      expect(NUMBER.test(text), text).toBe(false);
    }
  });

  it("accepts the numbers the game actually uses", () => {
    for (const text of ["0", "-3", "30", "0.6", ".5", "0.004", "20000"]) {
      expect(NUMBER.test(text), text).toBe(true);
    }
  });

  it("refuses exponent notation", () => {
    expect(NUMBER.test("1e999")).toBe(false);
    expect(HALF_TYPED.test("1e5")).toBe(false);
  });
});

describe("stepping a slot", () => {
  it("steps by one, to two decimals", () => {
    expect(stepValue(2, 1)).toBe(3);
    expect(stepValue(2, -1)).toBe(1);
    expect(stepValue(0.1, 1)).toBe(1.1);
    expect(stepValue(-0.2, -1)).toBe(-1.2);
  });
});

describe("one edit per address", () => {
  it("keeps the last enabled record of the address", () => {
    const { records, changed } = dedupe([
      record("A1", 1, true),
      record("A1", 1, true),
      record("B2", 3, true),
    ]);
    expect(changed).toBe(true);
    expect(records.map((r) => addressOf(r.Key, r.Level))).toEqual(["A1#1", "B2#3"]);
  });

  it("keeps the last of any when none of them is enabled", () => {
    const { records } = dedupe([record("A1", 1, false), record("A1", 1, false)]);
    expect(records).toHaveLength(1);
    expect(records[0].Enabled).toBe(false);
  });

  it("says nothing changed when every address is unique", () => {
    const { changed } = dedupe([record("A1", 1, true), record("A1", 2, true)]);
    expect(changed).toBe(false);
  });
});

describe("the levels a trait shows", () => {
  const info: TraitInfo = { Min: 1, Max: 4, Default: 2, Levels: [[], [], [], []] };

  it("puts what is on first, then switched-off edits, then the untouched", () => {
    const levels = levelsOf(info, [
      record("A1", 3, false),
      record("A1", 2, true),
      record("A1", 1, true),
    ]);
    expect(levels).toEqual([1, 2, 3, 4]);
  });

  it("keeps a level only the records know about", () => {
    const levels = levelsOf(info, [record("A1", 9, false)]);
    expect(levels).toContain(9);
  });

  it("shows nothing for a trait with no levels and no records", () => {
    expect(levelsOf(undefined, [])).toEqual([]);
  });
});

describe("the search", () => {
  it("matches the name, and the hash it is keyed by", () => {
    expect(matches("暴君", "71F11A9B", "暴")).toBe(true);
    expect(matches("暴君", "71F11A9B", "71f11a9b")).toBe(true);
    expect(matches("暴君", "71F11A9B", "霸")).toBe(false);
    expect(matches("暴君", "71F11A9B", "")).toBe(true);
  });
});
