// Tests for TraitSliders — called as a plain function so vitest does not
// need JSX. Inspects the returned React element tree directly.
// Same pattern as SmashControlsBar.test.ts.

import { describe, it, expect, vi } from "vitest";
import {
  TraitSliders,
  TraitSlidersProps,
  TRAIT_ORDER,
  TRAIT_LABELS,
  TRAIT_TIPS,
  DEFAULT_TRAIT_AMOUNTS,
} from "./TraitSliders";
import type { TraitAmounts } from "../../core/smash/types";

// ─── helpers ─────────────────────────────────────────────────────────────────

function noop() { /* intentional no-op */ }

function makeAmounts(overrides: Partial<TraitAmounts> = {}): TraitAmounts {
  return { ...DEFAULT_TRAIT_AMOUNTS, ...overrides };
}

function makeProps(overrides: Partial<TraitSlidersProps> = {}): TraitSlidersProps {
  return {
    amounts: DEFAULT_TRAIT_AMOUNTS,
    onAmountsChange: noop,
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

/** Find all elements matching a predicate. */
function findAllElements(
  root: unknown,
  predicate: (type: unknown, props: Record<string, unknown>) => boolean,
): Record<string, unknown>[] {
  const all = collectElements(root);
  const result: Record<string, unknown>[] = [];
  for (const el of all) {
    const e = el as Record<string, unknown>;
    if (e["type"] !== undefined && e["props"] !== undefined) {
      if (predicate(e["type"], e["props"] as Record<string, unknown>)) {
        result.push(e);
      }
    }
  }
  return result;
}

/** Find the first element matching a predicate. */
function findElement(
  root: unknown,
  predicate: (type: unknown, props: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  return findAllElements(root, predicate)[0];
}

/** Collect all text content from span children in the tree. */
function collectTextContent(root: unknown): string[] {
  const spans = findAllElements(root, (t) => t === "span");
  const texts: string[] = [];
  for (const span of spans) {
    const p = span["props"] as Record<string, unknown>;
    if (typeof p["children"] === "string" || typeof p["children"] === "number") {
      texts.push(String(p["children"]));
    }
  }
  return texts;
}

// ─── TraitSliders render tests ────────────────────────────────────────────────

describe("TraitSliders", () => {
  it("renders a non-null element", () => {
    const el = TraitSliders(makeProps());
    expect(el).not.toBeNull();
    expect(el).not.toBeUndefined();
  });

  it("all 6 traits in TRAIT_ORDER are rendered as label spans", () => {
    const el = TraitSliders(makeProps());
    for (const trait of TRAIT_ORDER) {
      const label = TRAIT_LABELS[trait];
      const span = findElement(el, (_t, p) => {
        const child = p["children"];
        return typeof child === "string" && child === label;
      });
      expect(span, `missing label for trait '${trait}'`).toBeDefined();
    }
  });

  it("renders exactly 6 range sliders", () => {
    const el = TraitSliders(makeProps());
    const sliders = findAllElements(el, (t, p) => t === "input" && p["type"] === "range");
    expect(sliders).toHaveLength(6);
  });

  it("TRAIT_LABELS has a key for every trait in TRAIT_ORDER", () => {
    for (const trait of TRAIT_ORDER) {
      expect(TRAIT_LABELS[trait], `TRAIT_LABELS missing '${trait}'`).toBeDefined();
      expect(typeof TRAIT_LABELS[trait]).toBe("string");
    }
  });

  it("TRAIT_TIPS has a key for every trait in TRAIT_ORDER", () => {
    for (const trait of TRAIT_ORDER) {
      expect(TRAIT_TIPS[trait], `TRAIT_TIPS missing '${trait}'`).toBeDefined();
      expect(typeof TRAIT_TIPS[trait]).toBe("string");
    }
  });

  it("DEFAULT_TRAIT_AMOUNTS has value=1", () => {
    expect(DEFAULT_TRAIT_AMOUNTS.value).toBe(1);
  });

  it("DEFAULT_TRAIT_AMOUNTS has hue=1", () => {
    expect(DEFAULT_TRAIT_AMOUNTS.hue).toBe(1);
  });

  it("DEFAULT_TRAIT_AMOUNTS has saturation=1", () => {
    expect(DEFAULT_TRAIT_AMOUNTS.saturation).toBe(1);
  });

  it("DEFAULT_TRAIT_AMOUNTS has chroma=1", () => {
    expect(DEFAULT_TRAIT_AMOUNTS.chroma).toBe(1);
  });

  it("DEFAULT_TRAIT_AMOUNTS has neutral=0.5", () => {
    expect(DEFAULT_TRAIT_AMOUNTS.neutral).toBe(0.5);
  });

  it("DEFAULT_TRAIT_AMOUNTS has accent=0", () => {
    expect(DEFAULT_TRAIT_AMOUNTS.accent).toBe(0);
  });

  it("for amounts with value=0.7, the Value row displays '70' as its numeric readout", () => {
    const el = TraitSliders(makeProps({ amounts: makeAmounts({ value: 0.7 }) }));
    const texts = collectTextContent(el);
    expect(texts).toContain("70");
  });

  it("for amounts with value=0.7, the Value slider has integer value 70", () => {
    const el = TraitSliders(makeProps({ amounts: makeAmounts({ value: 0.7 }) }));
    const sliders = findAllElements(el, (t, p) => t === "input" && p["type"] === "range");
    // TRAIT_ORDER puts value first, so sliders[0] is the Value slider.
    const valueSlider = sliders[0];
    expect(valueSlider).toBeDefined();
    const sliderValue = (valueSlider!["props"] as Record<string, unknown>)["value"];
    expect(sliderValue).toBe(70);
  });

  it("slider input values are integers in 0-100 (no fractional)", () => {
    const amounts: TraitAmounts = {
      value: 0.333,
      hue: 0.667,
      saturation: 0.5,
      chroma: 0.1,
      neutral: 0.75,
      accent: 0.9,
    };
    const el = TraitSliders(makeProps({ amounts }));
    const sliders = findAllElements(el, (t, p) => t === "input" && p["type"] === "range");
    for (const slider of sliders) {
      const v = (slider["props"] as Record<string, unknown>)["value"];
      expect(typeof v).toBe("number");
      expect(Number.isInteger(v), `slider value ${v} is not an integer`).toBe(true);
      expect(v as number).toBeGreaterThanOrEqual(0);
      expect(v as number).toBeLessThanOrEqual(100);
    }
  });

  it("when disabled, container has opacity 0.5", () => {
    const el = TraitSliders(makeProps({ disabled: true }));
    const container = el as unknown as Record<string, unknown>;
    const style = (container["props"] as Record<string, unknown>)["style"] as Record<string, unknown>;
    expect(style["opacity"]).toBe(0.5);
  });

  it("when disabled, slider onChange does not call onAmountsChange", () => {
    const onAmountsChange = vi.fn();
    const el = TraitSliders(makeProps({ disabled: true, onAmountsChange }));
    const sliders = findAllElements(el, (t, p) => t === "input" && p["type"] === "range");
    expect(sliders.length).toBeGreaterThan(0);

    // Invoke the onChange handler on the first slider with a synthetic event.
    const firstSlider = sliders[0];
    const onChange = (firstSlider["props"] as Record<string, unknown>)["onChange"] as
      | ((e: { target: { value: string } }) => void)
      | undefined;
    expect(onChange).toBeDefined();
    onChange!({ target: { value: "50" } });
    expect(onAmountsChange).not.toHaveBeenCalled();
  });

  it("when not disabled, slider onChange calls onAmountsChange", () => {
    const onAmountsChange = vi.fn();
    const el = TraitSliders(makeProps({ disabled: false, onAmountsChange }));
    const sliders = findAllElements(el, (t, p) => t === "input" && p["type"] === "range");
    expect(sliders.length).toBeGreaterThan(0);

    const firstSlider = sliders[0];
    const onChange = (firstSlider["props"] as Record<string, unknown>)["onChange"] as
      | ((e: { target: { value: string } }) => void)
      | undefined;
    expect(onChange).toBeDefined();
    onChange!({ target: { value: "50" } });
    expect(onAmountsChange).toHaveBeenCalledTimes(1);
  });

  it("TRAIT_ORDER has exactly 6 items", () => {
    expect(TRAIT_ORDER).toHaveLength(6);
  });

  it("TRAIT_ORDER contains exactly the expected trait keys", () => {
    const sorted = [...TRAIT_ORDER].sort();
    expect(sorted).toEqual(["accent", "chroma", "hue", "neutral", "saturation", "value"]);
  });

  it("each row div has a title equal to TRAIT_TIPS for that trait", () => {
    const el = TraitSliders(makeProps());
    for (const trait of TRAIT_ORDER) {
      const tip = TRAIT_TIPS[trait];
      const row = findElement(el, (_t, p) => p["title"] === tip);
      expect(row, `missing title for trait '${trait}'`).toBeDefined();
    }
  });
});
