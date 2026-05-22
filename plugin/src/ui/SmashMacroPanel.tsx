// SmashMacroPanel — the macro-GROUPS board for the Smash tab.
//
// Renders the TARGET image's macro groups as vertical BINS. The user drags
// colour chips (pools) between bins to reassign them, picks a per-group donor,
// renames groups, and overrides per-group detail (pool count). Amber chips look
// out of place (drag them out or click "!" to auto-rehome); dotted chips also
// fit a nearby group.
//
// UXP NOTE: HTML5 drag-and-drop is unreliable in UXP's Chromium, so dragging is
// done manually with pointer events + window listeners and a floating ghost.
// Bin hit-testing is done by comparing the cursor to each bin's bounding rect.
//
// Pure presentation: all persistent state lives upstream; this component only
// renders props, owns transient drag state, and calls back on user intent.

import * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MacroGroup, MacroInfo } from "../core/macro";

export interface PoolChip {
  r: number;
  g: number;
  b: number;
  weightPct: number;
}

export interface SmashMacroPanelProps {
  targetMacros: MacroGroup[]; // groups, weight-desc; { id, name, poolIds }
  targetMacroInfo: Map<number, MacroInfo>; // by target macro id
  sourceMacros: MacroGroup[]; // donor groups (for the donor picker)
  sourceMacroInfo: Map<number, MacroInfo>;
  macroMatch: Map<number, number>; // targetMacroId -> sourceMacroId
  macroCount: number;
  onReseed: (k: number) => void; // clamp 2..8 before calling
  onRenameMacro: (id: number, name: string) => void;
  onSetDonor: (targetMacroId: number, sourceMacroId: number) => void;
  onMovePool: (poolId: number, toMacroId: number) => void; // drag-reassign
  onAutoRehome: (poolId: number, fromMacroId: number) => void; // send to best-fit other group
  poolChip: (poolId: number) => PoolChip | undefined; // color+weight% of a pool
  contaminatedFor: (macroId: number) => number[]; // member pool ids that look out of place
  borderlinePools: Set<number>; // pools that ALSO sit near another group
  globalPoolCount: number;
  macroPoolCount: (macroId: number) => number | undefined; // per-group override; undefined = global
  onSetMacroPoolCount: (macroId: number, n: number | null) => void; // null = use global
  expandedMacroId: number | null; // which group's detail panel is open
  onToggleExpand: (id: number | null) => void;
  // Eyedropper add: the group awaiting a canvas click (its ⊙ is lit). Click a
  // group's ⊙ to arm it, then click the colour on the canvas to add it here.
  eyedropMacroId?: number | null;
  onEyedropMacro?: (id: number | null) => void;
}

const MIN_K = 2;
const MAX_K = 8;
const MIN_DETAIL = 1;
const MAX_DETAIL = 12;

// ────────── styles ──────────

const stepperStyle: React.CSSProperties = {
  padding: "1px 9px",
  fontSize: 12,
  borderRadius: 2,
  border: "1px solid #4a4a4a",
  background: "#3a3a3a",
  color: "#ddd",
  cursor: "pointer",
  userSelect: "none",
};

const miniStepStyle: React.CSSProperties = {
  padding: "0 7px",
  fontSize: 12,
  borderRadius: 2,
  border: "1px solid #4a4a4a",
  background: "#3a3a3a",
  color: "#ddd",
  cursor: "pointer",
  userSelect: "none",
};

const groupSwatch: React.CSSProperties = {
  width: 14,
  height: 14,
  flex: "0 0 auto",
  borderRadius: 3,
  border: "1px solid #000",
};

const nameInputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 10,
  background: "#161616",
  color: "#ccc",
  border: "1px solid #3a3a3a",
  borderRadius: 2,
  padding: "2px 5px",
  outline: "none",
};

const labelStyle: React.CSSProperties = { fontSize: 9, color: "#999" };

const contamBadge: React.CSSProperties = {
  fontSize: 9,
  color: "#1a1a1a",
  background: "#f5a623",
  borderRadius: "50%",
  width: 13,
  height: 13,
  flex: "0 0 auto",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const rgbCss = (c: { r: number; g: number; b: number } | undefined): string =>
  c ? `rgb(${c.r}, ${c.g}, ${c.b})` : "#2a2a2a";

// Stop an interaction from bubbling to the bin (toggle / drag start).
const stop = (e: React.SyntheticEvent) => e.stopPropagation();

interface DragState {
  poolId: number;
  fromMacroId: number;
}

interface Ghost {
  x: number;
  y: number;
  color: string;
}

export function SmashMacroPanel(props: SmashMacroPanelProps) {
  const {
    targetMacros,
    targetMacroInfo,
    sourceMacros,
    sourceMacroInfo,
    macroMatch,
    macroCount,
    onReseed,
    onRenameMacro,
    onSetDonor,
    onMovePool,
    onAutoRehome,
    poolChip,
    contaminatedFor,
    borderlinePools,
    globalPoolCount,
    macroPoolCount,
    onSetMacroPoolCount,
    expandedMacroId,
    onToggleExpand,
    eyedropMacroId,
    onEyedropMacro,
  } = props;

  // Transient drag state.
  const [dragging, setDragging] = useState<DragState | null>(null);
  const [hoverMacroId, setHoverMacroId] = useState<number | null>(null);
  const [ghost, setGhost] = useState<Ghost | null>(null);

  // Bin elements, keyed by macro id, for cursor hit-testing during a drag.
  const binRefs = useRef<Map<number, HTMLDivElement | null>>(new Map());
  const setBinRef = useCallback(
    (id: number) => (el: HTMLDivElement | null) => {
      binRefs.current.set(id, el);
    },
    [],
  );

  // Which bin (if any) sits under the given client point.
  const binUnderPoint = useCallback((x: number, y: number): number | null => {
    for (const [id, el] of binRefs.current) {
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return id;
    }
    return null;
  }, []);

  // Begin a manual drag from a chip. Wires window pointermove/up for the
  // duration of the gesture; cleanup runs on pointerup (or unmount).
  const beginDrag = useCallback(
    (e: React.PointerEvent, poolId: number, fromMacroId: number) => {
      e.preventDefault();
      e.stopPropagation();
      const chip = poolChip(poolId);
      const color = rgbCss(chip);
      setDragging({ poolId, fromMacroId });
      setGhost({ x: e.clientX, y: e.clientY, color });
      setHoverMacroId(null);

      const onMove = (ev: PointerEvent) => {
        setGhost({ x: ev.clientX, y: ev.clientY, color });
        setHoverMacroId(binUnderPoint(ev.clientX, ev.clientY));
      };
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        const overId = binUnderPoint(ev.clientX, ev.clientY);
        // Only reassign when dropped on a DIFFERENT, real bin.
        if (overId != null && overId !== fromMacroId) {
          onMovePool(poolId, overId);
        }
        setDragging(null);
        setGhost(null);
        setHoverMacroId(null);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [poolChip, binUnderPoint, onMovePool],
  );

  // Safety net: clear any dangling drag state if the component unmounts mid-drag.
  useEffect(() => {
    return () => {
      setDragging(null);
      setGhost(null);
      setHoverMacroId(null);
    };
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      {/* Header: label + count stepper */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ flex: 1, fontSize: 10, fontWeight: "bold", color: "#cccccc" }}>
          GROUPS
        </span>
        <div
          onClick={() => onReseed(Math.max(MIN_K, macroCount - 1))}
          title="Fewer groups"
          style={stepperStyle}
        >
          −
        </div>
        <span style={{ fontSize: 11, color: "#eee", minWidth: 14, textAlign: "center" }}>
          {macroCount}
        </span>
        <div
          onClick={() => onReseed(Math.min(MAX_K, macroCount + 1))}
          title="More groups"
          style={stepperStyle}
        >
          +
        </div>
      </div>

      {/* Hint */}
      <div style={{ fontSize: 9, color: "#999" }}>
        Drag a colour chip to another group to reassign it. Amber = looks out of
        place; dotted = also fits a nearby group.
      </div>

      {/* Empty state / bins */}
      {targetMacros.length === 0 ? (
        <div style={{ fontSize: 10, color: "#9a9aa8" }}>
          Groups appear once both images are segmented.
        </div>
      ) : (
        targetMacros.map((macro) => {
          const info = targetMacroInfo.get(macro.id);
          const donorId = macroMatch.get(macro.id);
          const donorInfo = donorId != null ? sourceMacroInfo.get(donorId) : undefined;
          const expanded = expandedMacroId === macro.id;
          const contaminated = contaminatedFor(macro.id);
          const contamSet = new Set(contaminated);
          const isDropTarget =
            dragging != null &&
            hoverMacroId === macro.id &&
            dragging.fromMacroId !== macro.id;

          return (
            <div
              key={macro.id}
              ref={setBinRef(macro.id)}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 3,
                background: isDropTarget ? "#20303f" : "#1f1f1f",
                border: isDropTarget ? "1px solid #1473e6" : "1px solid #3a3a3a",
                borderRadius: 2,
                padding: 4,
                marginBottom: 4,
              }}
            >
              {/* Header — clickable to toggle this group's detail */}
              <div
                onClick={() => onToggleExpand(expanded ? null : macro.id)}
                style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
              >
                <span style={{ fontSize: 9, color: "#777", width: 8 }}>
                  {expanded ? "▾" : "▸"}
                </span>

                <div
                  title="Target group — rename to label it"
                  style={{ ...groupSwatch, background: rgbCss(info) }}
                />

                <input
                  type="text"
                  value={macro.name}
                  title="Target group — rename to label it"
                  onChange={(e) => onRenameMacro(macro.id, e.target.value)}
                  onClick={stop}
                  onPointerDown={stop}
                  onMouseDown={stop}
                  style={nameInputStyle}
                />

                {info && (
                  <span style={{ fontSize: 9, color: "#777", whiteSpace: "nowrap" }}>
                    {Math.round(info.weight * 100)}% · {info.poolCount}p
                  </span>
                )}

                {donorInfo ? (
                  <div
                    title="Matched donor group (source)"
                    style={{ ...groupSwatch, background: rgbCss(donorInfo) }}
                  />
                ) : (
                  <span
                    title="Matched donor group (source)"
                    style={{ fontSize: 10, color: "#777", width: 14, textAlign: "center" }}
                  >
                    —
                  </span>
                )}

                {contaminated.length > 0 && (
                  <span
                    title={`${contaminated.length} members look out of place`}
                    style={contamBadge}
                  >
                    !
                  </span>
                )}
                {onEyedropMacro && (
                  <span
                    onClick={(e) => { e.stopPropagation(); onEyedropMacro(eyedropMacroId === macro.id ? null : macro.id); }}
                    onPointerDown={stop}
                    onMouseDown={stop}
                    title="Add a colour to this group — then click it on the canvas"
                    style={{
                      flex: "0 0 auto", width: 15, height: 15, borderRadius: 3,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 10, lineHeight: "15px", userSelect: "none", cursor: "pointer",
                      border: `1px solid ${eyedropMacroId === macro.id ? "#1473e6" : "#4a4a4a"}`,
                      background: eyedropMacroId === macro.id ? "#22364f" : "#3a3a3a",
                      color: "#ddd",
                    }}
                  >⊙</span>
                )}
              </div>

              {/* Chips — one per member pool; drag a chip to another bin to move it */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 3, minHeight: 18 }}>
                {macro.poolIds.map((poolId) => {
                  const chip = poolChip(poolId);
                  const isContam = contamSet.has(poolId);
                  const isBorderline = !isContam && borderlinePools.has(poolId);
                  const beingDragged =
                    dragging != null && dragging.poolId === poolId;

                  const border = isContam
                    ? "2px solid #f5a623"
                    : isBorderline
                      ? "1px dashed #888"
                      : "1px solid #000";
                  const title = isContam
                    ? "Looks out of place — drag it out or click ! to auto-rehome"
                    : isBorderline
                      ? "Also fits a nearby group"
                      : chip
                        ? `${chip.weightPct}%`
                        : "pool";

                  return (
                    <div
                      key={poolId}
                      title={title}
                      onPointerDown={(e) => beginDrag(e, poolId, macro.id)}
                      style={{
                        position: "relative",
                        width: 16,
                        height: 16,
                        flex: "0 0 auto",
                        borderRadius: 3,
                        border,
                        background: rgbCss(chip),
                        cursor: "grab",
                        opacity: beingDragged ? 0.4 : 1,
                      }}
                    >
                      {isContam && (
                        <span
                          onClick={(e) => {
                            e.stopPropagation();
                            onAutoRehome(poolId, macro.id);
                          }}
                          onPointerDown={stop}
                          onMouseDown={stop}
                          title="Auto-rehome to best-fit group"
                          style={{
                            position: "absolute",
                            top: -5,
                            right: -5,
                            width: 11,
                            height: 11,
                            borderRadius: "50%",
                            background: "#f5a623",
                            color: "#1a1a1a",
                            fontSize: 8,
                            lineHeight: "11px",
                            textAlign: "center",
                            cursor: "pointer",
                          }}
                        >
                          !
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Detail panel */}
              {expanded && (
                <DetailPanel
                  macroId={macro.id}
                  sourceMacros={sourceMacros}
                  sourceMacroInfo={sourceMacroInfo}
                  donorId={donorId}
                  globalPoolCount={globalPoolCount}
                  poolCountOverride={macroPoolCount(macro.id)}
                  onSetMacroPoolCount={onSetMacroPoolCount}
                  onSetDonor={onSetDonor}
                />
              )}
            </div>
          );
        })
      )}

      {/* Floating drag ghost (follows the cursor; ignores pointer events) */}
      {ghost && (
        <div
          style={{
            position: "fixed",
            left: ghost.x + 8,
            top: ghost.y + 8,
            width: 18,
            height: 18,
            borderRadius: 3,
            background: ghost.color,
            border: "1px solid #000",
            boxShadow: "0 2px 6px rgba(0,0,0,0.6)",
            opacity: 0.85,
            pointerEvents: "none",
            zIndex: 9999,
          }}
        />
      )}
    </div>
  );
}

// ────────── per-group detail panel ──────────

interface DetailPanelProps {
  macroId: number;
  sourceMacros: MacroGroup[];
  sourceMacroInfo: Map<number, MacroInfo>;
  donorId: number | undefined;
  globalPoolCount: number;
  poolCountOverride: number | undefined;
  onSetMacroPoolCount: (macroId: number, n: number | null) => void;
  onSetDonor: (targetMacroId: number, sourceMacroId: number) => void;
}

function DetailPanel(props: DetailPanelProps) {
  const {
    macroId,
    sourceMacros,
    sourceMacroInfo,
    donorId,
    globalPoolCount,
    poolCountOverride,
    onSetMacroPoolCount,
    onSetDonor,
  } = props;

  const overridden = poolCountOverride != null;
  const effective = poolCountOverride ?? globalPoolCount;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 2 }}>
      {/* Per-group detail (pool count) override */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span
          style={{ ...labelStyle, flex: 1 }}
          title="How finely this group re-segments its own pixels (its pool count). Overrides the global Pool count."
        >
          Detail (pools)
        </span>
        <div
          onClick={() => onSetMacroPoolCount(macroId, Math.max(MIN_DETAIL, effective - 1))}
          title="Fewer pools in this group"
          style={miniStepStyle}
        >
          −
        </div>
        <span
          style={{
            fontSize: 11,
            color: overridden ? "#ffd591" : "#888",
            minWidth: 14,
            textAlign: "center",
          }}
        >
          {effective}
        </span>
        <div
          onClick={() => onSetMacroPoolCount(macroId, Math.min(MAX_DETAIL, effective + 1))}
          title="More pools in this group"
          style={miniStepStyle}
        >
          +
        </div>
        {overridden && (
          <div
            onClick={() => onSetMacroPoolCount(macroId, null)}
            title="Use the global pool count"
            style={{
              padding: "0 6px",
              fontSize: 9,
              borderRadius: 2,
              border: "1px solid #4a4a4a",
              background: "#2c2c2c",
              color: "#aaa",
              cursor: "pointer",
              userSelect: "none",
            }}
          >
            auto
          </div>
        )}
      </div>

      {/* Donor group picker */}
      <div style={labelStyle}>Donor group</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {sourceMacros.map((sm) => {
          const sInfo = sourceMacroInfo.get(sm.id);
          const selected = donorId === sm.id;
          return (
            <div
              key={sm.id}
              onClick={() => onSetDonor(macroId, sm.id)}
              title={sm.name}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "1px 4px",
                borderRadius: 2,
                cursor: "pointer",
                userSelect: "none",
                border: selected ? "1px solid #1473e6" : "1px solid #3a3a3a",
                background: selected ? "#22364f" : "transparent",
              }}
            >
              <div
                style={{
                  width: 12,
                  height: 12,
                  flex: "0 0 auto",
                  borderRadius: 3,
                  border: "1px solid #000",
                  background: rgbCss(sInfo),
                }}
              />
              <span style={{ fontSize: 9, color: "#aaa" }}>
                {sInfo ? Math.round(sInfo.weight * 100) : 0}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
