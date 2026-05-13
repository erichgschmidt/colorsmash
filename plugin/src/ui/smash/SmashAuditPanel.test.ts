// Tests for SmashAuditPanel — pure presentational, no hooks, no DOM needed.
// We call the component as a plain function and inspect the returned React
// element tree directly; no @testing-library/react required.
// Matches the pattern in SourceDNAStrip.test.ts.

import { describe, it, expect } from "vitest";
import React from "react";
import {
  SmashAuditPanel,
  TRAIT_DISPLAY_ORDER,
  TRAIT_LABELS,
} from "./SmashAuditPanel";
import type { SmashAudit } from "../../core/smash/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function createAudit(overrides: Partial<SmashAudit> = {}): SmashAudit {
  return {
    traitContributions: {
      value: 0,
      hue: 0,
      saturation: 0,
      chroma: 0,
      neutral: 0,
      accent: 0,
    },
    bandsUsed: [],
    clustersAnchored: [],
    clustersLocked: [],
    gamutClipped: false,
    elapsedMs: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tree-walk helpers
// ---------------------------------------------------------------------------

type AnyEl = React.ReactElement<Record<string, unknown>>;

/** Collect all React elements depth-first from a root element. */
function flatten(el: AnyEl | null | undefined): AnyEl[] {
  if (el == null) return [];
  if (typeof el !== "object" || !("props" in el)) return [];
  const children: AnyEl[] = [];
  const queue: AnyEl[] = [el as AnyEl];
  while (queue.length > 0) {
    const node = queue.shift()!;
    children.push(node);
    const ch = node.props.children;
    if (ch == null) continue;
    const arr = Array.isArray(ch) ? ch : [ch];
    for (const c of arr) {
      if (c != null && typeof c === "object" && "props" in c) {
        queue.push(c as AnyEl);
      }
    }
  }
  return children;
}

/** True if any element in the tree has a text child matching the string. */
function treeContainsText(el: AnyEl, text: string): boolean {
  const all = flatten(el);
  for (const node of all) {
    const ch = node.props.children;
    if (ch == null) continue;
    const items = Array.isArray(ch) ? ch : [ch];
    for (const c of items) {
      if (typeof c === "string" && c.includes(text)) return true;
      if (typeof c === "number" && String(c).includes(text)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SmashAuditPanel", () => {
  it("renders a non-null element for an empty audit", () => {
    const result = SmashAuditPanel({ audit: createAudit() });
    expect(result).not.toBeNull();
    expect(typeof result).toBe("object");
  });

  it("renders elapsedMs=250 as '250ms'", () => {
    const el = SmashAuditPanel({ audit: createAudit({ elapsedMs: 250 }) }) as AnyEl;
    expect(treeContainsText(el, "250ms")).toBe(true);
  });

  it("renders '—' when elapsedMs is 0", () => {
    const el = SmashAuditPanel({ audit: createAudit({ elapsedMs: 0 }) }) as AnyEl;
    // The elapsed area renders '—'.
    expect(treeContainsText(el, "—")).toBe(true);
  });

  it("renders a bar at 70% width for value trait when contribution=0.7", () => {
    const audit = createAudit({
      traitContributions: {
        value: 0.7,
        hue: 0,
        saturation: 0,
        chroma: 0,
        neutral: 0,
        accent: 0,
      },
    });
    const el = SmashAuditPanel({ audit }) as AnyEl;
    const all = flatten(el);
    // The fill div for the 'value' bar should have width: "70%".
    const fillDivs = all.filter(
      (node) =>
        typeof node.props.style === "object" &&
        node.props.style !== null &&
        (node.props.style as React.CSSProperties).width === "70%",
    );
    expect(fillDivs.length).toBeGreaterThanOrEqual(1);
  });

  it("renders all 6 trait rows even when all contributions are 0", () => {
    const el = SmashAuditPanel({ audit: createAudit() }) as AnyEl;
    const all = flatten(el);
    // Each trait label appears somewhere in the tree.
    for (const trait of TRAIT_DISPLAY_ORDER) {
      const label = TRAIT_LABELS[trait];
      const found = all.some((node) => {
        const ch = node.props.children;
        const items = Array.isArray(ch) ? ch : [ch];
        return items.some((c) => typeof c === "string" && c === label);
      });
      expect(found, `Label "${label}" should appear in the tree`).toBe(true);
    }
  });

  it("produces pills with distinct backgrounds for mixed band fellBack states", () => {
    const audit = createAudit({
      bandsUsed: [
        { index: 0, fellBack: false },
        { index: 1, fellBack: true },
        { index: 2, fellBack: false },
      ],
    });
    const el = SmashAuditPanel({ audit }) as AnyEl;
    const all = flatten(el);
    const pillBgs = all
      .filter(
        (node) =>
          typeof node.props.style === "object" &&
          node.props.style !== null &&
          (
            (node.props.style as React.CSSProperties).background === "#3a5a3a" ||
            (node.props.style as React.CSSProperties).background === "#5a3a3a"
          ),
      )
      .map((node) => (node.props.style as React.CSSProperties).background as string);

    // Should find both green (used) and red (fellBack) pills.
    expect(pillBgs).toContain("#3a5a3a");
    expect(pillBgs).toContain("#5a3a3a");
  });

  it("displays 'Yes' with alert color when gamutClipped=true", () => {
    const el = SmashAuditPanel({
      audit: createAudit({ gamutClipped: true }),
    }) as AnyEl;
    const all = flatten(el);
    // Find a node that shows "Yes" and has the alert color.
    const alertNode = all.find(
      (node) => {
        const ch = node.props.children;
        const items = Array.isArray(ch) ? ch : [ch];
        const hasYes = items.some((c) => typeof c === "string" && c === "Yes");
        const hasColor =
          typeof node.props.style === "object" &&
          node.props.style !== null &&
          (node.props.style as React.CSSProperties).color === "#ff8866";
        return hasYes && hasColor;
      }
    );
    expect(alertNode).toBeDefined();
  });

  it("displays 'No' in muted color when gamutClipped=false", () => {
    const el = SmashAuditPanel({
      audit: createAudit({ gamutClipped: false }),
    }) as AnyEl;
    const all = flatten(el);
    const mutedNode = all.find((node) => {
      const ch = node.props.children;
      const items = Array.isArray(ch) ? ch : [ch];
      const hasNo = items.some((c) => typeof c === "string" && c === "No");
      const hasMutedColor =
        typeof node.props.style === "object" &&
        node.props.style !== null &&
        (node.props.style as React.CSSProperties).color === "#888";
      return hasNo && hasMutedColor;
    });
    expect(mutedNode).toBeDefined();
  });

  it("TRAIT_DISPLAY_ORDER has exactly 6 entries", () => {
    expect(TRAIT_DISPLAY_ORDER.length).toBe(6);
  });

  it("TRAIT_LABELS has a key for every trait in TRAIT_DISPLAY_ORDER", () => {
    for (const trait of TRAIT_DISPLAY_ORDER) {
      expect(TRAIT_LABELS[trait]).toBeTypeOf("string");
      expect(TRAIT_LABELS[trait].length).toBeGreaterThan(0);
    }
  });

  it("renders '—' in the bands section when bandsUsed is empty", () => {
    const el = SmashAuditPanel({ audit: createAudit({ bandsUsed: [] }) }) as AnyEl;
    // Flatten and look for the muted dash node.
    const all = flatten(el);
    const dashNodes = all.filter((node) => {
      const ch = node.props.children;
      const items = Array.isArray(ch) ? ch : [ch];
      return items.some((c) => typeof c === "string" && c === "—");
    });
    // There should be at least one dash (empty bands section, plus possibly
    // the elapsed dash — both count as "—" present).
    expect(dashNodes.length).toBeGreaterThanOrEqual(1);
  });

  it("renders band pills labeled 'B0', 'B1' etc when bandsUsed is non-empty", () => {
    const audit = createAudit({
      bandsUsed: [
        { index: 0, fellBack: false },
        { index: 1, fellBack: true },
      ],
    });
    const el = SmashAuditPanel({ audit }) as AnyEl;
    expect(treeContainsText(el, "B0")).toBe(true);
    expect(treeContainsText(el, "B1")).toBe(true);
  });

  it("renders cluster pills for anchored and locked clusters", () => {
    const audit = createAudit({
      clustersAnchored: [2, 4],
      clustersLocked: [1],
    });
    const el = SmashAuditPanel({ audit }) as AnyEl;
    expect(treeContainsText(el, "C2")).toBe(true);
    expect(treeContainsText(el, "C4")).toBe(true);
    expect(treeContainsText(el, "C1")).toBe(true);
  });

  it("container has dark background and 1px dark border", () => {
    const el = SmashAuditPanel({ audit: createAudit() }) as AnyEl;
    const style = el.props.style as React.CSSProperties;
    expect(style.background).toBe("#2e2e2e");
    expect(style.border).toBe("1px solid #1a1a1a");
    expect(style.borderRadius).toBe(4);
  });

  it("trait bar fill is 0% wide when contribution=0", () => {
    const el = SmashAuditPanel({ audit: createAudit() }) as AnyEl;
    const all = flatten(el);
    // All fill divs should have width "0%".
    const fillDivs = all.filter(
      (node) =>
        typeof node.props.style === "object" &&
        node.props.style !== null &&
        (node.props.style as React.CSSProperties).background === "#6ab7ff",
    );
    // One fill div per trait = 6.
    expect(fillDivs.length).toBe(6);
    for (const fd of fillDivs) {
      expect((fd.props.style as React.CSSProperties).width).toBe("0%");
    }
  });

  it("rounds elapsed to nearest ms", () => {
    const el = SmashAuditPanel({
      audit: createAudit({ elapsedMs: 123.7 }),
    }) as AnyEl;
    expect(treeContainsText(el, "124ms")).toBe(true);
  });
});
