# Reinhard Accuracy Plan — Draft vs Robust Modes

**Status:** Forward-looking. Current shipping mode = "Draft." Robust mode = future work.
**Last updated:** 2026-04-19

## Problem
The editable adjustment-layer stack approximates Reinhard but cannot match it exactly. PS adjustment layers operate in RGB-space; Reinhard operates per-channel-affine in Lab-space. The function spaces don't compose to identical outputs. Current draft mode hits ~4-5 ΔE residual on typical photos.

## Two modes

### Draft mode (current, shipping)
- Heuristic-derived initial params from Lab stats
- Numerical fitter with strong regularization (only nudges)
- Empirical CB simulator from in-PS calibration at slider=±50, 5 L-bins
- Fast: ~1-2s per apply
- Acceptable for casual use, prototyping, "vibe matching"
- Visible ΔE: ~3-5 from baked exact

### Robust mode (future)
- All draft features +
- Validate-against-PS fitter (renders proposed params in PS each iteration)
- Wider/denser empirical calibration of every adjustment layer
- More layer types in the stack (Channel Mixer, Selective Color fully wired, Vibrance, Photo Filter)
- Slower: 10-30s per apply
- Visible ΔE target: <1.5 (perceptually indistinguishable for most viewers)

## Robust mode implementation roadmap

### Phase A — Calibration completeness
Goal: every adjustment layer's simulator matches PS within 1 ΔE.

- [ ] **CB at multiple slider values** — currently calibrated at +50 only. Need ±25, ±50, ±75, ±100 to capture nonlinearity at extremes. ~30 min runtime, one tool extension.
- [ ] **CB at more L points** — currently 5 bins (0/64/128/192/255). Bump to 9 bins for finer interpolation.
- [ ] **CB negative direction** — confirm linearity by sign (PS may saturate differently at extremes).
- [ ] **HueSat per-color-family calibration** — currently master saturation only. Calibrate reds/yellows/greens/cyans/blues/magentas individually.
- [ ] **Curves at non-3-point shapes** — verify piecewise-linear interp matches PS's spline interpolation closely; if not, fit a cubic Hermite model.
- [ ] **Selective Color** — currently unwired in simulator. Calibrate all 9 families × 4 CMYK channels.
- [ ] **Channel Mixer descriptor fix** — debug PS rejection of our matrix descriptor (Listener capture needed). Once working, add to stack.
- [ ] **Vibrance + Photo Filter** — additional adjustment types to expand the stack's reach.

### Phase B — Validate-against-PS fitter
Goal: stop trusting the simulator; trust PS.

- [ ] **PS round-trip cost function** — for each candidate param set, render in PS, read result pixels, compute ΔE vs exact-Reinhard ground truth. Replace simulator-based cost.
- [ ] **Smart sampling of candidates** — coordinate descent with PS round-trips is expensive. Use Bayesian optimization or genetic algorithm to converge in fewer iterations.
- [ ] **Cache + delta updates** — when a single param changes, only re-render through that layer onward (PS may not allow this; investigate).
- [ ] **Acceptance check** — always compare fitted params' real ΔE to heuristic ΔE; revert to heuristic if fit didn't help.

### Phase C — More expressive stack
Goal: more degrees of freedom for the fitter to use.

- [ ] **Per-zone Curves** (S/M/H) gated by Blend If in addition to master.
- [ ] **Multiple stacked Curves** with different blend modes (Multiply, Screen) for nonlinear interactions.
- [ ] **Channel Mixer** (after descriptor fix) for true cross-channel mixing.
- [ ] **Black & White layer** at low opacity for desaturation control without affecting hue.

### Phase D — Hybrid validation
Goal: smart fall-back so user always gets the best available result.

- [ ] **Auto-select Draft vs Robust** based on user setting (Quality slider: Fast/Balanced/Best).
- [ ] **Best mode comparison report** — show user actual ΔE achieved + time taken; let them pick which to keep.
- [ ] **Telemetry** (opt-in) — gather real-world ΔE distribution to identify failure cases for further calibration.

## Speculative additions

### WASM Reinhard core
- Compile pure-TS Reinhard to WASM (Rust or AssemblyScript)
- Run **live preview** as user drags sliders (target res ~256px, ~30ms render)
- Eliminates "apply-on-click" UX, makes plugin feel native

### ML-based fitter
- Train small MLP: input = (target pixel RGB, src/tgt Lab stats, slider weights) → output = (predicted PS-stack RGB)
- Use as a fast surrogate for the PS round-trip in fitter inner loop
- Periodically validate against PS to detect drift
- Probably overkill but interesting

### Smart Object exact mode
- Bake exact Reinhard pixels into a Smart Object
- Embed source/target IDs + slider state as XMP metadata
- Plugin detects metadata on selection → repopulates panel with last params → user tweaks → re-bakes
- Always pixel-exact AND editable (via plugin, not via PS native controls)
- Could be a third output mode alongside Draft and Robust

## Decision criteria for promotion to Robust
A future build promotes Robust mode from "future" to "shipping" when:
- Mean ΔE < 1.5 on a 50-image golden test set
- Apply time < 15s on a 12MP image
- No regressions vs Draft on any test image (i.e., Robust is never worse)

## Where this fits in the roadmap
- **Now:** Draft mode is shipped, Zone Editor (separate feature) takes priority for product differentiation.
- **Phase 4 (per current roadmap):** Sliced OT + perceptual validation — *also* benefits from this calibration infrastructure (the PS-validation fitter generalizes to OT-derived transforms).
- **Phase 5 / post-launch:** Robust mode as a "Best" quality tier for the v1 marketplace release.
