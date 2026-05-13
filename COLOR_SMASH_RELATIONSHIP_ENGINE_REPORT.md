# Color Smash Relationship Engine Report

_Last updated: 2026-05-12_

## Purpose

This report explores a future direction for Color Smash now that LUT creation and Color Lookup output are working: moving beyond conventional source-to-target color matching into a more distinctive **Color Smash Relationship Engine**.

The core idea is to analyze a source image as a set of correlated color relationships, then let the user selectively compress, expand, inject, suppress, or exaggerate those relationships into a target image. This would make Color Smash feel less like a traditional color match utility and more like a Photoshop-native color interpretation system.

This document is intentionally detailed and speculative. It is meant for planning and audit, not immediate implementation.

---

## Executive summary

Traditional color matching asks:

> How do we make the target statistically resemble the source?

The proposed Color Smash Relationship Engine asks:

> What relationships make the source image feel the way it does, and how can those relationships be transferred, remixed, compressed, expanded, or explored on the target?

The plugin should gradually evolve from:

```text
source pixels + target pixels -> histogram match -> curves or LUT
```

into:

```text
source pixels -> relationship analysis -> editable correlation fields -> target-aware transform -> curves/LUT/masks/presets
```

This gives Color Smash a stronger identity:

- **Color Match** = accurate utility.
- **Color Smash** = creative relationship transfer.
- **Range Fields** = Photoshop Color Range-style targeting, but with better controls and deeper color dimensions.
- **Relationship LUTs** = LUTs authored from correlated value/hue/saturation/chroma behavior instead of only RGB point transforms.

The highest-potential direction is not to clone tools like ChromaWarp, 3D LUT Creator, Color.io, or fylm.ai. Those tools already occupy strong positions: precision color-space warping, color grids, scene-referred LUTs, film-style grading, and AI matching. Color Smash can differentiate by focusing on **histogram-aware, Photoshop-native, source-to-target relationship transfer**.

---

## Market and feature research summary

### ChromaWarp / MindTheColor

Reference: https://www.mindthecolor.com/chromawarp

ChromaWarp positions itself as a color-transformation engine built around:

- CIELAB internal processing.
- Real-time LUT updates.
- Output through a Photoshop Color Lookup adjustment layer.
- Settings saved as XMP metadata directly into the Color Lookup layer.
- Anchor points / “Paletti” that act as interpolation boundary conditions.
- HSV qualifiers for hue, saturation, and brightness domain restriction.

Relevant takeaways:

- ChromaWarp is built around **point/anchor-based color warping**.
- Its value is precision, stability, and localized color movement without manual masks.
- The HSV qualifier model validates the value of multi-dimensional range controls.
- Its use of CIELAB validates Lab as a strong perceptual processing space.

Risk of overlap:

If Color Smash focuses mainly on user-drawn input/output color anchors, protected colors, and HSV qualifiers, it will feel close to ChromaWarp.

Differentiation opportunity:

Color Smash should instead focus on **relationship analysis and distribution transfer**: value/hue/saturation/chroma correlations, histogram band compression, source trait extraction, target-aware injection, and painterly/grouping behavior.

---

### 3D LUT Creator

References:

- https://3dlutcreator.com/
- https://lutcreator.com/index.html
- https://lutcreator.com/3d-lut-creator---tutorials.html

3D LUT Creator is a mature LUT-authoring application with:

- A/B color grid.
- C/L color/lightness grid.
- Channels.
- Volume.
- 2D curves.
- Masks.
- LUT import and editing.
- Color match.
- Waveform/parade analyzer.
- Photoshop integration.
- LUT sizes up to 96 in Pro; 33 in lower editions.

The A/B grid allows hue and saturation changes independent of brightness. The C/L grid allows color changes dependent on brightness. The Volume tool adjusts brightness accents based on color. These are powerful examples of multi-dimensional color controls.

Relevant takeaways:

- Grid-based color deformation is powerful but complex.
- Color/lightness correlation is a proven control surface.
- LUT size and color-mask quality matter to pro users.
- Users respond to visual manipulation models, not just sliders.

Risk of overlap:

Trying to implement a full 3D color grid or a traditional LUT deformation workspace would be a large, competitive, and potentially overwhelming direction.

Differentiation opportunity:

Color Smash can use the same underlying insight — color dimensions are correlated — but surface it through **source/target relationship fields**, band compression, ratio controls, and Photoshop-native output.

---

### Color.io

Reference: https://webflow.color.io/

Color.io emphasizes:

- RAW processing.
- Color-managed LUT export.
- Filmic/analog grading engine.
- AI color matching / look transfer.
- Analog curves.
- Refraction wheels for stable HSL-like shifts.
- Real-time scopes: histograms, waveform, vectorscope, masks.
- Film grain, halation, density, texture, and show-look creation.

Relevant takeaways:

- Users value color-managed LUT creation.
- Real-time scopes reinforce trust and help users steer grades.
- “Stable” color manipulation is an important market claim.
- Filmic and analog language is strong in the market but not necessarily Color Smash’s best identity.

Risk of overlap:

If Color Smash becomes primarily a film look / cinematic LUT creator, it enters a crowded market with strong competitors.

Differentiation opportunity:

Color Smash should target Photoshop-native artists, concept artists, illustrators, texture artists, retouchers, and color-match workflows where source images, selections, layers, masks, and palettes matter more than camera/log workflows.

---

### fylm.ai / Lutify.me

References:

- https://fylm.ai/features/
- https://lutify.me/
- https://lutify.me/products/

Lutify/fylm emphasize:

- Scene-referred LUTs.
- Color-managed workflows.
- AI-assisted LUT creation.
- Filmic curve responses.
- Subtractive CMY color density.
- Show LUT creation.

Relevant takeaways:

- “Color managed” is a serious professional differentiator.
- Scene-referred workflows matter to high-end video users.
- AI-assisted LUT creation validates the need for guided look creation.

Risk of overlap:

Color Smash should not try to become a full video/post-production LUT platform in the short term.

Differentiation opportunity:

Color Smash can be the Photoshop-native system for **relationship-aware look transfer**, with optional LUT export for portability.

---

## Proposed product identity

### Current identity

Color Smash is currently a Photoshop UXP plugin for source-to-target color matching using histogram-driven curves and LUT export.

### Expanded identity

Color Smash becomes:

> A Photoshop-native color relationship engine that extracts the color DNA of one image and lets users smash it into another by value, hue, saturation, chroma, contrast, accents, masks, and range fields.

### Suggested positioning

Short positioning:

> Color Smash turns references into editable color relationships, then lets you blend, compress, inject, or exaggerate those relationships into your target.

Long positioning:

> Color Smash is not just a LUT loader or a color match button. It analyzes how a source image organizes value, hue, saturation, chroma, accents, contrast, and color groupings, then gives artists real-time controls to transfer those relationships into a target image as curves, LUTs, masks, or reusable presets.

---

## Core conceptual model

### 1. Source traits

A source image should be analyzed into high-level traits:

- Value structure.
- Hue families.
- Saturation behavior.
- Chroma behavior.
- Contrast distribution.
- Neutral behavior.
- Accent behavior.
- Cluster/grouping behavior.
- Potential mark/texture behavior.

Each trait should be independently controllable.

Example UI:

```text
Source Traits

Value Structure       70%
Hue Families          45%
Saturation Logic      55%
Chroma Density        35%
Contrast Grouping     60%
Accents               80%
Neutral Protection    75%
Marks / Texture       20%
```

### 2. Target correlation fields

The target image should be analyzed into the same or compatible relationship fields. Color Smash should not simply impose the source globally. It should correlate source behavior to target behavior.

Example:

```text
Source shadow band:
- value range: 0.04-0.22
- hue tendency: cool blue/violet
- saturation: low-medium
- chroma compression: tight
- contrast: soft

Target shadow band:
- value range: 0.02-0.31
- hue tendency: warm brown/green
- saturation: mixed
- contrast: noisy

Transfer decision:
- compress target shadow values toward source shadow tightness
- shift hue partially toward source cool family
- reduce saturation in low-chroma areas
- preserve target edge contrast if texture protection is high
```

### 3. Correlation-driven LUT generation

A conventional LUT maps:

```text
input RGB -> output RGB
```

A Color Smash relationship LUT would be authored from additional context:

```text
input RGB + derived dimensions -> output RGB
```

Derived dimensions may include:

- Luminance/value band.
- Hue family.
- Saturation class.
- Chroma class.
- Neutrality score.
- Accent score.
- Cluster membership.
- Source-to-target percentile mapping.
- Soft range masks.

The final LUT still bakes into a normal RGB 3D LUT, but the authoring process is more intelligent.

### 4. Compression per section

Each section/band should have its own compression behavior.

For any selected band or field, compute:

- Source min/max or robust percentile bounds.
- Source median/mean.
- Source spread/tightness.
- Source skew.
- Source density profile.
- Target equivalents.
- Mapping from target distribution into source distribution.

Then allow controls such as:

```text
Compression Match   0-100
Expansion Match     0-100
Source Tightness    0-100
Target Preserve     0-100
Range Softness      0-100
Outlier Protection  0-100
```

This is especially important for stylized images. A source may have tightly grouped shadows, open airy highlights, or saturated accents only in a narrow band. Matching should respect these internal differences.

---

## Recommended analysis dimensions

The engine should avoid thinking only in RGB. Use a layered analysis model.

### Core pixel spaces

1. **Linear/sRGB RGB**
   - Needed for LUT generation and Photoshop compatibility.
   - Use carefully because RGB is not perceptually uniform.

2. **CIE Lab**
   - Good for perceptual distance, clustering, and source/target palette analysis.
   - Strong candidate for cluster membership, palette weights, and ChromaWarp-like natural transformations.

3. **LCh / Lab polar form**
   - L = perceptual lightness.
   - C = chroma.
   - h = hue angle.
   - Good for separating value, chroma, and hue relationships.

4. **HSV/HSL/HSY-like helper spaces**
   - Useful for user-facing range controls because artists understand hue/saturation/brightness.
   - Should not necessarily be the internal match space.

5. **Rec.709 or perceptual luma**
   - Useful for Photoshop blend-mode emulation, masks, and histogram bands.

### Derived scores

For each pixel/sample, compute:

```ts
type PixelFeatures = {
  rgb: Vec3;
  lab: Vec3;
  lch: { L: number; C: number; h: number };
  luma: number;
  valuePercentile: number;
  saturation: number;
  chroma: number;
  hueAngle: number;
  neutralScore: number;
  accentScore: number;
  warmCoolScore: number;
  localContrast?: number;
  edgeScore?: number;
  clusterId?: number;
};
```

### Band axes

Start with these axes:

1. **Value bands**
   - Shadows, mids, highlights.
   - 3/5/7 mode.
   - Should be MVP.

2. **Hue family bands**
   - Red/orange/yellow/green/cyan/blue/violet, or data-driven hue clusters.
   - Better as V2.

3. **Saturation/chroma bands**
   - Muted, moderate, vivid.
   - Useful for accent handling.

4. **Neutrality bands**
   - Near-neutral vs colored.
   - Important for protecting grays, whites, blacks, skin, and UI/textures.

5. **Local contrast / mark bands**
   - Flat areas vs edge/detail/texture.
   - Experimental V3.

---

## Relationship matrix

A useful internal structure is a relationship matrix. For each value band, summarize correlated dimensions.

Example:

```text
                 Shadows        Mids             Highlights
Value range      0.03-0.24      0.24-0.68        0.68-0.96
Hue tendency     blue/violet    ochre/red        cream/yellow
Sat median       low            medium-high      low
Chroma spread    tight          open             tight
Contrast         soft           detailed         soft
Neutrality       high           medium           high
Accent density   rare           common           rare
Pixel ratio      28%            49%              23%
```

This matrix becomes an editable transfer surface.

User control matrix:

```text
                 Shadows   Mids   Highlights
Value              70       30       10
Hue                80       60       40
Saturation         40       75       20
Chroma             50       65       25
Contrast           50       65       35
Accents            10       80       45
Neutral Protect    80       50       70
```

This is more distinctive than a normal LUT control panel.

---

## Proposed engine architecture

### Stage 1: Sample acquisition

Input sources:

- Source image/layer/selection.
- Target image/layer/selection.
- Optional manual recipe/palette source.
- Optional loaded LUT source.

Sampling goals:

- Downsample for responsiveness.
- Preserve enough density for stable histograms.
- Cache aggressively.
- Support 8-bit and 16-bit sources.

Potential data structure:

```ts
type SampleSet = {
  width: number;
  height: number;
  pixels: Float32Array; // normalized RGB triples
  features: PixelFeatures[];
  histograms: HistogramBundle;
  clusters: ClusterBundle;
  stats: ImageStats;
};
```

### Stage 2: Feature extraction

For source and target:

1. Convert RGB to Lab/LCh.
2. Compute luma/value.
3. Compute saturation/chroma.
4. Compute hue angle.
5. Compute neutral score.
6. Compute accent score.
7. Compute local contrast/edge score if enabled.
8. Assign value bands.
9. Assign hue/chroma/saturation bands if enabled.
10. Assign cluster membership.

### Stage 3: Band construction

Define bands from:

- Fixed ranges: 0-33-66-100, etc.
- Adaptive percentiles: P10/P50/P90 or P5/P20/P50/P80/P95.
- Cluster-driven boundaries.
- Manual user-defined boundaries.

Recommended default:

```text
3 bands: adaptive Shadows / Mids / Highlights
5 bands: adaptive Deep / Shadow / Mid / Light / Highlight
7 bands: adaptive full sculpting
```

Each band should have:

```ts
type BandStats = {
  axis: 'value' | 'hue' | 'saturation' | 'chroma' | 'neutrality' | 'contrast';
  index: number;
  label: string;
  bounds: [number, number];
  center: number;
  softWidth: number;
  pixelRatio: number;
  meanLab: Vec3;
  medianLab: Vec3;
  dominantHue: number;
  hueSpread: number;
  satMedian: number;
  chromaMedian: number;
  chromaSpread: number;
  valueSpread: number;
  contrastMedian?: number;
  accentDensity: number;
  neutralDensity: number;
  histogram: Float32Array;
};
```

### Stage 4: Source-target correlation mapping

For each target sample and each LUT grid point, estimate its membership in one or more target bands.

Then compute desired movement based on corresponding source band stats.

Potential mapping categories:

1. **Value-to-value mapping**
   - Map target luma percentile to source luma percentile.
   - Control: Value Transfer.

2. **Value + hue mapping**
   - Within each value band, shift target hue distribution toward source hue distribution.
   - Control: Hue Families by Band.

3. **Value + saturation/chroma mapping**
   - Within each value band, match target saturation/chroma compression or expansion to source.
   - Control: Saturation Logic / Chroma Density.

4. **Hue + saturation mapping**
   - For each hue family, match saturation behavior from source.
   - Control: Accent Transfer.

5. **Neutrality mapping**
   - Detect near-neutral pixels and decide whether to protect, tint, or match source neutral drift.
   - Control: Neutral Protection / Neutral Cast.

6. **Contrast/mark mapping**
   - Optional later: use local contrast to decide if color variation should be preserved, compressed, or injected.
   - Control: Mark Influence / Texture Preservation.

### Stage 5: Transform synthesis

The engine synthesizes a transform for each pixel/LUT grid coordinate by combining relationship fields.

Pseudo formula:

```ts
output = input;

output = mix(output, valueMatched(output, source, target), controls.valueAmount);
output = mixHue(output, hueMatchedByValueBand(output), controls.hueAmount);
output = mixChroma(output, chromaMatchedByBand(output), controls.chromaAmount);
output = mixSaturation(output, saturationMatchedByBand(output), controls.saturationAmount);
output = applyNeutralProtection(output, input, controls.neutralProtect);
output = applyAccentTransfer(output, input, controls.accentAmount);
output = applyCompressionPerBand(output, sourceBandStats, targetBandStats, controls.compression);

final = mix(input, output, globalStrength);
```

Important: use controlled, smooth interpolation. Extreme changes should degrade gracefully.

### Stage 6: Output

Possible outputs:

- Live preview.
- Color Lookup adjustment layer.
- Exported `.cube` LUT.
- Multi-curve stack.
- Masked curve stack.
- Color Smash preset/profile.
- Diagnostic report / Source DNA snapshot.

---

## Compression model

The user specifically proposed that each section should be processed with its own compression application. This should become a central part of the engine.

### What “compression” means here

Compression can apply to multiple dimensions:

- Value range compression.
- Hue spread compression.
- Saturation spread compression.
- Chroma spread compression.
- Contrast/detail compression.
- Cluster separation compression.

Example:

If source shadows are tight and muted, and target shadows are scattered and noisy, the engine can compress the target shadows toward a tighter source-like distribution.

If source mids are open and colorful, and target mids are flat, the engine can expand target mids toward source-like variation.

### Per-band compression stats

For every band:

```ts
type CompressionStats = {
  robustMin: number;
  robustMax: number;
  p05: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  iqr: number;
  stdDev: number;
  skew: number;
  densityPeaks: number[];
};
```

### Compression transfer

For a given dimension `d`:

```ts
sourceNorm = normalizeBySourceDistribution(d);
targetNorm = normalizeByTargetDistribution(d);
matched = sourceQuantile(targetPercentile(d));
```

Then blend:

```ts
result = mix(originalTargetValue, matched, amount);
```

A user-facing control can simplify this:

```text
Band Compression
- Preserve Target
- Balanced
- Match Source Tightness
- Smash / Exaggerate
```

### Recommended controls

```text
Compression Amount      0-100
Expansion Amount        0-100
Outlier Guard           0-100
Band Softness           0-100
Preserve Edges          0-100
Protect Neutrals        0-100
```

Avoid too many technical controls in the first UI. Advanced controls can live in an expanded section.

---

## “Upscale algos” / detail injection note

The idea of injecting upscale-like algorithms is interesting but should probably wait.

Potential interpretations:

1. **Detail reconstruction**
   - Use source local contrast/detail profile to enhance target detail.
   - Risk: enters sharpening/super-resolution territory.

2. **Mark structure transfer**
   - Transfer where accents or micro-contrast tend to occur.
   - More aligned with Color Smash.

3. **Palette/detail expansion**
   - If target has flat regions, inject subtle source-like hue/chroma variation.
   - Feasible if done conservatively.

Recommendation:

Do not build true upscaling/super-resolution in early phases. Instead, implement:

```text
Micro Variation
Accent Injection
Mark Influence
Texture Protection
```

These can give an “upscale-like” richness without promising actual resolution reconstruction.

---

## Proposed UI model

### Top-level modes

Recommended future modes:

```text
Match
Smash
Range
Recipe
Export
```

#### Match

The existing faithful color match workflow.

Core controls:

- Full / Color / Hue / Saturation / Contrast.
- RGB / Lab.
- Source palette.
- Target palette.
- Curves / LUT output.

#### Smash

The relationship transfer engine.

Core controls:

- Source Traits.
- Relationship Matrix.
- Band Compression.
- Accent Transfer.
- Neutral Protection.
- Global Smash Amount.

#### Range

Color Range 2.0 for masks and application fields.

Core controls:

- Value range.
- Hue range.
- Saturation range.
- Chroma range.
- Color distance.
- Cluster membership.
- Falloff.
- Feather.
- Smooth.
- Expand/contract.
- Invert.

#### Recipe

Source-less/manual palette authoring.

Core controls:

- 3/5/7 value bands.
- User-picked colors.
- Ratios.
- Preserve target values.
- Softness.
- Export LUT.

#### Export

Production output.

Core controls:

- Apply as Color Lookup.
- Apply as Curves.
- Apply as Multi Curves.
- Export `.cube`.
- Save Color Smash preset.
- Store XMP/layer metadata if supported.

---

## Suggested MVP path

Do not build the entire vision at once. Build it in layers.

### Phase 1: Source DNA report and controls

Goal:

Add a new analysis layer without changing core matching too much.

Features:

- Analyze source and target into 3 value bands.
- Show each band’s:
  - pixel ratio,
  - dominant hue,
  - median saturation,
  - median chroma,
  - value spread,
  - neutral density,
  - accent density.
- Add simple trait sliders:
  - Value Structure,
  - Hue Families,
  - Saturation Logic,
  - Chroma Density,
  - Neutral Protect,
  - Accent Transfer.

Output:

- Live preview only first, then LUT.

Why this phase matters:

It establishes the mental model without overcommitting to complex UI.

### Phase 2: Relationship Matrix / Band Compression

Goal:

Let users control source transfer per band.

Features:

- 3/5/7 value bands.
- Per-band compression.
- Per-band hue transfer.
- Per-band saturation/chroma transfer.
- Global softness.
- Target preservation.

Output:

- Apply LUT.
- Export LUT.
- Possibly apply as multi-curve stack when feasible.

### Phase 3: Range Fields

Goal:

Build Photoshop Color Range-like controls that feed the matching engine.

Features:

- Value/hue/saturation/chroma range mask preview.
- Falloff/feather/smooth/expand/contract.
- Combine range fields.
- Use range field as mask for LUT/curves application.

Output:

- Layer mask.
- LUT application mask.
- Target protection map.

### Phase 4: Manual Recipe mode

Goal:

Allow source-less color creation.

Features:

- 3/5/7 manual bands.
- Color pickers.
- Ratio bar.
- Preserve target luminance.
- Match target structure to manual source distribution.

Output:

- Export/apply LUT.
- Save recipe preset.

### Phase 5: Mark/Grouping transfer

Goal:

Experiment with painterly/source-style behavior.

Features:

- Local contrast field.
- Edge/detail field.
- Cluster hierarchy.
- Zone collapse/separation.
- Accent injection near comparable regions.

Output:

- Creative Smash effects.

This should be considered experimental until proven.

---

## Technical implementation notes

### Performance

The engine should be designed around cached sample sets and derived fields.

Recommended approach:

- Downsample source/target for analysis and preview.
- Build histograms and feature arrays once per source/target refresh.
- Cache cluster assignments.
- Recompute only affected transforms when sliders change.
- Keep LUT grid generation separate from preview rendering.
- Use a lower grid or preview LUT for scrubbing, then high-quality LUT on apply/export.

### Sampling sizes

Suggested defaults:

```text
Preview analysis: 256 px max dimension or capped sample count
High-quality analysis: 512-1024 px max dimension depending on performance
LUT preview: 17^3 or 33^3
Final LUT: 33^3 default, 65^3 high quality
```

### Color spaces

Recommended internal defaults:

- Use Lab/LCh for distance, clustering, hue/chroma stats, and perceptual movement.
- Use RGB for final LUT output.
- Use luma/HSY-like behavior when emulating Photoshop blend modes.
- Avoid HSV as primary internal math, but use HSV/HSL-like naming for UI range controls.

### Numerical stability

Protect against:

- Empty bands.
- Tiny sample counts.
- Overfitting to sparse regions.
- Hue wrap discontinuities.
- Extreme saturation shifts.
- Neutral color contamination.
- Banding from steep transforms.
- Out-of-gamut values.

Use:

- Robust percentiles instead of raw min/max.
- Minimum sample thresholds.
- Smoothing kernels.
- Slope caps.
- Outlier guards.
- Identity fallback for weak/empty bands.

---

## Possible data types

```ts
type TraitId =
  | 'value'
  | 'hue'
  | 'saturation'
  | 'chroma'
  | 'contrast'
  | 'neutrality'
  | 'accents'
  | 'marks';

interface RelationshipEngineControls {
  globalAmount: number;
  valueAmount: number;
  hueAmount: number;
  saturationAmount: number;
  chromaAmount: number;
  contrastAmount: number;
  accentAmount: number;
  neutralProtect: number;
  compressionAmount: number;
  expansionAmount: number;
  softness: number;
  outlierGuard: number;
  preserveTargetValues: boolean;
  preserveTargetTexture: boolean;
  bandCount: 3 | 5 | 7;
}

interface RelationshipBandControls {
  bandId: string;
  enabled: boolean;
  valueAmount: number;
  hueAmount: number;
  saturationAmount: number;
  chromaAmount: number;
  compressionAmount: number;
  accentAmount: number;
  neutralProtect: number;
}

interface RelationshipProfile {
  sourceStats: ImageRelationshipStats;
  targetStats: ImageRelationshipStats;
  bands: RelationshipBandPair[];
  controls: RelationshipEngineControls;
}
```

---

## Preview design

The user should see what relationships are being transferred.

Potential panels:

### Source DNA strip

A compact banded strip:

```text
Shadows | Mids | Highlights
```

Each segment shows:

- representative color,
- pixel ratio width,
- saturation/chroma indicator,
- small icon for neutral/accent density.

### Relationship matrix

A compact advanced grid:

```text
                 Shadows   Mids   Highlights
Value              70       30        10
Hue                80       60        40
Saturation         40       75        20
Chroma             50       65        25
Accents            10       80        45
Neutral Protect    80       50        70
```

### Range preview

The Range tab should preview a grayscale mask for the selected range field.

### Before/After / Smash amount

Preserve current preview habits:

- Before/after badge.
- Live update.
- Apply/export only when the user commits.

---

## Naming ideas

Feature family names:

- Color DNA.
- Source DNA.
- Smash Matrix.
- Relationship Engine.
- Range Fields.
- Band Compression.
- Accent Transfer.
- Zone Smash.
- Look Recipe.
- Palette Gravity.
- Chroma Bands.
- Value Bands.

Recommended naming stack:

- User-facing feature: **Color DNA**.
- Advanced control surface: **Smash Matrix**.
- Masking system: **Range Fields**.
- Manual source mode: **Look Recipe**.
- Creative effect controls: **Zone Smash**.

---

## What not to build yet

Avoid early scope creep:

- Full 3D LUT grid editor.
- Full ChromaWarp-style anchor/paletto system.
- True super-resolution/upscaling.
- Full video color management pipeline.
- HDR/scene-referred workflow before standard RGB is robust.
- Arbitrary unlimited bands.
- Deep AI model dependence.
- Complex waveform/vectorscope suite unless it directly helps steering.

These may be valuable later, but they are not needed to prove the Color Smash identity.

---

## Recommended immediate planning decisions

Before implementation, decide:

1. What is the first “Smash” feature?
   - Recommendation: Color DNA with 3 value bands and trait sliders.

2. What internal color space is canonical for relationship analysis?
   - Recommendation: Lab/LCh for stats and perceptual movement, RGB for final output.

3. What dimensions are v1?
   - Recommendation: value, hue, saturation/chroma, neutral, accent.

4. What dimensions are later?
   - Recommendation: local contrast, marks, texture, cluster hierarchy.

5. How much UI should be exposed initially?
   - Recommendation: high-level trait sliders first; advanced matrix hidden under disclosure.

6. What output should be supported first?
   - Recommendation: live preview + LUT output; Curves stack only where mathematically reasonable.

7. What is the failure mode?
   - Recommendation: if source/target stats are weak, fall back to existing match or identity in weak bands.

---

## Suggested first implementation milestone

### Milestone: Color DNA v0

Purpose:

Create a source/target relationship profile that can be inspected and used for a simple Smash preview.

Deliverables:

1. `relationshipStats.ts`
   - Extract Lab/LCh/luma/saturation/chroma/hue/neutral/accent stats.

2. `relationshipBands.ts`
   - Build 3 adaptive value bands for source and target.

3. `relationshipProfile.ts`
   - Pair source/target bands and compute transfer deltas.

4. `relationshipTransform.ts`
   - Apply a simple blended transform:
     - value percentile mapping,
     - hue shift by value band,
     - saturation/chroma compression by value band,
     - neutral protection.

5. UI prototype
   - New “Smash” accordion or tab.
   - Trait sliders:
     - Value,
     - Hue,
     - Saturation,
     - Chroma,
     - Neutral Protect,
     - Accent.
   - 3-band Source DNA strip.

6. Output
   - Preview only at first.
   - Then generate 33^3 LUT.

Acceptance criteria:

- User can see source band traits.
- User can move Value/Hue/Saturation sliders and get meaningfully different results.
- Neutral protection reduces unwanted gray/skin contamination.
- Weak/empty bands do not explode.
- Output can be baked to existing LUT path after validation.

---

## Strategic conclusion

The strongest path is not simply to add more LUT controls. It is to make Color Smash a system for extracting and remixing color relationships.

The clearest product promise is:

> Color Smash extracts the Color DNA of a source and lets you smash that DNA into a target with controllable value, hue, saturation, chroma, accent, and range relationships.

The most defensible technical idea is:

> Build source/target relationship profiles, correlate them by bands and perceptual dimensions, and synthesize a target-aware transform that can still bake into ordinary Photoshop-friendly outputs.

The first implementation should be conservative:

1. 3 adaptive value bands.
2. Source/target relationship stats.
3. Trait sliders.
4. Per-band compression.
5. Neutral/accent handling.
6. LUT output.

From there, evolve into Range Fields, Look Recipe, and Zone Smash.

This keeps Color Smash distinct from ChromaWarp, 3D LUT Creator, Color.io, and fylm.ai while building directly on the plugin’s existing strengths: Photoshop-native color matching, source/target palettes, weighted ratios, histogram analysis, multi-curve output, and now working LUT generation.
