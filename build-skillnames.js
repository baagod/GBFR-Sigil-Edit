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
//
// Usage: node build-skillnames.js [--lang zh|en|ja] [--root <project dir>]
//                                [--db <gbfr.db>] [--msg <text dir>] [--out <json path>]
//
// Needs an extracted copy of the game - the tables and the per-language text
// folder. The generated asset is committed, so only regenerating needs that.

"use strict";
const fs = require("fs");
const path = require("path");

const arg = (n, d) => {
  const i = process.argv.indexOf("--" + n);
  return i >= 0 ? process.argv[i + 1] : d;
};

// The game names its text folders with its own codes; the tool uses the usual
// language codes, so the two are mapped here.
const GAME_LANG = { zh: "cs", en: "en", ja: "jp" };

const LANG = arg("lang", "zh");
if (!(LANG in GAME_LANG)) {
  throw new Error(`unknown --lang ${LANG}; expected one of ${Object.keys(GAME_LANG).join(", ")}`);
}

const ROOT = arg("root", ".");
const DB = arg("db", path.join(ROOT, "vanilla.db"));
const MSG_DIR = arg(
  "msg",
  path.join(ROOT, "game_extract", "system", "table", "text", GAME_LANG[LANG]),
);
const IDS = arg("ids", path.join(ROOT, "GBFRDataTools", "Data", "ids.txt"));
const OUT = arg("out", path.join(ROOT, "SkillEditTool", "assets", `skillnames.${LANG}.json`));

// ---------- .msg text lookup ----------
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

// ---------- name_key -> short id ----------
// ids.txt lines look like: <HASH>|ID|<name>
function parseIds(file) {
  const byName = new Map();
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const parts = line.split("|");
    if (parts.length < 3) continue;
    byName.set(parts[2], parts[1]);
  }
  return byName;
}

function main() {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(DB);
  const cs = parseTextMessages(MSG_DIR);

  // ids.txt maps hash -> short id (and the reverse). gem columns store short ids
  // like SKILL_127_00 while skill_status stores the 8-hex hash, so both
  // spellings have to collapse onto the same lookup key.
  const idToHash = new Map();
  for (const line of fs.readFileSync(IDS, "utf8").split(/\r?\n/)) {
    const parts = line.split("|");
    if (parts.length < 3) continue;
    idToHash.set(parts[2], parts[0]);
  }

  const norm = (value) => {
    const key = String(value ?? "").trim();
    if (!key) return "";
    return idToHash.get(key) ?? key;
  };

  // name text key -> chinese text
  const textOf = (key) => (key ? (cs.get(key) ?? "") : "");

  // gem: SkillId1/SkillId2 -> sigil name
  const sigilName = new Map();
  for (const row of db.prepare("select SkillId1, SkillId2, Name from gem").all()) {
    const name = textOf(row.Name);
    if (!name) continue;
    for (const col of [row.SkillId1, row.SkillId2]) {
      const key = norm(col);
      if (key && !sigilName.has(key)) sigilName.set(key, name);
    }
  }

  // skill: Key -> skill name (fallback for skills with no owning sigil)
  const skillName = new Map();
  for (const row of db.prepare("select Key, Name from skill").all()) {
    const name = textOf(row.Name);
    if (name) skillName.set(norm(row.Key), name);
  }

  // skill_status.Key -> display name
  const keys = db
    .prepare("select distinct Key from skill_status")
    .all()
    .map((r) => norm(r.Key));

  const result = {};
  for (const key of keys) {
    const name = sigilName.get(key) || skillName.get(key);
    if (name) result[key] = name;
  }

  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result), "utf8");

  const size = fs.statSync(OUT).size;
  console.log(`skillnames.json -> ${OUT}`);
  console.log(`  ${Object.keys(result).length} names, ${(size / 1024).toFixed(1)} KB`);
  for (const k of ["06719232", "29B07BEB"]) {
    console.log(`  ${k} => ${result[k] ?? "(none)"}`);
  }
}

main();
