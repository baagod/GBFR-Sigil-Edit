// Resolve the Chinese display name for a list of gem/skill ids, using the same
// chain as build-skillnames.js:
//   gem.Key or gem.SkillId1 -> gem.Name (TXT_GEEN_*) -> text.msg
//
// Usage: node lookup-gems.js SKILL_067_00 SKILL_158_00 ...

"use strict";
const fs = require("fs");
const path = require("path");

const GEN = "D:/Games/Relink/GBFR.PreEquippedSigils/gen";
const DB = path.join(GEN, "extracted", "gbfr.db");
const MSG_CS = path.join(GEN, "extracted", "system", "table", "text", "cs");

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
      e.isDirectory() ? walk(path.join(d, e.name))
        : e.name.endsWith(".msg") ? [path.join(d, e.name)] : []);
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
        const r = pstring(b, t + 5);
        if (r) {
          const text = r.raw.toString("utf8").replace(/\u0000+/g, "").trim();
          if (text && !out.has(id)) out.set(id, text);
        }
      }
      p = t >= 0 ? t + 5 : idRec.next;
    }
  }
  return out;
}

const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(DB);
const cs = parseTextMessages(MSG_CS);
const textOf = (k) => (k ? (cs.get(k) ?? "") : "");

// Build: any spellings of a gem id -> chinese name
const idToHash = new Map();
for (const line of fs.readFileSync(path.join(GEN, "GBFRDataTools/Data/ids.txt"), "utf8").split(/\r?\n/)) {
  const p = line.split("|");
  if (p.length >= 3) idToHash.set(p[2], p[0]);
}
const norm = (v) => {
  const k = String(v ?? "").trim();
  if (!k) return "";
  return idToHash.get(k) ?? k;
};

const bySkill = new Map();   // SkillId1/2 hash -> gem zh name
const byGemKey = new Map();  // gem.Key hash -> gem zh name
for (const row of db.prepare("select Key, SkillId1, SkillId2, Name from gem").all()) {
  const name = textOf(row.Name);
  if (!name) continue;
  byGemKey.set(norm(row.Key), name);
  for (const c of [row.SkillId1, row.SkillId2]) {
    const k = norm(c);
    if (k && !bySkill.has(k)) bySkill.set(k, name);
  }
}

const skillNames = new Map();
for (const row of db.prepare("select Key, Name from skill").all()) {
  const name = textOf(row.Name);
  if (name) skillNames.set(norm(row.Key), name);
}

for (const arg of process.argv.slice(2)) {
  const key = norm(arg);
  const name = byGemKey.get(key) || bySkill.get(key) || skillNames.get(key) || "(未找到名字)";
  console.log(`${arg.padEnd(16)} ${name}`);
}
