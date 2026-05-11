#!/usr/bin/env node
// Smoke-test the ICC DeviceLink generator: build an identity profile and
// verify the byte structure matches what PS expects.
const fs = require('fs');
const path = require('path');

const prefixB64 = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', '_icc_prefix_b64.txt'), 'utf8').trim();
const suffixB64 = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', '_icc_suffix_b64.txt'), 'utf8').trim();
const prefix = Buffer.from(prefixB64, 'base64');
const suffix = Buffer.from(suffixB64, 'base64');

const GRID = 33;
const clut = Buffer.alloc(GRID * GRID * GRID * 3 * 2);
let p = 0;
for (let ri = 0; ri < GRID; ri++) {
  const rIn = Math.round(ri / (GRID - 1) * 255);
  for (let gi = 0; gi < GRID; gi++) {
    const gIn = Math.round(gi / (GRID - 1) * 255);
    for (let bi = 0; bi < GRID; bi++) {
      const bIn = Math.round(bi / (GRID - 1) * 255);
      clut.writeUInt16BE(rIn * 257, p); p += 2;
      clut.writeUInt16BE(gIn * 257, p); p += 2;
      clut.writeUInt16BE(bIn * 257, p); p += 2;
    }
  }
}
const profile = Buffer.concat([prefix, clut, suffix]);
profile.writeUInt32BE(profile.length, 0);
console.log('Generated identity ICC size:', profile.length);

const refPath = process.argv[2] || 'C:\\Users\\Gus\\Desktop\\ColorSmash_DifferentUseCases_01.ICC';
if (fs.existsSync(refPath)) {
  const ref = fs.readFileSync(refPath);
  console.log('Reference size:', ref.length);
  console.log('Prefix bytes identical:', Buffer.compare(profile.subarray(0, 0x174), ref.subarray(0, 0x174)) === 0);
  console.log('Suffix bytes identical:', Buffer.compare(profile.subarray(0x34bba), ref.subarray(0x34bba)) === 0);
  // Show how the reference's CLUT entry [0] differs from our identity (it's a real LUT)
  console.log('Reference CLUT[0] (R,G,B uint16):', ref.readUInt16BE(0x174), ref.readUInt16BE(0x176), ref.readUInt16BE(0x178));
  console.log('Our identity CLUT[0]:', profile.readUInt16BE(0x174), profile.readUInt16BE(0x176), profile.readUInt16BE(0x178));
}

const outPath = process.argv[3] || 'C:\\Users\\Gus\\Desktop\\our_identity.icc';
fs.writeFileSync(outPath, profile);
console.log('Saved:', outPath);
