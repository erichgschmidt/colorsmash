// Tests for SmashControlsBar — called as a plain function so vitest does not
// need JSX. Inspects the returned React element tree directly.

import { describe, it, expect } from "vitest";
import {
  SmashControlsBar,
  SmashControlsBarProps,
  SMASH_PRESET_AMOUNTS,
  detectPreset,
  SmashPreset,
} from "./SmashControlsBar";

// ─── helpers ─────────────────────────────────────────────────────────────────

function noop() { /* intentional no-op */ }

function makeProps(overrides: Partial<SmashControlsBarProps> = {}): SmashControlsBarProps {
  return {
    amount: 0,
    onAmountChange: noop,
    onPresetChange: noop,
    ...overrides,
  };
}

/** Walk a React element tree depth-first, collecting all elements. */
function collectElements(node: unknown): unknown[] {
  if (node === null || node === undefined) return [];
  if (typeof node !== "object") return [];
  const el = node as Record<string, unknown>;
  const results: unknown[] = [node];
  const ch = el["props"] as Record<string, unknown> | undefined;
  if (!ch) return results;
  const children = ch["children"];
  if (Array.isArray(children)) {
    for (const c of children) {
      results.push(...collectElements(c));
    }
  } else if (children !== null && children !== undefined) {
    results.push(...collectElements(children));
  }
  return results;
}

/** Find the first element whose props satisfy a predicate. */
function findElement(
  root: unknown,
  predicate: (type: unknown, props: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  const all = collectElements(root);
  for (const el of all) {
    const e = el as Record<string, unknown>;
    if (e["type"] !== undefined && e["props"] !== undefined) {
      if (predicate(e["type"], e["props"] as Record<string, unknown>)) {
        return e;
      }
    }
  }
  return undefined;
}

// ─── SmashControlsBar render tests ───────────────────────────────────────────

describe("SmashControlsBar", () => {
  it("renders a valid element (not null) for amount=0", () => {
    const el = SmashControlsBar(makeProps({ amount: 0 }));
    expect(el).not.toBeNull();
    expect(el).not.toBeUndefined();
  });

  it("slider value matches Math.round(amount * 100) for amount=0", () => {
    const el = SmashControlsBar(makeProps({ amount: 0 }));
    const slider = findElement(el, (t, p) => t === "input" && p["type"] === "range");
    expect(slider).toBeDefined();
    expect((slider!["props"] as Record<string, unknown>)["value"]).toBe(0);
  });

  it("slider value matches Math.round(amount * 100) for amount=0.3", () => {
    const el = SmashControlsBar(makeProps({ amount: 0.3 }));
    const slider = findElement(el, (t, p) => t === "input" && p["type"] === "range");
    expect((slider!["props"] as Record<string, unknown>)["value"]).toBe(30);
  });

  it("slider value matches Math.round(amount * 100) for amount=0.5", () => {
    const el = SmashControlsBar(makeProps({ amount: 0.5 }));
    const slider = findElement(el, (t, p) => t === "input" && p["type"] === "range");
    expect((slider!["props"] as Record<string, unknown>)["value"]).toBe(50);
  });

  it("slider value matches Math.round(amount * 100) for amount=0.85", () => {
    const el = SmashControlsBar(makeProps({ amount: 0.85 }));
    const slider = findElement(el, (t, p) => t === "input" && p["type"] === "range");
    expect((slider!["props"] as Record<string, unknown>)["value"]).toBe(85);
  });

  it("slider value matches Math.round(amount * 100) for amount=1.0", () => {
    const el = SmashControlsBar(makeProps({ amount: 1.0 }));
    const slider = findElement(el, (t, p) => t === "input" && p["type"] === "range");
    expect((slider!["props"] as Record<string, unknown>)["value"]).toBe(100);
  });

  it("all four preset buttons are present", () => {
    const el = SmashControlsBar(makeProps({ amount: 0.6 }));
    const presetLabels = ["Subtle", "Balanced", "Strong", "Smash"];
    for (const label of presetLabels) {
      const btn = findElement(el, (_t, p) => p["children"] === label);
      expect(btn).toBeDefined();
    }
  });

  it("active preset=balanced gives balanced button the accent blue background", () => {
    const el = SmashControlsBar(makeProps({ amount: 0.6, preset: "balanced" as SmashPreset }));
    const balancedBtn = findElement(el, (_t, p) => p["children"] === "Balanced");
    expect(balancedBtn).toBeDefined();
    const style = (balancedBtn!["props"] as Record<string, unknown>)["style"] as Record<string, unknown>;
    expect(style["background"]).toBe("#6ab7ff");
  });

  it("active preset=balanced does not give other buttons the accent background", () => {
    const el = SmashControlsBar(makeProps({ amount: 0.6, preset: "balanced" as SmashPreset }));
    const otherLabels = ["Subtle", "Strong", "Smash"];
    for (const label of otherLabels) {
      const btn = findElement(el, (_t, p) => p["children"] === label);
      expect(btn).toBeDefined();
      const style = (btn!["props"] as Record<string, unknown>)["style"] as Record<string, unknown>;
      expect(style["background"]).not.toBe("#6ab7ff");
    }
  });

  it("when preset=undefined none of the buttons have the accent background", () => {
    const el = SmashControlsBar(makeProps({ amount: 0.5, preset: undefined }));
    const presetLabels = ["Subtle", "Balanced", "Strong", "Smash"];
    for (const label of presetLabels) {
      const btn = findElement(el, (_t, p) => p["children"] === label);
      expect(btn).toBeDefined();
      const style = (btn!["props"] as Record<string, unknown>)["style"] as Record<string, unknown>;
      expect(style["background"]).not.toBe("#6ab7ff");
    }
  });
});

// ─── detectPreset tests ───────────────────────────────────────────────────────

describe("detectPreset", () => {
  it("returns 'balanced' for 0.6", () => {
    expect(detectPreset(0.6)).toBe("balanced");
  });

  it("returns 'strong' for 0.85", () => {
    expect(detectPreset(0.85)).toBe("strong");
  });

  it("returns undefined for 0.50 (no preset matches)", () => {
    expect(detectPreset(0.50)).toBeUndefined();
  });

  it("returns 'subtle' for 0.302 (within tolerance)", () => {
    expect(detectPreset(0.302)).toBe("subtle");
  });

  it("returns 'subtle' for 0.295 (within tolerance)", () => {
    expect(detectPreset(0.295)).toBe("subtle");
  });

  it("returns undefined for 0.290 (outside tolerance)", () => {
    expect(detectPreset(0.290)).toBeUndefined();
  });
});

// ─── SMASH_PRESET_AMOUNTS tests ───────────────────────────────────────────────

describe("SMASH_PRESET_AMOUNTS", () => {
  it("has exactly 4 keys", () => {
    expect(Object.keys(SMASH_PRESET_AMOUNTS).length).toBe(4);
  });

  it("subtle is 0.30", () => {
    expect(SMASH_PRESET_AMOUNTS.subtle).toBe(0.30);
  });

  it("balanced is 0.60", () => {
    expect(SMASH_PRESET_AMOUNTS.balanced).toBe(0.60);
  });

  it("strong is 0.85", () => {
    expect(SMASH_PRESET_AMOUNTS.strong).toBe(0.85);
  });

  it("smash is 1.00", () => {
    expect(SMASH_PRESET_AMOUNTS.smash).toBe(1.00);
  });

  it("contains exactly the keys: subtle, balanced, strong, smash", () => {
    const keys = Object.keys(SMASH_PRESET_AMOUNTS).sort();
    expect(keys).toEqual(["balanced", "smash", "strong", "subtle"]);
  });
});
