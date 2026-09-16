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
  explainAt,
  HALF_TYPED,
  levelsOf,
  matches,
  MAX_VALUE,
  NUMBER,
  pad,
  slotEdit,
  slotLabel,
  stepValue,
  type ExplainBand,
  type SigilTrait,
  type TraitInfo,
} from "./traits";

const record = (
  key: string,
  level: number,
  enabled: boolean,
  values: number[] = [],
): SigilTrait => ({
  enabled,
  key,
  level,
  values: pad(values),
  typed: Array.from({ length: 10 }, () => false),
});

/*
  A stand-in for one value box: it shows what the user has typed (half typed text while
  it is not a number yet, otherwise the committed number), and a keystroke is appended
  to what is shown - which is what the browser does with the caret at the end.

  `committed` starts it in the state a box is in after a value has been saved - the number
  on screen rather than empty - which is where the bound becomes visible to the user.
*/
function type(value: number, keys: string, committed = false) {
  let values = [value];
  let typed = [committed];
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

  it("replaces leading zeroes instead of refusing the keystroke", () => {
    // 0 then 4 means 4: the 0 was the box's, so the digit replaces it. The zero a decimal
    // point needs stays - 0.5 is not .5 - and a lone 0 is still 0.
    expect(slotEdit("04", 0, [0], [false], () => 0)).toMatchObject({
      kind: "commit",
      values: [4],
      keeps: "4",
    });
    expect(slotEdit("007", 0, [0], [false], () => 0)).toMatchObject({ values: [7], keeps: "7" });
    expect(slotEdit("00", 0, [0], [false], () => 0)).toMatchObject({ values: [0], keeps: "0" });
    expect(slotEdit("-04", 0, [0], [false], () => 0)).toMatchObject({ values: [-4], keeps: "-4" });
    expect(slotEdit("00.5", 0, [0], [false], () => 0)).toMatchObject({
      values: [0.5],
      keeps: "0.5",
    });
    expect(slotEdit("0.004", 0, [0], [false], () => 0)).toMatchObject({ values: [0.004] });
    expect(slotEdit("0", 0, [0], [false], () => 0)).toMatchObject({ values: [0], keeps: "0" });
    expect(slotEdit("0.", 0, [0], [false], () => 0)).toMatchObject({ kind: "half", text: "0." });

    // The patterns themselves still refuse a leading zero pair: normalising happens before
    // them, so anything that reaches them with "01" is not a number.
    for (const text of ["01", "007", "00.5"]) {
      expect(HALF_TYPED.test(text), text).toBe(false);
      expect(NUMBER.test(text), text).toBe(false);
    }
  });

  it("refuses more digits than the game can carry, so no box can hold Infinity", () => {
    // 9 digits before the point and 6 after it is the whole input domain; the largest
    // value is 999999999.999999. Anything longer is dropped rather than committed: a
    // 309-digit paste would commit Infinity, JSON refuses to write that, and every save
    // after it failed with the dialog on screen.
    expect(NUMBER.test("999999999")).toBe(true);
    expect(NUMBER.test("999999999.999999")).toBe(true);
    expect(HALF_TYPED.test("1000000000")).toBe(false);
    expect(HALF_TYPED.test("0.1234567")).toBe(false);
    for (const text of ["9".repeat(20), "9".repeat(309), "9".repeat(400)]) {
      expect(HALF_TYPED.test(text), `${text.length} digits`).toBe(false);
      expect(slotEdit(text, 0, [0], [false], () => 0)).toEqual({ kind: "drop" });
    }
  });

  it("leaves the committed value alone when a longer number is refused", () => {
    // A refused keystroke is not a cleared box: the number already committed stays, and
    // the box goes on showing it. There is no hint that anything happened - which is why
    // the bound is documented here rather than explained in the UI.
    expect(type(123456789, "0", true)).toMatchObject({
      value: 123456789,
      shown: "123456789",
    });
    // A point is still a step on the way to a number, so it is shown, not committed.
    expect(type(123456789, ".", true).shown).toBe("123456789.");
  });
});

describe("stepping a slot", () => {
  it("steps by one, to two decimals", () => {
    expect(stepValue(2, 1)).toBe(3);
    expect(stepValue(2, -1)).toBe(1);
    expect(stepValue(0.1, 1)).toBe(1.1);
    expect(stepValue(-0.2, -1)).toBe(-1.2);
  });

  it("will not step a box past what its own text may hold", () => {
    // The clamp is what keeps stepping - the third way a value changes, after typing and
    // a hand-edited file - from producing a number the pattern above refuses: 999999999
    // used to step to 1000000000, and then no keystroke in that box was accepted.
    expect(stepValue(999999999, 1)).toBe(999999999);
    expect(stepValue(-999999999, -1)).toBe(-999999999);
    expect(stepValue(MAX_VALUE - 0.01, 1)).toBe(MAX_VALUE - 0.01);
    expect(stepValue(999999998, 1)).toBe(999999999);
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
    expect(records.map((r) => addressOf(r.key, r.level))).toEqual(["A1#1", "B2#3"]);
  });

  /*
    Which one survives, by the order they are written in: the mod writes every enabled
    edit in turn and the last write to an address is what the game keeps, so the record
    to keep is the last enabled one - or, when the address holds none, the last of any.
    Each case says which values must be left standing, not just how many records remain.
  */
  it.each([
    ["the later of two enabled", [true, true], [2, 3], 3],
    ["the enabled one written before a switched-off one", [true, false], [2, 3], 2],
    ["the enabled one written after a switched-off one", [false, true], [2, 3], 3],
    ["the later of two switched off", [false, false], [2, 3], 3],
  ])("keeps %s", (_case, enabled, values, kept) => {
    const { records, changed } = dedupe(
      enabled.map((on, i) => ({ ...record("A1", 1, on), values: pad([values[i]]) })),
    );
    expect(changed).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0].values[0]).toBe(kept);
  });

  it("says nothing changed when every address is unique", () => {
    const { changed } = dedupe([record("A1", 1, true), record("A1", 2, true)]);
    expect(changed).toBe(false);
  });
});

describe("the levels a trait shows", () => {
  const info: TraitInfo = {
    Rows: [1, 2, 3, 4],
    Default: 2,
    Levels: [[], [], [], []],
  };

  it("shows the game's real rows, not the span between them", () => {
    // 万能药 has values on 15 and 30 only; its other rows are all zeros, and an edit on one
    // of those writes a value the game never reads. Its Levels are left empty here because
    // levelsOf reads Rows alone - the fixture is not the asset.
    const cure: TraitInfo = {
      Rows: [15, 30],
      Default: 15,
      Levels: Array.from({ length: 30 }, () => []),
    };
    expect(levelsOf(cure, [])).toEqual([15, 30]);

    // An edit at a level the rows do not know still gets a row, so it stays visible.
    expect(levelsOf(cure, [record("A1", 20, true)])).toEqual([20, 15, 30]);
  });

  it("lifts what is switched on, and keeps the rest by level", () => {
    // Two tiers: the levels that are on come first, everything else follows in numeric
    // order - including the ones carrying a switched-off edit, which used to form their
    // own tier and pushed the untouched levels out of order behind them.
    const levels = levelsOf(info, [
      record("A1", 3, false),
      record("A1", 2, true),
      record("A1", 1, true),
    ]);
    expect(levels).toEqual([1, 2, 3, 4]);

    const wide: TraitInfo = {
      Rows: [1, 2, 3, 4, 5],
      Default: 1,
      Levels: Array.from({ length: 5 }, () => []),
    };
    // 2 and 4 on, 3 carrying a switched-off edit, 1 and 5 untouched.
    const mixed = levelsOf(wide, [
      record("A1", 3, false),
      record("A1", 4, true),
      record("A1", 2, true),
    ]);
    expect(mixed).toEqual([2, 4, 1, 3, 5]);
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

describe("the explanation a level shows", () => {
  const resistance: ExplainBand[] = [
    { from: 1, text: "受到的伤害-{0}%" },
    { from: 30, text: "灼热免疫" },
  ];

  it("reads the band the level falls in", () => {
    // The complaint this exists for: level 1 used to say "灼热免疫" because only the
    // highest row's text was kept.
    expect(explainAt(resistance, 1)).toBe("受到的伤害-{0}%");
    expect(explainAt(resistance, 29)).toBe("受到的伤害-{0}%");
    expect(explainAt(resistance, 30)).toBe("灼热免疫");
  });

  it("reads the last band for a level past the end, and the first below the start", () => {
    // Only a hand-edited Config.json can name these, and the same rule covers both.
    expect(explainAt(resistance, 99)).toBe("灼热免疫");
    expect(explainAt([{ from: 15, text: "Lv15 起" }], 3)).toBe("Lv15 起");
  });

  it("says nothing when the skill has no bands", () => {
    expect(explainAt(undefined, 1)).toBe("");
    expect(explainAt([], 1)).toBe("");
  });

  it("is what the six-band crab factor relies on", () => {
    const crab: ExplainBand[] = [
      { from: 1, text: "（攻击力+{0}%）" },
      { from: 5, text: "（暴击率+{1}%）" },
      { from: 9, text: "（HP持续回复，每次回复最大HP的{2:.1f}%）" },
      { from: 13, text: "（回复造成伤害{3:.1f}%的HP）" },
      { from: 17, text: "（伤害上限+{4}%）" },
      { from: 20, text: "（伤害上限+{4}% / 防御力+{5}%）" },
    ];
    expect(explainAt(crab, 4)).toContain("攻击力");
    expect(explainAt(crab, 12)).toContain("HP持续回复");
    expect(explainAt(crab, 20)).toContain("防御力");
  });
});

describe("the slot labels in a tooltip", () => {
  it("counts the slots from one, the way the boxes do", () => {
    expect(slotLabel("受到的伤害-{0}%")).toBe("受到的伤害-{1}%");
    expect(slotLabel("{2}秒内防御DOWN{0}%（可叠加至{1}层）")).toBe(
      "{3}秒内防御DOWN{1}%（可叠加至{2}层）",
    );
  });

  it("drops the format the game's placeholder carries", () => {
    // "{0:.1f}" is a template for a number the tooltip never prints; the slot is the point.
    expect(slotLabel("造成的伤害+{0:.1f}%")).toBe("造成的伤害+{1}%");
    expect(slotLabel("（昏厥值+{1:10}）")).toBe("（昏厥值+{2}）");
  });

  it("drops the markup a few explanations carry", () => {
    expect(slotLabel("<d>攻击和<d>攻击的伤害上限+{0}%")).toBe("攻击和攻击的伤害上限+{1}%");
  });
});
