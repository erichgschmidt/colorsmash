// UXP-compatible confirm dialog. window.confirm() doesn't exist in UXP — instead we
// create an HTMLDialogElement and use its UXP extension `uxpShowModal()`. Resolves to
// true if the user clicks OK, false if Cancel (or closes the dialog any other way).
//
// Lightweight, no dependencies, works on every UXP version that ships HTMLDialogElement.

export async function uxpConfirm(message: string, okLabel = "OK", cancelLabel = "Cancel"): Promise<boolean> {
  const dialog = document.createElement("dialog");
  dialog.style.background = "#3a3a3a";
  dialog.style.color = "#dddddd";
  dialog.style.border = "1px solid #555";
  dialog.style.borderRadius = "4px";
  dialog.style.padding = "0";
  dialog.style.fontSize = "12px";
  dialog.style.minWidth = "240px";

  const wrap = document.createElement("div");
  wrap.style.padding = "14px";

  const msg = document.createElement("div");
  msg.textContent = message;
  msg.style.marginBottom = "14px";
  wrap.appendChild(msg);

  const row = document.createElement("div");
  row.style.display = "flex";
  row.style.gap = "8px";
  row.style.justifyContent = "flex-end";

  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = cancelLabel;
  cancelBtn.style.cssText = "padding: 4px 12px; background: transparent; color: #ddd; border: 1px solid #888; border-radius: 3px; cursor: pointer; font-size: 12px;";

  const okBtn = document.createElement("button");
  okBtn.textContent = okLabel;
  okBtn.style.cssText = "padding: 4px 12px; background: #1473e6; color: #fff; border: 1px solid #1473e6; border-radius: 3px; cursor: pointer; font-size: 12px;";

  row.appendChild(cancelBtn);
  row.appendChild(okBtn);
  wrap.appendChild(row);
  dialog.appendChild(wrap);
  document.body.appendChild(dialog);

  return new Promise<boolean>(resolve => {
    const cleanup = (result: boolean) => {
      try { dialog.close(); } catch { /* */ }
      try { document.body.removeChild(dialog); } catch { /* */ }
      resolve(result);
    };
    okBtn.addEventListener("click", () => cleanup(true));
    cancelBtn.addEventListener("click", () => cleanup(false));
    dialog.addEventListener("close", () => cleanup(false));
    // UXP-specific modal show. Falls back to showModal() for non-UXP envs.
    const uxpShow = (dialog as any).uxpShowModal;
    if (typeof uxpShow === "function") uxpShow.call(dialog, { title: "Color Smash" });
    else if (typeof (dialog as any).showModal === "function") (dialog as any).showModal();
    else { cleanup(true); /* worst case: just proceed */ }
  });
}
