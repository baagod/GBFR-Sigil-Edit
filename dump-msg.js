// Dump a GBFR .msg (MessagePack) into JSON: { id, text } records.
//
// Layout observed in the file header:
//   map32 { "rows_": array32 [ map32 { "column_": array32 [ { "id_hash_": .., "text_": .., .. } ] } ] }
//
// Implemented by hand rather than pulling in @msgpack/msgpack, because we only
// need the two string fields and this keeps the toolchain dependency-free.
//
// Usage: node dump-msg.js <input.msg> <output.json>

"use strict";
const fs = require("fs");

class Reader {
  constructor(buf) {
    this.b = buf;
    this.p = 0;
  }
  u8() { return this.b[this.p++]; }
  u16() { const v = this.b.readUInt16BE(this.p); this.p += 2; return v; }
  u32() { const v = this.b.readUInt32BE(this.p); this.p += 4; return v; }
  i8() { return this.b.readInt8(this.p++); }
  i16() { const v = this.b.readInt16BE(this.p); this.p += 2; return v; }
  i32() { const v = this.b.readInt32BE(this.p); this.p += 4; return v; }
  f32() { const v = this.b.readFloatBE(this.p); this.p += 4; return v; }
  f64() { const v = this.b.readDoubleBE(this.p); this.p += 8; return v; }
  u64() { const v = this.b.readBigUInt64BE(this.p); this.p += 8; return Number(v); }
  i64() { const v = this.b.readBigInt64BE(this.p); this.p += 8; return Number(v); }
  str(n) { const s = this.b.toString("utf8", this.p, this.p + n); this.p += n; return s; }
  bin(n) { const s = this.b.subarray(this.p, this.p + n); this.p += n; return s; }
}

function readValue(r) {
  const c = r.u8();

  // fixmap / fixarray / fixstr
  if (c <= 0x7f) return c;
  if (c >= 0x80 && c <= 0x8f) return readMap(r, c & 0x0f);
  if (c >= 0x90 && c <= 0x9f) return readArray(r, c & 0x0f);
  if (c >= 0xa0 && c <= 0xbf) return r.str(c & 0x1f);

  if (c >= 0xe0) return c - 0x100; // negative fixint

  switch (c) {
    case 0xc0: return null;
    case 0xc2: return false;
    case 0xc3: return true;
    case 0xc4: return r.bin(r.u8());
    case 0xc5: return r.bin(r.u16());
    case 0xc6: return r.bin(r.u32());
    case 0xca: return r.f32();
    case 0xcb: return r.f64();
    case 0xcc: return r.u8();
    case 0xcd: return r.u16();
    case 0xce: return r.u32();
    case 0xcf: return r.u64();
    case 0xd0: return r.i8();
    case 0xd1: return r.i16();
    case 0xd2: return r.i32();
    case 0xd3: return r.i64();
    case 0xd9: return r.str(r.u8());
    case 0xda: return r.str(r.u16());
    case 0xdb: return r.str(r.u32());
    case 0xdc: return readArray(r, r.u16());
    case 0xdd: return readArray(r, r.u32());
    case 0xde: return readMap(r, r.u16());
    case 0xdf: return readMap(r, r.u32());
    default:
      throw new Error(`unsupported MessagePack marker 0x${c.toString(16)} at ${r.p - 1}`);
  }
}

function readArray(r, n) {
  const a = new Array(n);
  for (let i = 0; i < n; i++) a[i] = readValue(r);
  return a;
}

function readMap(r, n) {
  const o = {};
  for (let i = 0; i < n; i++) {
    const k = readValue(r);
    o[typeof k === "string" ? k : String(k)] = readValue(r);
  }
  return o;
}

function collect(node, out) {
  if (Array.isArray(node)) {
    for (const v of node) collect(v, out);
  } else if (node && typeof node === "object") {
    if (typeof node.id_hash_ === "string") {
      out.push({ id: node.id_hash_, text: typeof node.text_ === "string" ? node.text_ : "" });
    }
    for (const v of Object.values(node)) collect(v, out);
  }
}

function main() {
  const [, , input, output] = process.argv;
  if (!input || !output) {
    console.error("usage: node dump-msg.js <input.msg> <output.json>");
    process.exit(1);
  }

  const r = new Reader(fs.readFileSync(input));
  const root = readValue(r);

  const records = [];
  collect(root, records);

  const map = {};
  for (const rec of records) if (!(rec.id in map)) map[rec.id] = rec.text;

  fs.writeFileSync(output, JSON.stringify(map, null, 0), "utf8");
  console.log(`${input} -> ${output}`);
  console.log(`  ${records.length} records, ${Object.keys(map).length} unique ids, consumed ${r.p}/${r.b.length} bytes`);
}

main();
