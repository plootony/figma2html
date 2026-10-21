// Element picker for the content script: hover highlights a block, click selects it,
// Esc cancels, ↑ climbs to the parent. The overlay lives outside <body> so the capture
// never sees it.

export const describe = (el) => {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((c) => `.${c}`).join("") : "";
  return tag + id + cls;
};

export function pickElement() {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    host.id = "site2figma-picker";
    host.style.cssText = "position:fixed;inset:0;z-index:2147483646;pointer-events:none;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
      :host { all: initial; }
      .box { position: fixed; display: none; box-sizing: border-box; border: 2px solid #4d8dff;
        background: rgba(77,141,255,.12); box-shadow: 0 0 0 1px rgba(0,0,0,.35); border-radius: 2px; }
      .tip { position: fixed; display: none; align-items: center; gap: 8px; max-width: calc(100vw - 8px);
        padding: 4px 8px; border-radius: 6px; background: #1f1f1d; color: #ececea; font: 12px/1.4 system-ui, sans-serif;
        box-shadow: 0 4px 14px rgba(0,0,0,.35); white-space: nowrap; overflow: hidden; }
      .tip b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
      .tip span { color: #9a9a94; }
    </style>
    <div class="box"></div>
    <div class="tip"><b></b><span>клик — выбрать · ↑ — выше · Esc — отмена</span></div>`;
    document.documentElement.appendChild(host);

    const box = root.querySelector(".box");
    const tip = root.querySelector(".tip");
    const title = root.querySelector("b");
    let current = null;
    let finished = false;

    const prevCursor = document.documentElement.style.getPropertyValue("cursor");
    const prevPriority = document.documentElement.style.getPropertyPriority("cursor");
    document.documentElement.style.setProperty("cursor", "crosshair", "important");

    const normalize = (el) => (el === document.documentElement ? document.body : el);
    const elementAt = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el.closest?.("#site2figma-panel, #site2figma-picker")) return null;
      return normalize(el);
    };

    const draw = (el) => {
      current = el && el.isConnected ? el : null;
      if (!current) {
        box.style.display = "none";
        tip.style.display = "none";
        return;
      }
      const r = current.getBoundingClientRect();
      Object.assign(box.style, { display: "block", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
      title.textContent = `${describe(current)} · ${Math.round(r.width)}×${Math.round(r.height)}`;
      tip.style.display = "flex";
      tip.style.top = (r.top > 32 ? r.top - 30 : Math.min(window.innerHeight - 30, r.bottom + 6)) + "px";
      tip.style.left = Math.min(Math.max(4, r.left), Math.max(4, window.innerWidth - 300)) + "px";
    };

    const finish = (el) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(el ? normalize(el) : null);
    };

    const onMove = (e) => {
      const el = elementAt(e);
      if (el !== current) draw(el);
    };
    const onDown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };
    const onClick = (e) => {
      if (finished) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      finish(current || elementAt(e));
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      } else if (e.key === "Enter" && current) {
        e.preventDefault();
        finish(current);
      } else if (e.key === "ArrowUp" && current?.parentElement) {
        e.preventDefault();
        draw(current.parentElement);
      }
    };

    const cleanup = () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      host.remove();
      if (prevCursor) document.documentElement.style.setProperty("cursor", prevCursor, prevPriority);
      else document.documentElement.style.removeProperty("cursor");
    };

    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
  });
}
