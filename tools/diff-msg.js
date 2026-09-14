// Diff two id->text maps produced by dump-msg.js.
//
// Usage: node diff-msg.js <vanilla.json> <modded.json> [label]

"use strict";
const fs = require("fs");

const [, , vanillaPath, moddedPath, label] = process.argv;
const vanilla = JSON.parse(fs.readFileSync(vanillaPath, "utf8"));
const modded = JSON.parse(fs.readFileSync(moddedPath, "utf8"));

let changed = 0;
let added = 0;
let removed = 0;

for (const [id, text] of Object.entries(modded)) {
  if (!(id in vanilla)) {
    added++;
    console.log(`[+ 新增] ${id}\n    ${JSON.stringify(text)}`);
  } else if (vanilla[id] !== text) {
    changed++;
    console.log(`[~ 修改] ${id}`);
    console.log(`    原: ${JSON.stringify(vanilla[id])}`);
    console.log(`    新: ${JSON.stringify(text)}`);
  }
}

for (const id of Object.keys(vanilla)) {
  if (!(id in modded)) {
    removed++;
    console.log(`[- 删除] ${id}\n    原: ${JSON.stringify(vanilla[id])}`);
  }
}

console.log("");
console.log(`${label ?? ""} 修改 ${changed} 条, 新增 ${added} 条, 删除 ${removed} 条`);
