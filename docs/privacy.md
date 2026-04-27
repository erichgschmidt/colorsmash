# Privacy Policy — Color Smash

_Last updated: 2026-04-26_

Color Smash is a Photoshop UXP plugin that runs locally inside Adobe
Photoshop. **It does not collect, store, or transmit any user data.**

## What the plugin reads

To perform color matching the plugin reads pixel data from the
documents and layers you explicitly select in its panel. All reads
happen entirely on your machine inside the Photoshop process.

## What the plugin writes

- A single Curves adjustment layer inside a `[Color Smash]` group in
  the Photoshop document you target.
- An optional preferences file (`color-smash-settings.json`) saved in
  the plugin's data folder when the **Remember** toggle is enabled.
  This stores your panel settings (slider values, zone configuration,
  envelope points, etc.) so they persist across panel reloads. The
  file never leaves your machine.

## What the plugin does not do

- No network requests of any kind.
- No telemetry, analytics, or crash reporting.
- No reading of files outside the documents and image files you
  explicitly load through the plugin's "Browse Image…" picker.
- No third-party services or SDKs.

## Permissions requested

The Photoshop manifest requests `localFileSystem: "request"` so users
can pick an image file from disk via the "Browse Image…" source
option. Files chosen this way are read once and discarded.

## Contact

Questions or concerns: erichgschmidt@gmail.com
