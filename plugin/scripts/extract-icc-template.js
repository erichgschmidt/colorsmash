#!/usr/bin/env node
// One-shot helper to extract template prefix/suffix from a reference ICC file.
// Usage: node extract-icc-template.js <path-to-reference.icc>
const fs = require('fs');
const path = require('path');

const refPath = process.argv[2];
if (!refPath) {
  console.error('Usage: node extract-icc-template.js <path-to-reference.icc>');
  process.exit(1);
}
const data = fs.readFileSync(refPath);
console.log('reference bytes:', data.length);

// Validate it's an mft2 33-grid DeviceLink
if (data.toString('ascii', 12, 16) !== 'link') throw new Error('Not a DeviceLink profile');
const a2b0 = 0x134;
if (data.toString('ascii', a2b0, a2b0 + 4) !== 'mft2') throw new Error('Not mft2 type');
const grid = data[a2b0 + 10];
if (grid !== 33) throw new Error(`Grid ${grid}, expected 33`);

const clutOff = a2b0 + 52 + 12; // 0x174 — header + 12-byte 2-entry input tables
const clutSize = grid * grid * grid * 3 * 2; // 215622
const outTablesOff = clutOff + clutSize;
const prefix = data.subarray(0, clutOff);
const suffix = data.subarray(outTablesOff);
console.log('prefix:', prefix.length, 'CLUT:', clutSize, 'suffix:', suffix.length);

const outDir = path.resolve(__dirname, '..', 'src', 'app');
fs.writeFileSync(path.join(outDir, '_icc_prefix_b64.txt'), prefix.toString('base64'));
fs.writeFileSync(path.join(outDir, '_icc_suffix_b64.txt'), suffix.toString('base64'));
console.log('Written prefix + suffix to', outDir);
