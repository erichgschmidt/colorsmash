// Phase 0 placeholder for the Smash mode. The real surface arrives in Phase 1
// per ColorSmash_Masterplan_v1.md §5. This component exists so the Pro build
// has a visible, functional tab that proves the build flag works end-to-end.

export function SmashTab() {
  return (
    <div style={{ padding: 16, lineHeight: 1.5 }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
        Smash Engine
      </div>
      <div style={{ opacity: 0.85, marginBottom: 8 }}>
        Reference color, made editable.
      </div>
      <div style={{ opacity: 0.6, fontSize: 10 }}>
        Phase 0: the Pro build flag is active. Source DNA extraction, trait
        sliders, per-band compression, Range Fields, Recipe mode, and the
        Smash Audit panel arrive in Phase 1. See
        <code style={{ marginLeft: 4, opacity: 0.8 }}>
          ColorSmash_Masterplan_v1.md
        </code>{' '}
        §5.
      </div>
    </div>
  );
}
