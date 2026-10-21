// Element picker for the content script: hover highlights a block, click selects it,
// Shift/Ctrl/Cmd+click adds more blocks, ↑ climbs to the parent, Esc cancels. Breadcrumbs at the top
// let you pick an ancestor directly. The overlay lives outside <body> so the capture
// never sees it.

export const describe = (el) => {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((c) => `.${c}`).join("") : "";
  return tag + id + cls;
};

const ancestorPath = (el) => {
  const path = [];
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) path.unshift(node);
  return path;
};

export function pickElements() {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    host.id = "site2figma-picker";
    host.style.cssText = "position:fixed;inset:0;z-index:2147483646;pointer-events:none;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
      :host { all: initial; }
      .box, .sel-box { position: fixed; display: none; box-sizing: border-box; border-radius: 2px; pointer-events: none; }
      .box { border: 2px solid #4d8dff; background: rgba(77,141,255,.12); box-shadow: 0 0 0 1px rgba(0,0,0,.35); }
      .sel-box { border: 2px dashed #3fbf75; background: rgba(63,191,117,.1); }
      .crumbs { position: fixed; left: 50%; top: 10px; transform: translateX(-50%); display: none; align-items: center; gap: 4px;
        max-width: calc(100vw - 20px); padding: 5px 8px; border-radius: 8px; background: #1f1f1d; color: #ececea;
        font: 12px/1.4 system-ui, sans-serif; box-shadow: 0 6px 22px rgba(0,0,0,.35); pointer-events: auto; overflow: hidden; }
      .crumbs button { border: 0; background: transparent; color: #9a9a94; font: inherit; cursor: pointer; padding: 2px 3px;
        max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .crumbs button:hover { color: #4d8dff; }
      .crumbs .sep { color: #5a5a55; }
      .crumbs .count { color: #3fbf75; font-weight: 600; margin-left: 6px; white-space: nowrap; }
      .crumbs .hint { color: #9a9a94; margin-left: 8px; white-space: nowrap; }
      .tip { position: fixed; display: none; padding: 4px 8px; border-radius: 6px; background: #1f1f1d; color: #ececea;
        font: 12px/1.4 system-ui, sans-serif; box-shadow: 0 4px 14px rgba(0,0,0,.35); white-space: nowrap; pointer-events: none; }
      .tip b { font-weight: 600; }
      .finish { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); pointer-events: auto;
        padding: 9px 18px; border: 0; border-radius: 999px; background: #4d8dff; color: #fff; cursor: pointer;
        font: 600 13px/1.4 system-ui, sans-serif; box-shadow: 0 8px 26px rgba(0,0,0,.35); }
      .finish:disabled { opacity: .55; cursor: default; }
    </style>
    <div class="crumbs"></div>
    <div class="box"></div>
    <div class="selected"></div>
    <div class="tip"><b></b></div>
    <button class="finish" type="button" disabled>Завершить выбор</button>`;
    document.documentElement.appendChild(host);

    const box = root.querySelector(".box");
    const tip = root.querySelector(".tip");
    const tipName = root.querySelector(".tip b");
    const finishBtn = root.querySelector(".finish");
    const crumbs = root.querySelector(".crumbs");
    const selectedLayer = root.querySelector(".selected");
    const picked = [];
    let current = null;
    let finished = false;

    const prevCursor = document.documentElement.style.getPropertyValue("cursor");
    const prevPriority = document.documentElement.style.getPropertyPriority("cursor");
    document.documentElement.style.setProperty("cursor", "crosshair", "important");

    const normalize = (el) => (el === document.documentElement ? document.body : el);
    const sameOrInside = (child, parent) => child === parent || parent.contains(child);
    const additive = (e) => e.shiftKey || e.ctrlKey || e.metaKey;
    const elementAt = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el.closest?.("#site2figma-panel, #site2figma-picker")) return null;
      return normalize(el);
    };

    const drawSelected = () => {
      selectedLayer.textContent = "";
      for (const el of picked) {
        if (!el.isConnected) continue;
        const r = el.getBoundingClientRect();
        const mark = document.createElement("div");
        mark.className = "sel-box";
        Object.assign(mark.style, { display: "block", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
        selectedLayer.append(mark);
      }
    };

    const updateFinish = () => {
      finishBtn.textContent = picked.length ? `Завершить выбор (${picked.length})` : "Завершить выбор";
      finishBtn.disabled = !picked.length;
    };

    const drawCrumbs = () => {
      crumbs.textContent = "";
      if (!current) {
        crumbs.style.display = "none";
        return;
      }
      crumbs.style.display = "flex";
      const path = ancestorPath(current).filter((el) => el !== document.documentElement);
      const shown = path.length > 6 ? [path[0], null, ...path.slice(-4)] : path;
      shown.forEach((el, i) => {
        if (i) {
          const sep = document.createElement("span");
          sep.className = "sep";
          sep.textContent = "›";
          crumbs.append(sep);
        }
        if (!el) {
          const dots = document.createElement("span");
          dots.className = "sep";
          dots.textContent = "…";
          crumbs.append(dots);
          return;
        }
        const btn = document.createElement("button");
        btn.textContent = describe(el);
        btn.title = "Выбрать этот блок";
        btn.addEventListener("pointerdown", (e) => e.stopPropagation());
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (additive(e)) {
            toggle(el);
            draw(el);
          } else {
            finish([...picked, el]);
          }
        });
        crumbs.append(btn);
      });
      if (picked.length) {
        const count = document.createElement("span");
        count.className = "count";
        count.textContent = `выбрано: ${picked.length}`;
        crumbs.append(count);
      }
      const hint = document.createElement("span");
      hint.className = "hint";
      hint.textContent = "Ctrl/Shift+клик — ещё · ↑ — выше · Esc — отмена";
      crumbs.append(hint);
    };

    const draw = (el) => {
      current = el && el.isConnected ? el : null;
      if (!current) {
        box.style.display = "none";
        tip.style.display = "none";
        crumbs.style.display = "none";
        return;
      }
      const r = current.getBoundingClientRect();
      const already = picked.some((p) => sameOrInside(current, p));
      Object.assign(box.style, { display: "block", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
      box.style.borderColor = already ? "#3fbf75" : "#4d8dff";
      box.style.background = already ? "rgba(63,191,117,.12)" : "rgba(77,141,255,.12)";
      tipName.textContent = `${describe(current)} · ${Math.round(r.width)}×${Math.round(r.height)}`;
      tip.style.display = "block";
      tip.style.top = (r.top > 52 ? r.top - 30 : Math.min(window.innerHeight - 30, r.bottom + 6)) + "px";
      tip.style.left = Math.min(Math.max(4, r.left), Math.max(4, window.innerWidth - 300)) + "px";
      drawCrumbs();
    };

    const toggle = (el) => {
      const i = picked.indexOf(el);
      if (i >= 0) {
        picked.splice(i, 1);
      } else {
        // A selected ancestor already covers this element.
        for (let j = picked.length - 1; j >= 0; j--) if (sameOrInside(el, picked[j])) return;
        for (let j = picked.length - 1; j >= 0; j--) if (sameOrInside(picked[j], el)) picked.splice(j, 1);
        picked.push(el);
      }
      drawSelected();
      drawCrumbs();
      updateFinish();
    };

    const finish = (els) => {
      if (finished) return;
      finished = true;
      cleanup();
      const out = [];
      for (const el of els || []) {
        if (!el || !el.isConnected) continue;
        if (out.some((p) => sameOrInside(el, p))) continue;
        for (let i = out.length - 1; i >= 0; i--) if (sameOrInside(out[i], el)) out.splice(i, 1);
        out.push(el);
      }
      resolve(out);
    };

    const fromOverlay = (e) => e.composedPath?.().some((n) => n.id === "site2figma-picker" || n.classList?.contains("crumbs"));
    const onMove = (e) => {
      const el = elementAt(e);
      if (el !== current) draw(el);
    };
    const onDown = (e) => {
      if (e.button !== 0 || fromOverlay(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };
    const onClick = (e) => {
      if (finished || fromOverlay(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const el = current || elementAt(e);
      if (!el) return;
      if (additive(e)) {
        toggle(el);
        draw(el);
      } else {
        finish([...picked, el]);
      }
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      } else if (e.key === "Enter") {
        e.preventDefault();
        finish(picked.length ? picked : current ? [current] : null);
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

    finishBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
    finishBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (picked.length) finish(picked);
    });
    updateFinish();

    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
  });
}
