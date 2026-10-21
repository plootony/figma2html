// Content script: a small panel on the page (in a shadow root, outside <body>, so it is never
// captured). Runs the in-page pipeline; network and the thumbnail go through background.js.
import { capture } from "../core/pipeline.js";
import { scanMedia } from "./media.js";
import { pickElement, describe } from "./picker.js";
import { scanFonts } from "./fontscan.js";


function send(msg) {
  return new Promise((resolve, reject) =>
    chrome.runtime.sendMessage(msg, (r) => (chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(r)))
  );
}

const net = {
  async text(url) {
    const r = await send({ type: "net", url, kind: "text" });
    if (r.error) throw new Error(r.error);
    return r.text;
  },
  async get(url) {
    const r = await send({ type: "net", url, kind: "bytes" });
    if (r.error) throw new Error(r.error);
    return r;
  },
};

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

const CSS = `
:host { all: initial; }
.panel { position: fixed; top: 16px; right: 16px; z-index: 2147483647; width: 320px; box-sizing: border-box;
  background: #1f1f1d; color: #ececea; border: 1px solid #3a3a36; border-radius: 12px; padding: 16px;
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; box-shadow: 0 8px 30px rgba(0,0,0,.35);
  max-height: calc(100vh - 32px); overflow: auto; }
.head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.title { font-weight: 600; font-size: 14px; }
.close { background: none; border: 0; color: #9a9a94; font-size: 18px; cursor: pointer; padding: 0 4px; }
.muted { color: #9a9a94; font-size: 12px; }
label { display: flex; gap: 6px; align-items: center; margin: 8px 0; cursor: pointer; }
input[type=text] { width: 100%; box-sizing: border-box; margin-top: 4px; padding: 6px 8px; border-radius: 6px;
  border: 1px solid #3a3a36; background: #161615; color: #ececea; font: inherit; }
button.primary, button.secondary { width: 100%; margin-top: 10px; padding: 9px; border-radius: 8px; font: inherit;
  font-weight: 600; cursor: pointer; border: 1px solid #4d8dff; }
button.primary { background: #4d8dff; color: #fff; }
button.secondary { background: transparent; color: #4d8dff; }
button:disabled { opacity: .5; cursor: default; }
.status { margin-top: 10px; min-height: 18px; }
.err { color: #ff6b6b; }
.ok { color: #3fbf75; }
.hidden { display: none; }
.svgblock { margin-top: 12px; border-top: 1px solid #3a3a36; padding-top: 10px; }
.svglist { max-height: 260px; overflow: auto; margin-top: 6px; }
.svgrow { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 12px; }
.svgpreview { flex: none; width: 72px; height: 44px; border-radius: 4px; background: #f3f4f7; overflow: hidden; }
.svgname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #9a9a94; }
.tabs { display: flex; gap: 4px; margin-bottom: 12px; background: #161615; border-radius: 8px; padding: 3px; }
.tabs button { flex: 1; padding: 6px; border: 0; border-radius: 6px; background: transparent; color: #9a9a94; font: inherit; cursor: pointer; }
.tabs button.active { background: #2c2c29; color: #ececea; }
.kinds { display: flex; flex-wrap: wrap; gap: 4px 14px; }
.medialist { max-height: 340px; overflow: auto; margin-top: 8px; border-top: 1px solid #3a3a36; }
.mediarow { display: flex; align-items: center; gap: 8px; padding: 4px 0; margin: 0; font-size: 12px; }
.mediarow input { flex: none; }
.mediathumb { flex: none; width: 56px; height: 38px; border-radius: 4px; background: #f3f4f7 center/contain no-repeat; overflow: hidden; display: flex; align-items: center; justify-content: center; }
.mediathumb img, .mediathumb video { max-width: 100%; max-height: 100%; }
.medianame { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mediameta { color: #9a9a94; font-size: 11px; }
button.small { padding: 4px 10px; border-radius: 6px; border: 1px solid #3a3a36; background: transparent; color: #4d8dff; font: inherit; cursor: pointer; }
.targetrow { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.targetname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #4d8dff; font-size: 12px; }
.toast { position: fixed; left: 50%; bottom: 24px; transform: translate(-50%, 12px); z-index: 2147483647;
  background: #1f1f1d; color: #ececea; border: 1px solid #3a3a36; border-radius: 10px; padding: 10px 16px;
  font: 600 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; box-shadow: 0 8px 30px rgba(0,0,0,.35);
  opacity: 0; pointer-events: none; transition: opacity .18s, transform .18s; }
.toast.show { opacity: 1; transform: translate(-50%, 0); }
.progress { height: 4px; margin-top: 8px; border-radius: 2px; background: #161615; overflow: hidden; }
.progress i { display: block; height: 100%; width: 0; background: #4d8dff; transition: width .18s ease; }
.fontpreview { flex: none; width: 42px; height: 38px; display: flex; align-items: center; justify-content: center;
  border-radius: 4px; background: #161615; color: #ececea; font-size: 20px; overflow: hidden; }
.advanced { margin-top: 10px; border-top: 1px solid #3a3a36; padding-top: 8px; }
.advanced summary { display: flex; align-items: center; gap: 6px; cursor: pointer; color: #9a9a94; font-size: 12px; list-style: none; }
.advanced summary::-webkit-details-marker { display: none; }
.advanced summary::before { content: "▸"; color: #4d8dff; }
.advanced[open] summary::before { content: "▾"; }
.advanced-body { padding-top: 2px; }
`;

// Inter shipped with the extension (fonts/), used when Google Fonts can't be reached.
async function bundledFont(weight) {
  const res = await fetch(chrome.runtime.getURL(`fonts/Inter-${weight}.ttf`));
  if (!res.ok) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Preview of SVG code: the SVG in its own shadow root, so its styles and ids stay isolated
// (several files reuse ids like #clip0) and page CSP rules for images don't apply.
function svgPreview(text, className) {
  const preview = document.createElement("div");
  preview.className = className;
  const shadow = preview.attachShadow({ mode: "open" });
  const svg = new DOMParser().parseFromString(text, "image/svg+xml").documentElement;
  if (svg.localName === "svg") {
    for (const s of svg.querySelectorAll("script, foreignObject")) s.remove();
    if (!svg.getAttribute("viewBox")) {
      const w = parseFloat(svg.getAttribute("width")) || 100;
      const h = parseFloat(svg.getAttribute("height")) || 100;
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    }
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    shadow.append(document.importNode(svg, true));
  }
  return preview;
}

function createPanel() {
  const host = document.createElement("div");
  host.id = "site2figma-panel";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${CSS}</style>
    <div class="panel">
      <div class="head"><span class="title">Site → Figma</span><button class="close" title="Закрыть">×</button></div>
      <div class="tabs"><button class="active" data-tab="figma">В Figma</button><button data-tab="media">Медиа</button><button data-tab="fonts">Шрифты</button></div>
      <div class="tab tab-figma">
      <div class="muted width"></div>
      <button class="secondary pick">Выбрать блок на странице</button>
      <div class="targetrow hidden"><span class="targetname"></span><button class="small clear">Сбросить</button></div>
      <details class="advanced">
        <summary>Дополнительные настройки</summary>
        <div class="advanced-body">
          <label><input type="checkbox" class="abs"> Без auto layout</label>
          <label><input type="checkbox" class="exclude"> Исключить блоки</label>
          <div class="hidebox hidden">
            <div class="muted">Убрать перед захватом (CSS-селекторы через запятую):</div>
            <input type="text" class="hide" placeholder="#cookie-banner, .chat-widget">
          </div>
        </div>
      </details>
      <button class="primary go">Захватить страницу</button>
      <div class="status"></div>
      <div class="progress hidden"><i></i></div>
      <div class="result hidden">
        <button class="primary copy">Копировать для вставки в Figma</button>
        <button class="secondary download">Скачать .fig</button>
        <div class="svgblock hidden">
          <div class="muted svgnote">SVG с градиентами, тенями или анимацией перенесены картинками (слои «SVG: имя файла»). Чтобы получить векторы: в Figma выделите такой слой, здесь нажмите «Копировать», в Figma — Ctrl+Shift+R (вставить с заменой).</div>
          <div class="svglist"></div>
        </div>
      </div>
      </div>
      <div class="tab tab-media hidden">
        <div class="muted">Все картинки, SVG и видео страницы — в папку «Загрузки/Site to Figma/…».</div>
        <button class="primary scan">Найти медиа на странице</button>
        <div class="mediabox hidden">
          <div class="kinds">
            <label><input type="checkbox" data-kind="image" checked> Картинки <span class="cnt-image"></span></label>
            <label><input type="checkbox" data-kind="svg" checked> SVG <span class="cnt-svg"></span></label>
            <label><input type="checkbox" data-kind="video" checked> Видео <span class="cnt-video"></span></label>
          </div>
          <div class="medialist"></div>
          <button class="primary save">Скачать</button>
        </div>
        <div class="status mstatus"></div>
      </div>
      <div class="tab tab-fonts hidden">
        <div class="muted">Все шрифты, подключённые на странице через @font-face, — в папку «Загрузки/Site to Figma/…/fonts».</div>
        <button class="primary scanf">Найти шрифты на странице</button>
        <div class="fontsbox hidden">
          <div class="medialist fontlist"></div>
          <button class="primary savefonts">Скачать</button>
        </div>
        <div class="status fstatus"></div>
      </div>
    </div>
    <div class="toast"></div>`;
  document.documentElement.appendChild(host);

  const $ = (s) => root.querySelector(s);
  const status = (text, cls = "") => {
    $(".status").className = "status " + cls;
    $(".status").textContent = text;
  };
  const showWidth = () => ($(".width").textContent = `Ширина макета: ${document.documentElement.clientWidth}px (ширина окна)`);
  showWidth();
  window.addEventListener("resize", showWidth);

  let result = null;
  let busy = false;
  let target = null;
  let toastTimer = 0;

  const toast = (text) => {
    const el = $(".toast");
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
  };

  // Capture stages from the pipeline progress messages, with a little creep between them.
  const STAGES = [
    ["Прокрутка", 10],
    ["Снимки", 22],
    ["SVG", 34],
    ["Шрифты", 50],
    ["Конвертация", 70],
    ["Обработка", 88],
  ];
  let progressValue = 0;
  let progressCap = 0;
  let progressTimer = 0;
  let progressHideTimer = 0;
  const paintProgress = () => ($(".progress i").style.width = `${progressValue.toFixed(1)}%`);
  const startProgress = () => {
    clearInterval(progressTimer);
    clearTimeout(progressHideTimer);
    progressValue = 3;
    progressCap = 8;
    $(".progress").classList.remove("hidden");
    paintProgress();
    status("Подготовка…");
    progressTimer = setInterval(() => {
      if (progressValue >= progressCap - 0.15) return;
      progressValue = Math.min(progressCap, progressValue + Math.max(0.2, (progressCap - progressValue) * 0.12));
      paintProgress();
    }, 140);
  };
  const stageProgress = (message) => {
    const stage = STAGES.find(([prefix]) => message.startsWith(prefix));
    if (stage) progressCap = Math.max(progressCap, stage[1]);
    status(message);
  };
  const stopProgress = (value = 0) => {
    clearInterval(progressTimer);
    clearTimeout(progressHideTimer);
    progressValue = value;
    paintProgress();
  };
  const finishProgress = () => stopProgress(100);
  const hideProgress = (delay = 900) => {
    clearTimeout(progressHideTimer);
    progressHideTimer = setTimeout(() => $(".progress").classList.add("hidden"), delay);
  };

  const updateTarget = () => {
    $(".targetrow").classList.toggle("hidden", !target);
    $(".targetname").textContent = target ? describe(target) : "";
    $(".go").textContent = target ? "Захватить выбранный блок" : "Захватить страницу";
  };

  const updateHideBox = () => $(".hidebox").classList.toggle("hidden", !$(".exclude").checked);
  $(".exclude").addEventListener("change", updateHideBox);
  updateHideBox();

  // Pick a block on the page. The panel is hidden while the picker overlay is active.
  $(".pick").addEventListener("click", async () => {
    if (busy) return;
    host.style.display = "none";
    await nextFrame();
    let el = null;
    try {
      el = await pickElement();
    } finally {
      host.style.display = "";
    }
    if (el) {
      target = el;
      updateTarget();
      const r = el.getBoundingClientRect();
      status(`Выбран блок ${describe(el)} · ${Math.round(r.width)}×${Math.round(r.height)}`, "ok");
    }
  });

  $(".clear").addEventListener("click", () => {
    target = null;
    updateTarget();
    status("Будет захвачена вся страница");
  });

  // Screenshot of the top of the page for the .fig thumbnail; the panel is hidden meanwhile.
  async function thumbnail() {
    host.style.display = "none";
    await nextFrame();
    try {
      const r = await send({ type: "shot" });
      if (!r.dataUrl) return null;
      const bmp = await createImageBitmap(await (await fetch(r.dataUrl)).blob());
      const w = 400;
      const h = Math.round((bmp.height * w) / bmp.width);
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
      return new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
    } finally {
      host.style.display = "";
    }
  }

  // Viewport screenshot for canvas/video snapshots. Chrome allows ~2 captures per second.
  let lastShot = 0;
  async function captureViewport() {
    const waitMs = lastShot + 600 - Date.now();
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    lastShot = Date.now();
    const r = await send({ type: "shot" });
    if (!r.dataUrl) throw new Error(r.error || "screenshot failed");
    return createImageBitmap(await (await fetch(r.dataUrl)).blob());
  }

  $(".go").addEventListener("click", async () => {
    if (busy) return;
    if (target && !target.isConnected) {
      target = null;
      updateTarget();
    }
    busy = true;
    result = null;
    $(".go").disabled = true;
    $(".result").classList.add("hidden");
    startProgress();
    const t0 = Date.now();
    try {
      result = await capture(
        { layout: $(".abs").checked ? "absolute" : "auto", hideSelectors: $(".exclude").checked ? $(".hide").value : "", target: target || undefined },
        { net, thumbnail, captureViewport, bundledFont, progress: (m) => stageProgress(m) }
      );
      finishProgress();
      console.info("site2figma: capture", JSON.stringify(result.debug.fixes), "fonts", JSON.stringify(result.debug.fonts));
      const notes = result.log.length ? " " + result.log.join(" ") : "";
      const summary = `Готово за ${Math.round((Date.now() - t0) / 1000)} с: ${result.nodes} слоёв, ${result.images} картинок, ${(result.fig.length / 1048576).toFixed(1)} МБ.`;
      $(".result").classList.remove("hidden");
      renderSvgList();
      status(`${summary} Копирую в буфер…`, "ok");
      const copied = await copyHtml(result.clipboardHtml).catch(() => false);
      if (copied) {
        status(`${summary} Скопировано в буфер — Ctrl+V в Figma.${notes}`, "ok");
        toast("Скопировано в буфер обмена — Ctrl+V в Figma");
        $(".copy").textContent = "Скопировано — Ctrl+V в Figma";
        setTimeout(() => ($(".copy").textContent = "Копировать для вставки в Figma"), 3200);
      } else {
        status(`${summary}${notes}`, "ok");
        toast("Не удалось скопировать автоматически — нажмите «Копировать для вставки в Figma»");
      }
      hideProgress(1200);
    } catch (e) {
      console.error("site2figma", e);
      stopProgress(0);
      $(".progress").classList.add("hidden");
      status("Ошибка: " + (e.message || e), "err");
    } finally {
      busy = false;
      $(".go").disabled = false;
    }
  });

  const saveFile = (bytes, filename) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    root.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };
  const baseName = () => result.name.replace(/[\\/:*?"<>|]+/g, " ").trim() || "page";

  $(".download").addEventListener("click", () => result && saveFile(result.fig, baseName() + ".fig"));

  // Copy text with the copy event: works from a click without clipboard permissions prompts.
  const copyText = (data, type) => {
    const onCopy = (e) => {
      e.clipboardData.setData(type, data);
      e.preventDefault();
    };
    document.addEventListener("copy", onCopy, true);
    const ok = document.execCommand("copy");
    document.removeEventListener("copy", onCopy, true);
    return ok;
  };

  // Auto-copy after capture has no click gesture, so try the async Clipboard API first.
  const copyHtml = async (html) => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }) })]);
      return true;
    } catch {}
    return copyText(html, "text/html");
  };

  // SVGs kept as images: one "copy code" button each, for paste-to-replace in Figma.
  function renderSvgList() {
    const list = $(".svglist");
    list.textContent = "";
    $(".svgblock").classList.toggle("hidden", !result.svgOriginals?.length);
    for (const { name, text } of result.svgOriginals || []) {
      const row = document.createElement("div");
      row.className = "svgrow";
      const preview = svgPreview(text, "svgpreview");
      const label = document.createElement("span");
      label.className = "svgname";
      label.textContent = name.length > 22 ? name.slice(0, 9) + "…" + name.slice(-9) : name;
      label.title = name;
      const btn = document.createElement("button");
      btn.className = "small";
      btn.textContent = "Копировать";
      btn.addEventListener("click", () => {
        btn.textContent = copyText(text, "text/plain") ? "Скопировано" : "Ошибка";
        setTimeout(() => (btn.textContent = "Копировать"), 2000);
      });
      row.append(preview, label, btn);
      list.append(row);
    }
  }

  $(".copy").addEventListener("click", async () => {
    if (!result) return;
    const ok = await copyHtml(result.clipboardHtml);
    $(".copy").textContent = ok ? "Скопировано — Ctrl+V в Figma" : "Не удалось скопировать";
    if (ok) toast("Скопировано в буфер обмена — Ctrl+V в Figma");
    setTimeout(() => ($(".copy").textContent = "Копировать для вставки в Figma"), 2500);
  });

  // ---- Tabs ----
  for (const btn of root.querySelectorAll(".tabs button")) {
    btn.addEventListener("click", () => {
      for (const b of root.querySelectorAll(".tabs button")) b.classList.toggle("active", b === btn);
      for (const t of root.querySelectorAll(".tab")) t.classList.toggle("hidden", !t.classList.contains("tab-" + btn.dataset.tab));
    });
  }

  const cleanFileName = (s) => s.replace(/[\\/:*?"<>|~]+/g, "_").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 120) || "file";
  const downloadsFolder = () => {
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}-${String(d.getMinutes()).padStart(2, "0")}`;
    return `Site to Figma/${cleanFileName(location.hostname || "page")} ${stamp}`;
  };

  // ---- Media tab ----
  let media = [];
  const mstatus = (text, cls = "") => {
    $(".mstatus").className = "status mstatus " + cls;
    $(".mstatus").textContent = text;
  };
  const kindEnabled = (kind) => root.querySelector(`.kinds input[data-kind="${kind}"]`).checked;
  const selected = () => media.filter((m) => m.checked && kindEnabled(m.kind));
  const updateSaveButton = () => {
    const n = selected().length;
    $(".save").textContent = n ? `Скачать выбранное (${n})` : "Ничего не выбрано";
    $(".save").disabled = !n || busy;
  };

  function renderMedia() {
    const list = $(".medialist");
    list.textContent = "";
    for (const kind of ["image", "svg", "video"]) root.querySelector(".cnt-" + kind).textContent = `(${media.filter((m) => m.kind === kind).length})`;
    for (const item of media) {
      if (!kindEnabled(item.kind)) continue;
      const row = document.createElement("label");
      row.className = "mediarow";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = item.checked;
      cb.addEventListener("change", () => {
        item.checked = cb.checked;
        updateSaveButton();
      });
      let thumb;
      if (item.kind === "svg" && item.text) thumb = svgPreview(item.text, "mediathumb");
      else {
        thumb = document.createElement("div");
        thumb.className = "mediathumb";
        const el = document.createElement(item.kind === "video" ? "video" : "img");
        el.src = item.url;
        if (item.kind === "video") Object.assign(el, { muted: true, preload: "metadata" });
        else el.loading = "lazy";
        thumb.append(el);
      }
      const info = document.createElement("div");
      info.className = "medianame";
      info.textContent = item.name;
      info.title = item.url || item.name;
      const meta = document.createElement("div");
      meta.className = "mediameta";
      meta.textContent = { image: "картинка", svg: "SVG", video: "видео" }[item.kind] + (item.width ? ` · ${item.width}×${item.height}` : "");
      info.append(meta);
      row.append(cb, thumb, info);
      list.append(row);
    }
    updateSaveButton();
  }

  for (const cb of root.querySelectorAll(".kinds input")) cb.addEventListener("change", renderMedia);

  $(".scan").addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    $(".scan").disabled = true;
    try {
      mstatus("Прокрутка страницы (подгружаются отложенные картинки)…");
      const start = window.scrollY;
      const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
      for (let y = 0; y < document.documentElement.scrollHeight && y < 60000; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 120));
      }
      window.scrollTo(0, start);
      await new Promise((r) => setTimeout(r, 500));
      media = scanMedia(host).map((m) => ({ ...m, checked: true }));
      $(".mediabox").classList.remove("hidden");
      mstatus(media.length ? `Найдено файлов: ${media.length}` : "Медиа не найдено", media.length ? "ok" : "");
      renderMedia();
    } catch (e) {
      mstatus("Ошибка: " + (e.message || e), "err");
    } finally {
      busy = false;
      $(".scan").disabled = false;
      updateSaveButton();
    }
  });

  $(".save").addEventListener("click", async () => {
    const items = selected();
    if (!items.length || busy) return;
    busy = true;
    $(".save").disabled = true;
    const folder = downloadsFolder();
    const sub = { image: "images", svg: "svg", video: "video" };
    let done = 0;
    let failed = 0;
    const queue = [...items];
    const worker = async () => {
      for (let item; (item = queue.shift()); ) {
        const url = item.url || "data:image/svg+xml;charset=utf-8," + encodeURIComponent(item.text);
        const r = await send({ type: "download", url, path: `${folder}/${sub[item.kind]}/${cleanFileName(item.name)}` }).catch((e) => ({ error: e.message }));
        if (r?.error) failed++;
        else done++;
        mstatus(`Скачивается: ${done + failed} из ${items.length}…`);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    mstatus(`Готово: ${done} файлов в «Загрузки/${folder}».` + (failed ? ` Не удалось: ${failed}.` : ""), failed ? "err" : "ok");
    busy = false;
    updateSaveButton();
  });

  // ---- Fonts tab ----
  let fontFiles = [];
  const fstatus = (text, cls = "") => {
    $(".fstatus").className = "status fstatus " + cls;
    $(".fstatus").textContent = text;
  };
  const selectedFonts = () => fontFiles.filter((f) => f.checked);
  const updateSaveFonts = () => {
    const n = selectedFonts().length;
    $(".savefonts").textContent = n ? `Скачать выбранное (${n})` : "Ничего не выбрано";
    $(".savefonts").disabled = !n || busy;
  };

  function renderFonts() {
    const list = $(".fontlist");
    list.textContent = "";
    for (const item of fontFiles) {
      const row = document.createElement("label");
      row.className = "mediarow";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = item.checked;
      cb.addEventListener("change", () => {
        item.checked = cb.checked;
        updateSaveFonts();
      });
      const preview = document.createElement("span");
      preview.className = "fontpreview";
      preview.textContent = "Aa";
      preview.style.fontFamily = `"${item.family}"`;
      const info = document.createElement("div");
      info.className = "medianame";
      info.textContent = item.family;
      info.title = `${item.family} · ${item.name}\n${item.url}`;
      const meta = document.createElement("div");
      meta.className = "mediameta";
      meta.textContent = [item.weight, item.style, item.format, item.name].filter(Boolean).join(" · ");
      info.append(meta);
      row.append(cb, preview, info);
      list.append(row);
    }
    updateSaveFonts();
  }

  $(".scanf").addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    $(".scanf").disabled = true;
    try {
      fstatus("Ищу шрифты на странице…");
      fontFiles = (await scanFonts(net)).map((f) => ({ ...f, checked: true }));
      $(".fontsbox").classList.remove("hidden");
      fstatus(fontFiles.length ? `Найдено файлов: ${fontFiles.length}` : "Шрифты не найдены", fontFiles.length ? "ok" : "");
      renderFonts();
    } catch (e) {
      fstatus("Ошибка: " + (e.message || e), "err");
    } finally {
      busy = false;
      $(".scanf").disabled = false;
      updateSaveFonts();
    }
  });

  $(".savefonts").addEventListener("click", async () => {
    const items = selectedFonts();
    if (!items.length || busy) return;
    busy = true;
    $(".savefonts").disabled = true;
    const folder = downloadsFolder() + "/fonts";
    let done = 0;
    let failed = 0;
    const queue = [...items];
    const worker = async () => {
      for (let item; (item = queue.shift()); ) {
        const r = await send({ type: "download", url: item.url, path: `${folder}/${cleanFileName(item.name)}` }).catch((e) => ({ error: e.message }));
        if (r?.error) failed++;
        else done++;
        fstatus(`Скачивается: ${done + failed} из ${items.length}…`);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    fstatus(`Готово: ${done} файлов в «Загрузки/${folder}».` + (failed ? ` Не удалось: ${failed}.` : ""), failed ? "err" : "ok");
    busy = false;
    updateSaveFonts();
  });

  // Toolbar click shows a hidden panel or hides a visible one (never mid-capture).
  const toggle = () => {
    if (host.style.display === "none") host.style.display = "";
    else if (!busy) host.style.display = "none";
  };
  $(".close").addEventListener("click", toggle);
  return { toggle };
}

// Bootstrap last: everything above (styles, helpers) must be initialised first.
if (window.__s2fPanel) {
  window.__s2fPanel.toggle();
} else {
  window.__s2fPanel = createPanel();
}
