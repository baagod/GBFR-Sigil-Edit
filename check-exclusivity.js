// Standalone check of the exclusivity rule, mirroring App.tsx.
// Run: node check-exclusivity.js

const target = (e) => `${e.Key}@${e.Level}`;

function enforceExclusivity(items, keepIndex) {
  const addressOfKeep = keepIndex !== undefined ? target(items[keepIndex]) : undefined;

  const winner = new Map();
  items.forEach((e, i) => {
    if (!e.Enabled) return;
    const address = target(e);
    if (address === addressOfKeep) {
      winner.set(address, keepIndex);
    } else if (!winner.has(address)) {
      winner.set(address, i);
    } else if (keepIndex === undefined) {
      winner.set(address, i);
    }
  });

  return items.map((e, i) =>
    e.Enabled && winner.get(target(e)) !== i ? { ...e, Enabled: false } : e,
  );
}

function toggle(items, rowIndex) {
  const flipped = items.map((item, i) =>
    i === rowIndex ? { ...item, Enabled: !item.Enabled } : item,
  );
  return enforceExclusivity(
    flipped,
    flipped[rowIndex].Enabled ? rowIndex : undefined,
  );
}

// A fixture row in the shape App.tsx actually uses: Values is a 10-slot list.
const E = (key, level, value, enabled) => ({
  Enabled: enabled,
  Key: key,
  Level: level,
  Values: [value, 0, 0, 0, 0, 0, 0, 0, 0, 0],
});
const show = (items) =>
  items.map((e) => `${e.Key}@L${e.Level}v${e.Values[0]}:${e.Enabled ? "on" : "off"}`).join("  ");

let failures = 0;
function check(label, items, index, expected) {
  const got = show(toggle(items, index));
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  console.log(`      ${show(items)}`);
  console.log(`      click[${index}] -> ${got}${ok ? "" : `   expected: ${expected}`}`);
}
function checkLoad(label, items, expected) {
  const got = show(enforceExclusivity(items));
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  console.log(`      ${show(items)} -> ${got}${ok ? "" : `   expected: ${expected}`}`);
}
function checkShape(label, items) {
  const bad = items.some(
    (e) =>
      typeof e.Enabled !== "boolean" ||
      typeof e.Key !== "string" ||
      typeof e.Level !== "number" ||
      !Array.isArray(e.Values) ||
      e.Values.length !== 10,
  );
  if (bad) failures++;
  console.log(`${bad ? "FAIL" : "PASS"}  ${label}`);
}

console.log("--- fixture shape ---");
checkShape("rows are { Enabled, Key, Level, Values[10] }, so nothing renders as undefined", [
  E("A", 14, 30, true),
  E("A", 15, 60, false),
]);

console.log("\n--- clicking an EARLIER duplicate must win (the reported bug) ---");
check("earlier row off, later row on; click earlier",
  [E("A", 14, 30, false), E("B", 14, 2, true), E("A", 14, 60, true)], 0,
  "A@L14v30:on  B@L14v2:on  A@L14v60:off");

console.log("\n--- clicking a LATER duplicate must win ---");
check("earlier on, later off; click later",
  [E("A", 14, 30, true), E("B", 14, 2, true), E("A", 14, 60, false)], 2,
  "A@L14v30:off  B@L14v2:on  A@L14v60:on");

console.log("\n--- turning a row OFF leaves the others alone ---");
check("both duplicates on (pre-normalised); click later off",
  [E("A", 14, 30, true), E("B", 14, 2, true), E("A", 14, 60, true)], 2,
  "A@L14v30:on  B@L14v2:on  A@L14v60:off");

console.log("\n--- unrelated rows are untouched ---");
check("click B, duplicates already exclusive",
  [E("A", 14, 30, true), E("B", 14, 2, false), E("A", 14, 60, false)], 1,
  "A@L14v30:on  B@L14v2:on  A@L14v60:off");

console.log("\n--- the same Key at a different Level is a different row ---");
check("A@L14 on, A@L15 off; click A@L15 must not cancel A@L14",
  [E("A", 14, 30, true), E("A", 15, 60, false)], 1,
  "A@L14v30:on  A@L15v60:on");
check("both Levels on; clicking one off keeps the other",
  [E("A", 14, 30, true), E("A", 15, 60, true)], 0,
  "A@L14v30:off  A@L15v60:on");

console.log("\n--- load-time normalisation: last enabled wins ---");
checkLoad("three enabled, two share an address",
  [E("A", 14, 30, true), E("B", 14, 2, true), E("A", 14, 60, true)],
  "A@L14v30:off  B@L14v2:on  A@L14v60:on");
checkLoad("three duplicates in a row; the last one wins",
  [E("A", 14, 10, true), E("A", 14, 20, true), E("A", 14, 30, true)],
  "A@L14v10:off  A@L14v20:off  A@L14v30:on");
checkLoad("already exclusive rows are left alone",
  [E("A", 14, 30, true), E("B", 14, 2, false), E("A", 15, 60, true)],
  "A@L14v30:on  B@L14v2:off  A@L15v60:on");

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
