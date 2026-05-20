// Save / load named "recipes" of Smash tab global controls. Pure UI shell — all
// persistence happens in core/recipes.ts. The parent (SmashTab) owns where this
// component lives in the layout and supplies a setter to apply a loaded recipe.

import { useCallback, useEffect, useState } from "react";
import {
  type SmashRecipe,
  type SmashRecipeSettings,
  deleteRecipe,
  listRecipes,
  renameRecipe,
  saveRecipe,
} from "../core/recipes";

interface SmashRecipesProps {
  // Current settings — used when the user clicks Save.
  current: SmashRecipeSettings;
  // Called when the user clicks Load on a recipe. Parent applies the values.
  onApply: (settings: SmashRecipeSettings) => void;
}

// Shared style atoms — kept inline to match the rest of the SmashTab tree which
// avoids CSS modules / theme files. Colors track SmashTab's dark conventions.
const BTN_BASE = {
  fontSize: 10,
  padding: "3px 8px",
  borderRadius: 2,
  border: "1px solid #4a4a4a",
  background: "#3a3a3a",
  color: "#cccccc",
  cursor: "pointer",
  userSelect: "none" as const,
  fontFamily: "inherit",
};

const BTN_PRIMARY = {
  ...BTN_BASE,
  border: "1px solid #1473e6",
  background: "#1473e6",
  color: "#ffffff",
  fontWeight: 600,
};

const BTN_DISABLED = {
  ...BTN_BASE,
  background: "#2a2a2a",
  color: "#666666",
  cursor: "default",
  border: "1px solid #3a3a3a",
};

const INPUT_STYLE = {
  flex: 1,
  fontSize: 10,
  padding: "3px 6px",
  borderRadius: 2,
  border: "1px solid #4a4a4a",
  background: "#1f1f1f",
  color: "#cccccc",
  fontFamily: "inherit",
  outline: "none",
};

// "Apr 12, 5:30 PM" formatting. Intl.DateTimeFormat is available in UXP's CEF.
function formatTimestamp(ms: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleString();
  }
}

export function SmashRecipes(props: SmashRecipesProps): JSX.Element {
  const { current, onApply } = props;
  const [recipes, setRecipes] = useState<SmashRecipe[]>(() => listRecipes());
  const [draftName, setDraftName] = useState("");
  // id of the recipe currently being inline-renamed (null = none).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");

  // Refresh from storage. Called after every mutation so the on-screen list
  // matches what's persisted, even if a future caller mutates from elsewhere.
  const refresh = useCallback(() => {
    setRecipes(listRecipes());
  }, []);

  // Pick up external changes if storage is mutated outside this component
  // (e.g. another panel writing the same key). Cheap; only fires on focus.
  useEffect(() => {
    const handler = () => refresh();
    window.addEventListener("focus", handler);
    return () => window.removeEventListener("focus", handler);
  }, [refresh]);

  const canSave = draftName.trim().length > 0;

  const handleSave = useCallback(() => {
    if (!canSave) return;
    saveRecipe(draftName, current);
    setDraftName("");
    refresh();
  }, [canSave, draftName, current, refresh]);

  const handleDelete = useCallback((id: string) => {
    deleteRecipe(id);
    if (editingId === id) setEditingId(null);
    refresh();
  }, [editingId, refresh]);

  const beginRename = useCallback((r: SmashRecipe) => {
    setEditingId(r.id);
    setEditingValue(r.name);
  }, []);

  const commitRename = useCallback(() => {
    if (editingId) {
      renameRecipe(editingId, editingValue);
      refresh();
    }
    setEditingId(null);
    setEditingValue("");
  }, [editingId, editingValue, refresh]);

  const cancelRename = useCallback(() => {
    setEditingId(null);
    setEditingValue("");
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {/* Save row */}
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          type="text"
          value={draftName}
          placeholder="Recipe name"
          onChange={(e) => setDraftName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
          style={INPUT_STYLE}
        />
        <button
          type="button"
          onClick={handleSave}
          disabled={!canSave}
          style={canSave ? BTN_PRIMARY : BTN_DISABLED}
        >
          Save current settings
        </button>
      </div>

      {/* List */}
      <div
        style={{
          maxHeight: 240,
          overflowY: "auto",
          background: "#1f1f1f",
          border: "1px solid #3a3a3a",
          borderRadius: 2,
          padding: recipes.length === 0 ? 12 : 4,
        }}
      >
        {recipes.length === 0 ? (
          <div style={{ fontSize: 10, color: "#777", textAlign: "center" }}>
            No saved recipes yet. Tweak the controls, name your look, and click Save.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {recipes.map((r) => {
              const isEditing = editingId === r.id;
              return (
                <div
                  key={r.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "4px 6px",
                    borderRadius: 2,
                    background: "#252525",
                  }}
                >
                  {/* Name (click to rename) + timestamp */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {isEditing ? (
                      <input
                        type="text"
                        autoFocus
                        value={editingValue}
                        onChange={(e) => setEditingValue(e.target.value)}
                        onBlur={commitRename}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename();
                          else if (e.key === "Escape") cancelRename();
                        }}
                        style={{ ...INPUT_STYLE, flex: undefined, width: "100%" }}
                      />
                    ) : (
                      <div
                        onClick={() => beginRename(r)}
                        title="Click to rename"
                        style={{
                          fontSize: 11,
                          color: "#cccccc",
                          cursor: "text",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {r.name}
                      </div>
                    )}
                    <div style={{ fontSize: 9, color: "#777" }}>
                      {formatTimestamp(r.createdAt)}
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => onApply({
                      segmentation: { ...r.segmentation },
                      transfer: { ...r.transfer },
                    })}
                    style={BTN_BASE}
                    title="Apply this recipe's settings"
                  >
                    Load
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(r.id)}
                    style={{
                      ...BTN_BASE,
                      padding: "1px 6px",
                      fontSize: 11,
                      lineHeight: "12px",
                    }}
                    title="Delete recipe"
                    aria-label={`Delete ${r.name}`}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
