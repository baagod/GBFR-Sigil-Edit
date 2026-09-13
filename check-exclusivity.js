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

const E = (key, v1, enabled) => ({ Enabled: enabled, Key: key, Level: 14, Value1: v1, Value2: 0, Value3: 0 });
const show = (items) => items.map((e) => `${e.Value1}:${e.Enabled ? "on" : "off"}`).join("  ");

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

console.log("--- clicking an EARLIER duplicate must win (the reported bug) ---");
check("earlier row off, later row on; click earlier",
  [E("A", 30, false), E("B", 2, true), E("A", 60, true)], 0, "30:on  2:on  60:off");

console.log("\n--- clicking a LATER duplicate must win ---");
check("earlier on, later off; click later",
  [E("A", 30, true), E("B", 2, true), E("A", 60, false)], 2, "30:off  2:on  60:on");

console.log("\n--- turning a row OFF leaves the others alone ---");
check("both duplicates on (pre-normalised); click later off",
  [E("A", 30, true), E("B", 2, true), E("A", 60, true)], 2, "30:on  2:on  60:off");

console.log("\n--- unrelated rows are untouched ---");
check("click B, duplicates already exclusive",
  [E("A", 30, true), E("B", 2, false), E("A", 60, false)], 1, "30:on  2:on  60:off");

console.log("\n--- load-time normalisation: last enabled wins ---");
checkLoad("three enabled, two share an address",
  [E("A", 30, true), E("B", 2, true), E("A", 60, true)], "30:off  2:on  60:on");

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
