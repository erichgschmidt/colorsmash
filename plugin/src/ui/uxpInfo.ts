// UXP info dialog — read-only modal with a single Close button. Use for in-panel help
// content too dense to live in tooltips. Built on the same HTMLDialogElement / uxpShowModal
// pattern as uxpConfirm.
//
// Pass an array of section objects so the dialog can render headings + paragraphs/bullets
// without the caller building HTML manually.

export interface InfoSection {
  heading: string;
  body: string | string[]; // string = paragraph; string[] = bullet list
}

export async function uxpInfo(title: string, sections: InfoSection[]): Promise<void> {
  const dialog = document.createElement("dialog");
  dialog.style.background = "#3a3a3a";
  dialog.style.color = "#dddddd";
  dialog.style.border = "1px solid #555";
  dialog.style.borderRadius = "4px";
  dialog.style.padding = "0";
  dialog.style.fontSize = "12px";
  dialog.style.minWidth = "360px";
  dialog.style.maxWidth = "520px";

  const wrap = document.createElement("div");
  wrap.style.padding = "16px";

  const titleEl = document.createElement("div");
  titleEl.textContent = title;
  titleEl.style.cssText = "font-size: 14px; font-weight: 700; margin-bottom: 12px; color: #ffffff;";
  wrap.appendChild(titleEl);

  for (const sec of sections) {
    const h = document.createElement("div");
    h.textContent = sec.heading;
    h.style.cssText = "font-weight: 700; margin-top: 10px; margin-bottom: 4px; color: #cccccc;";
    wrap.appendChild(h);

    if (Array.isArray(sec.body)) {
      const ul = document.createElement("ul");
      ul.style.cssText = "margin: 0; padding-left: 18px; line-height: 1.5;";
      for (const item of sec.body) {
        const li = document.createElement("li");
        li.textContent = item;
        ul.appendChild(li);
      }
      wrap.appendChild(ul);
    } else {
      const p = document.createElement("div");
      p.textContent = sec.body;
      p.style.cssText = "line-height: 1.5; margin-bottom: 4px;";
      wrap.appendChild(p);
    }
  }

  const row = document.createElement("div");
  row.style.cssText = "display: flex; justify-content: flex-end; margin-top: 16px;";

  const okBtn = document.createElement("button");
  okBtn.textContent = "Close";
  okBtn.style.cssText = "padding: 4px 14px; background: #1473e6; color: #fff; border: 1px solid #1473e6; border-radius: 3px; cursor: pointer; font-size: 12px;";
  row.appendChild(okBtn);
  wrap.appendChild(row);
  dialog.appendChild(wrap);
  document.body.appendChild(dialog);

  return new Promise<void>(resolve => {
    const cleanup = () => {
      try { dialog.close(); } catch { /* */ }
      try { document.body.removeChild(dialog); } catch { /* */ }
      resolve();
    };
    okBtn.addEventListener("click", cleanup);
    dialog.addEventListener("close", cleanup);
    const uxpShow = (dialog as any).uxpShowModal;
    if (typeof uxpShow === "function") uxpShow.call(dialog, { title: "Color Smash" });
    else if (typeof (dialog as any).showModal === "function") (dialog as any).showModal();
    else cleanup();
  });
}
