// Build the assets the tool embeds: the game's own numbers, names and explanations
// for every skill it offers.
//
// Usage:
//   node tools/build-assets.js db                     -> skillinfo.json
//   node tools/build-assets.js names --lang zh|en|ja  -> skillnames.<lang>.json
//                                                        skillexplain.<lang>.json
//
// Both stages need an extracted copy of the game one level up, next to this
// repository, and both convert it to SQLite on demand if that has not been done.
// The assets are committed, so neither a build nor a release needs any of this -
// only regenerating them does. On a fresh setup run names --lang zh first:
// skillinfo.json is keyed off the Chinese name table, which is what decides which
// skills the tool offers.

"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const arg = (n, d) => {
  const i = process.argv.indexOf("--" + n);
  return i >= 0 ? process.argv[i + 1] : d;
};

// The game names its text folders with its own codes; the tool uses the usual
// language codes, so the two are mapped here.
const GAME_LANG = { zh: "cs", en: "en", ja: "jp" };

const ROOT = arg("root", ".");

// The extracted game copy and the toolkit live one level up, next to this
// repository: they are shared with the other mods in the workspace and are far
// too big to belong to any one of them.
const SHARED = path.join(ROOT, "..");
const TBL = path.join(SHARED, "extracted/system/table/skill_status.tbl");
const DB = path.join(SHARED, "extracted", "gbfr.db");
const TOOL = path.join(SHARED, "GBFRDataTools/GBFRDataTools.exe");
const IDS = path.join(SHARED, "GBFRDataTools/Data/ids.txt");
const ASSETS = path.join(ROOT, "SkillEditTool", "assets");

// Not skills anyone edits - leftover rows that happen to have names. One list, not
// one per stage: whether the tool offers a skill and what it is called have to
// agree, and two copies of this only ever drift apart.
const EXCLUDED = new Set([
  "9AD8B5E6", // 7net
  "0FBA47E8", // 强健甘露
  "A4D6B880", // 修炼甘露
  "CDEB73F6", // 幸运甘露
]);

// ---------- shared: the database ----------

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

function hasSkillStatus() {
  if (!fs.existsSync(DB)) return false;
  const db = openDb();
  const found = db.prepare("select name from sqlite_master where name = 'skill_status'").all().length > 0;
  db.close();
  return found;
}

function openDb() {
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(DB);
}

// ids.txt maps hash -> short id (and the reverse). gem columns store short ids like
// SKILL_127_00 while skill_status stores the 8-hex hash, so both spellings have to
// collapse onto the same lookup key.
function loadIdToHash() {
  const idToHash = new Map();
  for (const line of fs.readFileSync(IDS, "utf8").split(/\r?\n/)) {
    const parts = line.split("|");
    if (parts.length >= 3) idToHash.set(parts[2], parts[0]);
  }
  return idToHash;
}

const norm = (idToHash, value) => {
  const key = String(value ?? "").trim();
  return idToHash.get(key) ?? key;
};

function writeAsset(name, value, unit) {
  const out = path.join(ASSETS, name);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(value), "utf8");
  const size = fs.statSync(out).size;
  console.log(`${name} -> ${out}`);
  console.log(`  ${Object.keys(value).length} ${unit}, ${(size / 1024).toFixed(1)} KB`);
}

// ---------- stage: db -> skillinfo.json ----------

// Build skillinfo.json: skill hash -> its vanilla LevelValue1..10 and the level
// those numbers live on, so the tool can prefill a new edit and bound its level.
//
// Source is the game's own skill_status.tbl, converted to SQLite by GBFRDataTools.
// A row's Level field is the level the game shows for it and the row an edit is
// written to, so the numbers here are used as they are.
function stageDb() {
  ensureDb();

  const idToHash = loadIdToHash();
  const db = openDb();

  // Only skills the tool can actually offer: those with a display name. That table
  // comes from the names stage, and db is what consumes it.
  const namesPath = path.join(ASSETS, "skillnames.zh.json");
  if (!fs.existsSync(namesPath)) {
    throw new Error(
      `missing ${namesPath}; run "node tools/build-assets.js names --lang zh" first`,
    );
  }
  const names = JSON.parse(fs.readFileSync(namesPath, "utf8"));

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
    const hash = norm(idToHash, String(row.Key));
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

  writeAsset("skillinfo.json", out, "skills");
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

// ---------- stage: names -> skillnames.<lang>.json, skillexplain.<lang>.json ----------

// Build skillnames.json: skill-hash -> display name, so the tool can show
// "黑龙的咒印" instead of "06719232".
//
// Chain (all data from the game's own tables, nothing hand-maintained):
//   skill_status.Key          e.g. 06719232   (the hash we patch)
//     -> gem.SkillId1         e.g. 0523A202   (the sigil that grants it)
//       -> gem.Name           e.g. TXT_GEEN_178_04
//         -> text_*.msg       e.g. 黑龙的咒印
//
// Falls back to skill.Name -> TXT_SKILL_* for skills with no owning sigil.
function stageNames() {
  const lang = arg("lang", "zh");
  if (!(lang in GAME_LANG)) {
    throw new Error(`unknown --lang ${lang}; expected one of ${Object.keys(GAME_LANG).join(", ")}`);
  }
  const messages = path.join(
    SHARED,
    "extracted",
    "system",
    "table",
    "text",
    GAME_LANG[lang],
  );

  ensureDb();

  const idToHash = loadIdToHash();
  const db = openDb();
  const cs = parseTextMessages(messages);

  // gem: SkillId1/SkillId2 -> sigil name
  const sigilName = new Map();
  for (const row of db.prepare("select SkillId1, SkillId2, Name from gem").all()) {
    const name = textOf(cs, row.Name);
    if (!name) continue;
    for (const col of [row.SkillId1, row.SkillId2]) {
      const key = norm(idToHash, col);
      if (key && !sigilName.has(key)) sigilName.set(key, name);
    }
  }

  // skill: Key -> skill name (fallback for skills with no owning sigil)
  const skillName = new Map();
  for (const row of db.prepare("select Key, Name from skill").all()) {
    const name = textOf(cs, row.Name);
    if (name) skillName.set(norm(idToHash, row.Key), name);
  }

  // skill_status.Key -> display name
  const keys = db
    .prepare("select distinct Key from skill_status")
    .all()
    .map((r) => norm(idToHash, r.Key));

  const result = {};
  for (const key of keys) {
    if (EXCLUDED.has(key)) continue;
    const name = sigilName.get(key) || skillName.get(key);
    if (name) result[key] = name;
  }

  /*
    The tool's per-slot labels: the skill's own explanation, with {N} standing for
    LevelValue(N+1) - the numbers the tool edits. {N} is positional, verified
    against sibling skills whose templates use {1} and {2} for the second and
    third values.

    Taken from the highest level row, the same row the default values come from.
  */
  const highest = new Map();
  for (const row of db.prepare("select Key, LevelDescription, Level from skill_status").all()) {
    const key = String(row.Key);
    const best = highest.get(key);
    if (!best || row.Level > best.Level) highest.set(key, row);
  }
  const explain = {};
  for (const [key, row] of highest) {
    const hash = norm(idToHash, key);
    if (!(hash in result)) continue;
    const text = textOf(cs, row.LevelDescription);
    if (text) explain[hash] = text;
  }

  writeAsset(`skillnames.${lang}.json`, result, "names");
  writeAsset(`skillexplain.${lang}.json`, explain, "explanations");
  for (const k of ["06719232", "29B07BEB"]) {
    console.log(`  ${k} => ${result[k] ?? "(none)"}`);
  }
  for (const k of ["06719232", "B064A634"]) {
    console.log(`  explain ${k} => ${(explain[k] ?? "(none)").replace(/\n/g, " | ")}`);
  }
}

// name text key -> the language's text
function textOf(cs, key) {
  return key ? (cs.get(key) ?? "") : "";
}

// The container interleaves `id_hash_<pstring>` and `text_<pstring>` records, so
// walk the file pair-wise exactly like gen/build-sigils.js does.
function parseTextMessages(dir) {
  const out = new Map();

  const pstring = (b, pos) => {
    if (pos >= b.length) return null;
    const h = b[pos];
    let len, extra;
    if (h >= 0xa0 && h < 0xc0) { len = h - 0xa0; extra = 0; }
    else if (h === 0xd9) { len = b[pos + 1]; extra = 1; }
    else if (h === 0xda) { len = b[pos + 1] * 0x100 + b[pos + 2]; extra = 2; }
    else return null;
    const start = pos + 1 + extra;
    if (!Number.isFinite(len) || start + len > b.length) return null;
    return { raw: b.subarray(start, start + len), next: start + len };
  };

  const walk = (d) =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? walk(path.join(d, e.name))
        : e.name.endsWith(".msg")
          ? [path.join(d, e.name)]
          : [],
    );

  for (const file of walk(dir)) {
    const b = fs.readFileSync(file);
    let p = 0;
    for (;;) {
      const i = b.indexOf("id_hash_", p);
      if (i < 0) break;
      const idRec = pstring(b, i + 8);
      if (!idRec) { p = i + 8; continue; }
      const id = idRec.raw.toString("utf8").replace(/\u0000+/g, "");
      if (!id) { p = idRec.next; continue; }

      const t = b.indexOf("text_", idRec.next);
      if (t >= 0) {
        const textRec = pstring(b, t + 5);
        if (textRec) {
          const text = textRec.raw.toString("utf8").replace(/\u0000+/g, "").trim();
          if (text && !out.has(id)) out.set(id, text);
        }
      }
      p = t >= 0 ? t + 5 : idRec.next;
    }
  }
  return out;
}

// ---------- dispatch ----------

const stages = { db: stageDb, names: stageNames };
const stage = process.argv[2];
if (!stages[stage]) {
  console.error("usage: node tools/build-assets.js db");
  console.error("       node tools/build-assets.js names --lang zh|en|ja [--root <dir>]");
  process.exit(2);
}
stages[stage]();
