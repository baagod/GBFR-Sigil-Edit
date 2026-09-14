// Build skillinfo.json: skill hash -> its vanilla LevelValue1..10 and the level
// those numbers live on, so the tool can prefill a new edit and bound its level.
//
// Source is the game's own skill_status.tbl, converted to SQLite by GBFRDataTools.
// A row's Level field is the level the game shows for it and the row an edit is
// written to, so the numbers here are used as they are.
//
// Usage: node build-skilldefaults.js [--root <project dir>]

"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const arg = (n, d) => {
  const i = process.argv.indexOf("--" + n);
  return i >= 0 ? process.argv[i + 1] : d;
};

const ROOT = arg("root", ".");

// The extracted game copy and the toolkit live one level up, next to this
// repository: they are shared with the other mods in the workspace and are far
// too big to belong to any one of them.
const SHARED = path.join(ROOT, "..");
const TBL = path.join(SHARED, "extracted/system/table/skill_status.tbl");
const DB = path.join(SHARED, "extracted", "gbfr.db");
const OUT = path.join(ROOT, "SkillEditTool/assets/skillinfo.json");
const TOOL = path.join(SHARED, "GBFRDataTools/GBFRDataTools.exe");
// The Chinese table is the one that decides which skills the tool offers; the
// other languages carry the same keys.
const NAMES = path.join(ROOT, "SkillEditTool/assets/skillnames.zh.json");
const IDS = path.join(SHARED, "GBFRDataTools/Data/ids.txt");

// Not skills anyone edits - leftover rows that happen to have names. Kept in sync
// with the same list in build-skillnames.js.
const EXCLUDED = new Set([
  "9AD8B5E6", // 7net
  "0FBA47E8", // 强健甘露
  "A4D6B880", // 修炼甘露
  "CDEB73F6", // 幸运甘露
]);

// A database file that exists but holds no tables is worse than none: every later
// check sees a file that is "there". Test for the table instead, and convert over
// a clean file rather than trust what is already sitting at that path.
function ensureDb() {
  if (hasSkillStatus()) return;
  if (!fs.existsSync(TBL)) throw new Error(`missing table: ${TBL}`);

  fs.rmSync(DB, { force: true });
  const dir = path.dirname(TBL);
  execFileSync(TOOL, ["tbl-to-sqlite", "-i", dir, "-o", DB, "-v", "2.0.5"], {
    stdio: "ignore",
  });
  console.log(`converted ${TBL} -> ${DB}`);
}

// The table build-skillnames.js also reads, so its absence means the conversion
// never ran, or died halfway through.
function hasSkillStatus() {
  if (!fs.existsSync(DB)) return false;
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(DB);
  const found = db.prepare("select name from sqlite_master where name = 'skill_status'").all().length > 0;
  db.close();
  return found;
}

function main() {
  ensureDb();

  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(DB);

  // Only skills the tool can actually offer: those with a display name.
  const names = JSON.parse(fs.readFileSync(NAMES, "utf8"));

  // skill_status stores some rows under a plain name (SKILL_127_00) and others
  // under the 8-hex hash, while the name table is keyed by hash. Collapse both
  // spellings onto the hash via ids.txt so the join works.
  const idToHash = new Map();
  for (const line of fs.readFileSync(IDS, "utf8").split(/\r?\n/)) {
    const parts = line.split("|");
    if (parts.length >= 3) idToHash.set(parts[2], parts[0]);
  }
  const norm = (value) => {
    const key = String(value ?? "").trim();
    return idToHash.get(key) ?? key;
  };

  const cols = Array.from({ length: 10 }, (_, i) => `LevelValue${i + 1}`).join(", ");
  const rows = db.prepare(`select Key, Level, ${cols} from skill_status`).all();

  const valuesOf = (row) =>
    Array.from({ length: 10 }, (_, i) => Number(row[`LevelValue${i + 1}`]) || 0);

  /*
    Every row of the skills the tool offers, indexed by level - 1, because an edit
    can name any of those levels. Only carrying the one row a new edit starts on was
    wrong for everything else: the placeholder, and the value an emptied box writes
    back, both have to be the game's numbers for the level in play. Levels are
    contiguous from 1, so the array needs no holes.
  */
  const perLevel = new Map();
  for (const row of rows) {
    const hash = norm(String(row.Key));
    if (!(hash in names)) continue;
    if (EXCLUDED.has(hash)) continue;
    if (!perLevel.has(hash)) perLevel.set(hash, []);
    perLevel.get(hash)[row.Level - 1] = valuesOf(row);
  }

  const out = {};
  for (const [hash, levels] of perLevel) {
    // One row per level, contiguous from 1, so the last row is the highest level
    // the skill has.
    const max = levels.length;

    /*
      The lowest level that carries numbers. Rows below it are all zeros - the game
      keeps them empty - so pointing an edit there would write a value into a row
      that has none. The level field is clamped to this range, which is what stops
      a skill whose numbers only exist on one level from being moved off it.
    */
    const first = levels.findIndex((row) => row.some((v) => v !== 0));
    const min = first < 0 ? max : first + 1;

    /*
      Which level a new edit should point at.

      The skill's own maximum while that is a normal 20 or less, otherwise the usual
      15 - except where 15 holds nothing (min is above it), in which case the maximum
      is the only row that would do anything.
    */
    const defaultLevel = max <= 20 || min > 15 ? max : 15;

    out[hash] = {
      Default: defaultLevel,
      Max: max,
      Min: min,
      Levels: levels,
    };
  }

  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out), "utf8");

  const size = fs.statSync(OUT).size;
  console.log(`skillinfo.json -> ${OUT}`);
  console.log(`  ${Object.keys(out).length} skills, ${(size / 1024).toFixed(1)} KB`);
  for (const k of ["06719232", "29B07BEB", "70395731", "CAC6AFF2"]) {
    const info = out[k];
    const atDefault = info?.Levels?.[info.Default - 1] ?? [];
    console.log(
      `  ${names[k] ?? k} (${k}) = [${atDefault.join(", ")}]  Lv${
        info ? `${info.Min}..${info.Max} (default ${info.Default})` : "?"
      }`,
    );
  }
}

main();
