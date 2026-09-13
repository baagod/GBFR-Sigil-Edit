// Build skilldefaults.json: skill hash -> its vanilla LevelValue1..10, so the tool
// can prefill a sensible starting point when a skill is added instead of ten zeros.
//
// Source is the game's own skill_status.tbl, converted to SQLite by GBFRDataTools.
// Levels are stored 0-based in the table (the game shows level + 1), and the values
// live on the highest level row, so "max(Level)" is the row to snapshot.
//
// Usage: node build-skilldefaults.js [--db <gbfr.db>] [--out <json>] [--tbl <tbl file>]

"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const arg = (n, d) => {
  const i = process.argv.indexOf("--" + n);
  return i >= 0 ? process.argv[i + 1] : d;
};

const ROOT = "D:/Games/Relink/GBFR.SkillEdit";
const TBL = arg("tbl", path.join(ROOT, "game_extract/system/table/skill_status.tbl"));
const DB = arg("db", path.join(ROOT, "vanilla.db"));
const OUT = arg("out", path.join(ROOT, "SkillEditTool/assets/skilldefaults.json"));
const TOOL = path.join(ROOT, "GBFRDataTools/GBFRDataTools.exe");
const SQLITE = path.join(ROOT, "sqlite3.exe");
const NAMES = path.join(ROOT, "SkillEditTool/assets/skillnames.json");
const IDS = path.join(ROOT, "GBFRDataTools/Data/ids.txt");

function ensureDb() {
  if (fs.existsSync(DB)) return;
  if (!fs.existsSync(TBL)) throw new Error(`missing table: ${TBL}`);

  const dir = path.dirname(TBL);
  execFileSync(TOOL, ["tbl-to-sqlite", "-i", dir, "-o", DB, "-v", "2.0.5"], {
    stdio: "ignore",
  });
  console.log(`converted ${TBL} -> ${DB}`);
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

  const out = {};
  for (const row of rows) {
    const key = String(row.Key);
    if (row.Level !== maxLevel.get(key)) continue;

    const hash = norm(key);
    if (!(hash in names)) continue;

    out[hash] = Array.from(
      { length: 10 },
      (_, i) => Number(row[`LevelValue${i + 1}`]) || 0,
    );
  }

  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out), "utf8");

  const size = fs.statSync(OUT).size;
  console.log(`skilldefaults.json -> ${OUT}`);
  console.log(`  ${Object.keys(out).length} skills, ${(size / 1024).toFixed(1)} KB`);
  for (const k of ["06719232", "29B07BEB"]) {
    console.log(`  ${names[k] ?? k} (${k}) = [${(out[k] ?? []).join(", ")}]`);
  }
}

main();
