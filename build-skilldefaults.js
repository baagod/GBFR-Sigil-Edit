// Build skillinfo.json: skill hash -> its vanilla LevelValue1..10 and the stored
// levels those numbers live on, so the tool can prefill a sensible starting point
// when a skill is added instead of ten zeros, and bound the level field.
//
// One asset rather than two: both halves describe the same row, come from the same
// query, and are always wanted together.
//
// Source is the game's own skill_status.tbl, converted to SQLite by GBFRDataTools.
// Levels are stored 0-based in the table (the game shows level + 1), and the values
// live on the highest level row, so "max(Level)" is the row to snapshot.
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

  const maxLevel = new Map();
  for (const row of db.prepare("select Key, max(Level) m from skill_status group by Key").all()) {
    maxLevel.set(String(row.Key), row.m);
  }

  const cols = Array.from({ length: 10 }, (_, i) => `LevelValue${i + 1}`).join(", ");
  const rows = db.prepare(`select Key, Level, ${cols} from skill_status`).all();

  const valuesOf = (row) =>
    Array.from({ length: 10 }, (_, i) => Number(row[`LevelValue${i + 1}`]) || 0);
  const nonZero = (row) => valuesOf(row).some((v) => v !== 0);

  // Displayed level 15 is what the tool used to assume for every skill. Most
  // skills carry values there; a few only carry them higher up.
  const valuedAt15 = new Set();
  for (const row of rows) {
    if (row.Level === 15 && nonZero(row)) valuedAt15.add(norm(String(row.Key)));
  }

  const out = {};
  for (const row of rows) {
    const key = String(row.Key);
    if (row.Level !== maxLevel.get(key)) continue;

    const hash = norm(key);
    if (!(hash in names)) continue;
    if (EXCLUDED.has(hash)) continue;

    /*
      Which stored level a new edit should point at.

      The skill's own maximum while that is a normal 20 or less, otherwise the
      usual 15 - except where 15 holds nothing, in which case the maximum is the
      only row that would do anything.
    */
    const maxDisplayed = row.Level;
    const defaultDisplayed =
      maxDisplayed <= 20 || !valuedAt15.has(hash) ? maxDisplayed : 15;
    out[hash] = {
      Default: defaultDisplayed - 1,
      Max: maxDisplayed - 1,
      Values: valuesOf(row),
    };
  }

  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out), "utf8");

  const size = fs.statSync(OUT).size;
  console.log(`skillinfo.json -> ${OUT}`);
  console.log(`  ${Object.keys(out).length} skills, ${(size / 1024).toFixed(1)} KB`);
  for (const k of ["06719232", "29B07BEB", "70395731", "CAC6AFF2"]) {
    const info = out[k];
    console.log(
      `  ${names[k] ?? k} (${k}) = [${(info?.Values ?? []).join(", ")}]  Lv${
        info ? `${info.Default + 1}/${info.Max + 1}` : "?"
      }`,
    );
  }
}

main();
