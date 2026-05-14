// Tests for ColorizationToggles — called as a plain function so vitest does
// not need JSX. Inspects the returned React element tree directly.
// Same pattern as TraitSliders.test.ts.

import { describe, it, expect, vi } from "vitest";
import {
  ColorizationToggles,
  ColorizationTogglesProps,
  ColorizationToggleState,
  DEFAULT_COLORIZATION_TOGGLES,
} from "./ColorizationToggles";

// ─── helpers ─────────────────────────────────────────────────────────────────

function noop() { /* intentional no-op */ }

function makeState(overrides: Partial<ColorizationToggleState> = {}): ColorizationToggleState {
  return { ...DEFAULT_COLORIZATION_TOGGLES, ...overrides };
}

function makeProps(overrides: Partial<ColorizationTogglesProps> = {}): ColorizationTogglesProps {
  return {
    state: DEFAULT_COLORIZATION_TOGGLES,
    onChange: noop,
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

// ─── ColorizationToggles tests ───────────────────────────────────────────────

describe("ColorizationToggles", () => {
  it("renders a non-null element", () => {
    const el = ColorizationToggles(makeProps());
    expect(el).not.toBeNull();
    expect(el).not.toBeUndefined();
  });

  it("DEFAULT_COLORIZATION_TOGGLES.hueByLuma is true", () => {
    expect(DEFAULT_COLORIZATION_TOGGLES.hueByLuma).toBe(true);
  });

  it("with hueByLuma true, checkbox background is accent blue", () => {
    const el = ColorizationToggles(makeProps({ state: makeState({ hueByLuma: true }) }));
    // Find the 16x16 checkbox div
    const checkboxes = findAllElements(el, (t, p) => {
      const s = p["style"] as Record<string, unknown> | undefined;
      return t === "div" && s !== undefined && s["width"] === 16 && s["height"] === 16;
    });
    expect(checkboxes.length).toBeGreaterThan(0);
    const style = checkboxes[0]!["props"] as Record<string, unknown>;
    const s = style["style"] as Record<string, unknown>;
    expect(s["background"]).toBe("#6ab7ff");
  });

  it("with hueByLuma false, checkbox background differs from the ON state", () => {
    const elOn = ColorizationToggles(makeProps({ state: makeState({ hueByLuma: true }) }));
    const elOff = ColorizationToggles(makeProps({ state: makeState({ hueByLuma: false }) }));

    const getCheckboxBg = (el: unknown): unknown => {
      const checkboxes = findAllElements(el, (t, p) => {
        const s = p["style"] as Record<string, unknown> | undefined;
        return t === "div" && s !== undefined && s["width"] === 16 && s["height"] === 16;
      });
      expect(checkboxes.length).toBeGreaterThan(0);
      const style = checkboxes[0]!["props"] as Record<string, unknown>;
      return (style["style"] as Record<string, unknown>)["background"];
    };

    expect(getCheckboxBg(elOn)).not.toBe(getCheckboxBg(elOff));
  });

  it("with hueByLuma false, label color differs from ON state", () => {
    const elOn = ColorizationToggles(makeProps({ state: makeState({ hueByLuma: true }) }));
    const elOff = ColorizationToggles(makeProps({ state: makeState({ hueByLuma: false }) }));

    const getLabelColor = (el: unknown): unknown => {
      const span = findElement(el, (t, p) => {
        const s = p["style"] as Record<string, unknown> | undefined;
        return t === "span" && s !== undefined && "fontWeight" in s;
      });
      expect(span).toBeDefined();
      return ((span!["props"] as Record<string, unknown>)["style"] as Record<string, unknown>)["color"];
    };

    expect(getLabelColor(elOn)).not.toBe(getLabelColor(elOff));
  });

  it("clicking the row fires onChange with hueByLuma flipped from true to false", () => {
    const onChange = vi.fn();
    const el = ColorizationToggles(makeProps({ state: makeState({ hueByLuma: true }), onChange }));
    // Find the toggle row div (has an onClick and title)
    const rows = findAllElements(el, (_t, p) => {
      return typeof p["onClick"] === "function" && typeof p["title"] === "string";
    });
    expect(rows.length).toBeGreaterThan(0);
    const onClick = rows[0]!["props"] as Record<string, unknown>;
    (onClick["onClick"] as () => void)();
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]![0] as ColorizationToggleState;
    expect(next.hueByLuma).toBe(false);
  });

  it("clicking the row fires onChange with hueByLuma flipped from false to true", () => {
    const onChange = vi.fn();
    const el = ColorizationToggles(makeProps({ state: makeState({ hueByLuma: false }), onChange }));
    const rows = findAllElements(el, (_t, p) => {
      return typeof p["onClick"] === "function" && typeof p["title"] === "string";
    });
    expect(rows.length).toBeGreaterThan(0);
    const onClick = rows[0]!["props"] as Record<string, unknown>;
    (onClick["onClick"] as () => void)();
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]![0] as ColorizationToggleState;
    expect(next.hueByLuma).toBe(true);
  });

  it("when disabled, clicking the row does NOT fire onChange", () => {
    const onChange = vi.fn();
    const el = ColorizationToggles(makeProps({ disabled: true, onChange }));
    const rows = findAllElements(el, (_t, p) => {
      return typeof p["onClick"] === "function" && typeof p["title"] === "string";
    });
    expect(rows.length).toBeGreaterThan(0);
    const onClick = rows[0]!["props"] as Record<string, unknown>;
    (onClick["onClick"] as () => void)();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("when disabled, container has opacity 0.5", () => {
    const el = ColorizationToggles(makeProps({ disabled: true }));
    const container = el as unknown as Record<string, unknown>;
    const style = (container["props"] as Record<string, unknown>)["style"] as Record<string, unknown>;
    expect(style["opacity"]).toBe(0.5);
  });

  it("when not disabled, container has opacity 1", () => {
    const el = ColorizationToggles(makeProps({ disabled: false }));
    const container = el as unknown as Record<string, unknown>;
    const style = (container["props"] as Record<string, unknown>)["style"] as Record<string, unknown>;
    expect(style["opacity"]).toBe(1);
  });

  it("hover tooltip (title attribute) exists and contains the word 'grayscale'", () => {
    const el = ColorizationToggles(makeProps());
    const withTitle = findElement(el, (_t, p) => {
      return typeof p["title"] === "string" &&
        (p["title"] as string).toLowerCase().includes("grayscale");
    });
    expect(withTitle).toBeDefined();
  });

  it("the label 'Hue-by-L' is present in the rendered tree", () => {
    const el = ColorizationToggles(makeProps());
    const span = findElement(el, (t, p) => {
      return t === "span" && p["children"] === "Hue-by-L";
    });
    expect(span).toBeDefined();
  });
});
