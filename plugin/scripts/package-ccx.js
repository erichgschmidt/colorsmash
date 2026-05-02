// Package the built plugin into a CCX/ZIP using forward-slash entry names.
// PowerShell's Compress-Archive emits backslashes, which Adobe's CC Desktop
// installer then can't resolve — the .ccx installs without errors but the
// panel loads blank because index.js / asset paths don't match.
//
// Run from plugin/ directory:  node scripts/package-ccx.js
//
// Outputs ColorSmash.zip and ColorSmash.ccx in plugin/ (identical bytes,
// different extension).

const AdmZip = require("adm-zip");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT_ZIP = path.join(ROOT, "ColorSmash.zip");
const OUT_CCX = path.join(ROOT, "ColorSmash.ccx");

const TOP_LEVEL = ["manifest.json", "index.html", "index.js"];
const FOLDERS = ["icons", "assets"];

const zip = new AdmZip();

for (const f of TOP_LEVEL) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) { console.error(`missing ${f}`); process.exit(1); }
  zip.addLocalFile(p);
}

const walk = (dir, rel) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(full, entryRel);
    else zip.addFile(entryRel, fs.readFileSync(full));
  }
};

for (const folder of FOLDERS) {
  const dir = path.join(ROOT, folder);
  if (fs.existsSync(dir)) walk(dir, folder);
}

zip.writeZip(OUT_ZIP);
fs.copyFileSync(OUT_ZIP, OUT_CCX);

const stat = fs.statSync(OUT_ZIP);
console.log(`Packaged ${OUT_ZIP} (${stat.size} bytes)`);
console.log(`Copied to ${OUT_CCX}`);
