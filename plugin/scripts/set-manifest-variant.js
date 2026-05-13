// Swap manifest.json between the canonical free variant (matches master /
// the shipped marketplace plugin) and the Pro variant (distinct id + name
// so UDT can load it alongside an installed free plugin without conflict).
//
// Run as post-build step in npm run build:free / build:pro so the manifest
// is always in sync with the index.js that was just built. Idempotent:
// running the same variant twice is a no-op-equivalent rewrite.
//
// Usage:  node scripts/set-manifest-variant.js <free|pro>

const fs = require("fs");
const path = require("path");

const variant = (process.argv[2] || "").toLowerCase();
if (variant !== "free" && variant !== "pro") {
  console.error("Usage: node scripts/set-manifest-variant.js <free|pro>");
  process.exit(1);
}

// Canonical free values — match master's manifest.json exactly so
// `npm run build:free` always lands the working tree in a state that
// can be committed without diff against master's manifest.
const FREE_ID = "44bb5649";
const FREE_NAME = "Color Smash";

// Pro variant — distinct so it doesn't collide with the installed free
// plugin when loaded via UDT (UXP keys plugins by id). The name suffix
// makes the panel readable in PS's plugin menu.
const PRO_ID = "44bb5649-pro";
const PRO_NAME = "Color Smash Pro";

const manifestPath = path.resolve(__dirname, "..", "manifest.json");
const raw = fs.readFileSync(manifestPath, "utf8");
const m = JSON.parse(raw);

if (variant === "pro") {
  m.id = PRO_ID;
  m.name = PRO_NAME;
} else {
  m.id = FREE_ID;
  m.name = FREE_NAME;
}

// Preserve the original file's trailing-newline convention.
const hasTrailingNewline = raw.endsWith("\n");
fs.writeFileSync(
  manifestPath,
  JSON.stringify(m, null, 2) + (hasTrailingNewline ? "\n" : ""),
);
console.log(`manifest.json set to ${variant} (id=${m.id}, name="${m.name}")`);
