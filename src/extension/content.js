// Content script: a small panel on the page (in a shadow root, outside <body>, so it is never
// captured). Runs the in-page pipeline; network and the thumbnail go through background.js.
import { capture } from "../core/pipeline.js";
import { scanMedia } from "./media.js";
import { pickElements, describe } from "./picker.js";
import { scanFonts } from "./fontscan.js";
import { scanBreakpoints } from "./breakpoints.js";
import { mergeMessages, toClipboardHtml, toFigFile } from "../core/post.js";
import { bytesToBase64 } from "../core/bytes.js";


function send(msg) {
  return new Promise((resolve, reject) =>
    chrome.runtime.sendMessage(msg, (r) => (chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(r)))
  );
}

// Stable selector for saving the chosen blocks between panel openings.
function cssPath(el) {
  if (!el || el.nodeType !== 1) return "";
  const escapeId = (id) => (globalThis.CSS?.escape ? CSS.escape(id) : id.replace(/([^\w-])/g, "\\$1"));
  try {
    const parts = [];
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      if (node === document.documentElement) {
        parts.unshift("html");
        break;
      }
      if (node.id) {
        parts.unshift(`#${escapeId(node.id)}`);
        break;
      }
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const same = [...parent.children].filter((c) => c.tagName === node.tagName);
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(node) + 1})` : tag);
      if (node === document.body) break;
    }
    return parts.join(" > ");
  } catch {
    return "";
  }
}

const net = {
  // Same-origin (and CORS-enabled) resources are fetched from the page itself: this keeps
  // the site's own referer/cookies and honours a certificate exception accepted for the tab.
  // Everything else goes through background.js, which has no CORS limits.
  async text(url) {
    try {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch {
      const r = await send({ type: "net", url, kind: "text" });
      if (r.error) throw new Error(r.error);
      return r.text;
    }
  },
  async get(url) {
    try {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { b64: bytesToBase64(bytes), mime: (res.headers.get("content-type") || "application/octet-stream").split(";")[0].trim() };
    } catch {
      const r = await send({ type: "net", url, kind: "bytes" });
      if (r.error) throw new Error(r.error);
      return r;
    }
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
.warn { color: #ffb454; }
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
.targetrow { display: flex; align-items: flex-start; gap: 8px; margin-top: 8px; }
.pickhint { margin-top: 6px; }
.targetinfo { flex: 1; min-width: 0; }
.targetname { display: block; color: #4d8dff; font-size: 12px; }
.targettags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.tag { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; padding: 2px 6px; border-radius: 6px; background: #2c2c29; color: #ececea; font-size: 11px; }
.tag span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag button { flex: none; border: 0; background: transparent; color: #9a9a94; font: inherit; line-height: 1; cursor: pointer; padding: 0 1px; }
.tag button:hover { color: #ff6b6b; }
.toast { position: fixed; left: 50%; bottom: 24px; transform: translate(-50%, 12px); z-index: 2147483647;
  background: #1f1f1d; color: #ececea; border: 1px solid #3a3a36; border-radius: 10px; padding: 10px 16px;
  font: 600 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; box-shadow: 0 8px 30px rgba(0,0,0,.35);
  opacity: 0; pointer-events: none; transition: opacity .18s, transform .18s; }
.toast.show { opacity: 1; transform: translate(-50%, 0); }
.progresswrap { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.progresswrap.hidden, .targetrow.hidden { display: none; }
.progress { flex: 1; height: 4px; border-radius: 2px; background: #161615; overflow: hidden; }
.progress i { display: block; height: 100%; width: 0; background: #4d8dff; transition: width .18s ease; }
.progresswrap .cancel { flex: none; }
.fontpreview { flex: none; width: 42px; height: 38px; display: flex; align-items: center; justify-content: center;
  border-radius: 4px; background: #161615; color: #ececea; font-size: 20px; overflow: hidden; }
.advanced { margin-top: 10px; border-top: 1px solid #3a3a36; padding-top: 8px; }
.advanced summary { display: flex; align-items: center; gap: 6px; cursor: pointer; color: #9a9a94; font-size: 12px; list-style: none; }
.advanced summary::-webkit-details-marker { display: none; }
.advanced summary::before { content: "▸"; color: #4d8dff; }
.advanced[open] summary::before { content: "▾"; }
.advanced-body { padding-top: 2px; }
.advanced.has-settings summary { color: #ececea; }
.advbadge { margin-left: 6px; min-width: 16px; padding: 0 5px; border-radius: 9px; background: #4d8dff;
  color: #fff; font-size: 10px; font-weight: 600; line-height: 16px; text-align: center; }
.advbadge.hidden { display: none; }
.advreset { margin: 2px 0 4px; }
.diag { margin-top: 10px; border-top: 1px solid #3a3a36; padding-top: 8px; font-size: 12px; }
.diag summary { cursor: pointer; color: #ffb454; }
.diaglist { max-height: 180px; overflow: auto; margin-top: 6px; color: #9a9a94; }
.diagrow { padding: 3px 0; word-break: break-word; }
.logbox { margin-top: 10px; max-height: 220px; overflow: auto; border: 1px solid #3a3a36; border-radius: 8px;
  background: #131312; padding: 8px; font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; color: #c8c8c2; }
.logbox.hidden { display: none; }
.logline { white-space: pre-wrap; word-break: break-word; padding: 1px 0; }
.logline.err { color: #ff6b6b; }
.logline.warn { color: #ffb454; }
.logline.ok { color: #3fbf75; }
.widths { margin: 4px 0 6px; font-size: 12px; }
.widthcustom { width: 62px; padding: 3px 6px; border-radius: 5px; border: 1px solid #3a3a36; background: #161615; color: #ececea; font: inherit; }
.widthcustom::-webkit-inner-spin-button { opacity: .5; }
.widthscan { margin-left: 6px; padding: 2px 8px; font-size: 11px; }
.widthcount { color: #4d8dff; }
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
      <div class="muted pickhint">Ctrl+клик — выбрать несколько блоков</div>
      <div class="targetrow hidden">
        <div class="targetinfo"><span class="targetname"></span><div class="targettags"></div></div>
        <button class="small clear">Сбросить</button>
      </div>
      <details class="advanced">
        <summary>Дополнительные настройки <span class="advbadge hidden"></span></summary>
        <div class="advanced-body">
          <button class="small advreset" type="button">Сбросить настройки</button>
          <label><input type="checkbox" class="abs"> Без auto layout</label>
          <label><input type="checkbox" class="exclude"> Исключить блоки</label>
          <label><input type="checkbox" class="logging"> Логирование</label>
          <label><input type="checkbox" class="extrainfo"> Доп. информация</label>
          <label><input type="checkbox" class="tokens"> Токены дизайна</label>
          <div class="muted">Ширины из CSS (медиа-запросы): <span class="widthcount"></span><button class="small widthscan">Найти</button></div>
          <div class="kinds widths widthlist"></div>
          <label>Своя: <input type="number" class="widthcustom" min="200" max="4000" step="1" placeholder="1280"> px</label>
          <div class="hidebox hidden">
            <div class="muted">Убрать перед захватом (CSS-селекторы через запятую):</div>
            <input type="text" class="hide" placeholder="#cookie-banner, .chat-widget">
          </div>
        </div>
      </details>
      <button class="primary go">Захватить всю страницу</button>
      <div class="status"></div>
      <div class="progresswrap hidden"><div class="progress"><i></i></div><button class="small cancel hidden">Остановить</button></div>
      <div class="result hidden">
        <button class="primary copy">Копировать для вставки в Figma</button>
        <button class="secondary download">Скачать .fig</button>
        <div class="svgblock hidden">
          <div class="muted svgnote">SVG с градиентами, тенями или анимацией перенесены картинками (слои «SVG: имя файла»). Чтобы получить векторы: в Figma выделите такой слой, здесь нажмите «Копировать», в Figma — Ctrl+Shift+R (вставить с заменой).</div>
          <div class="svglist"></div>
        </div>
        <details class="diag hidden"><summary>Диагностика</summary><div class="diaglist"></div></details>
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
      <div class="logbox hidden"><div class="loglist"></div></div>
    </div>
    <div class="toast"></div>`;
  document.documentElement.appendChild(host);

  const $ = (s) => root.querySelector(s);
  let logLines = 0;
  const logEnabled = () => Boolean($(".logging")?.checked);
  const updateLogVisibility = () => $(".logbox").classList.toggle("hidden", !logEnabled());
  const clearLog = () => {
    $(".loglist").textContent = "";
    logLines = 0;
  };
  const addLog = (text, cls = "") => {
    if (!text || !logEnabled()) return;
    const line = document.createElement("div");
    line.className = "logline" + (cls ? " " + cls : "");
    line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
    $(".loglist").append(line);
    if (++logLines > 400) $(".loglist").firstElementChild?.remove();
    $(".logbox").scrollTop = $(".logbox").scrollHeight;
  };
  const status = (text, cls = "") => {
    $(".status").className = "status " + cls;
    $(".status").textContent = text;
    addLog(text, cls);
  };
  const showWidth = () => ($(".width").textContent = `Ширина макета: ${document.documentElement.clientWidth}px (ширина окна)`);
  showWidth();
  window.addEventListener("resize", showWidth);

  let result = null;
  let busy = false;
  let targets = [];
  let detectedWidths = [];
  let widthScanTried = false;
  let widthScanning = false;
  let cancelRequested = false;
  let toastTimer = 0;
  const SETTINGS_KEY = "s2fSettings";
  let saveTimer = 0;

  const saveSettings = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const active = root.querySelector(".tabs button.active")?.dataset.tab || "figma";
      chrome.storage?.local?.set({
        [SETTINGS_KEY]: {
          abs: $(".abs").checked,
          exclude: $(".exclude").checked,
          logging: $(".logging").checked,
          extraInfo: $(".extrainfo").checked,
          designTokens: $(".tokens").checked,
          widths: [...root.querySelectorAll(".widths input[data-width]:checked")].map((i) => Number(i.dataset.width)),
          detectedWidths,
          customWidth: $(".widthcustom").value,
          hide: $(".hide").value,
          tab: active,
          targets: targets.map(cssPath).filter(Boolean),
        },
      });
    }, 150);
  };

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
    if (logEnabled()) {
      clearLog();
      addLog("Старт захвата");
    }
    progressValue = 3;
    progressCap = 8;
    cancelRequested = false;
    $(".progresswrap").classList.remove("hidden");
    $(".cancel").classList.remove("hidden");
    $(".cancel").disabled = false;
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
    if (stage && stage[0] === "Прокрутка" && progressValue > 25) {
      progressValue = 8;
      progressCap = 10;
      paintProgress();
    }
    if (stage) progressCap = Math.max(progressCap, stage[1]);
    status(message);
  };
  const stopProgress = (value = 0) => {
    clearInterval(progressTimer);
    clearTimeout(progressHideTimer);
    progressValue = value;
    paintProgress();
  };
  const finishProgress = () => {
    stopProgress(100);
    $(".cancel").classList.add("hidden");
  };
  const hideProgress = (delay = 900) => {
    clearTimeout(progressHideTimer);
    progressHideTimer = setTimeout(() => $(".progresswrap").classList.add("hidden"), delay);
  };
  $(".cancel").addEventListener("click", () => {
    if (!busy || cancelRequested) return;
    cancelRequested = true;
    $(".cancel").disabled = true;
    status("Останавливаю захват…");
  });

  const updateTarget = () => {
    $(".targetrow").classList.toggle("hidden", !targets.length);
    $(".targetname").textContent = targets.length ? (targets.length === 1 ? "Выбранный блок:" : `Выбранные блоки (${targets.length}):`) : "";
    $(".go").textContent = targets.length ? "Захватить выбранные блоки" : "Захватить всю страницу";
    const tags = $(".targettags");
    tags.textContent = "";
    targets.forEach((el, index) => {
      const tag = document.createElement("span");
      tag.className = "tag";
      const name = document.createElement("span");
      name.textContent = describe(el);
      name.title = cssPath(el);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.title = "Убрать блок из выбора";
      remove.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (busy) return;
        targets.splice(index, 1);
        updateTarget();
        saveSettings();
        status(targets.length ? "Блок убран из выбора" : "Будет захвачена вся страница");
      });
      tag.append(name, remove);
      tags.append(tag);
    });
  };

  const updateAdvancedBadge = () => {
    const active = [];
    if ($(".abs").checked) active.push("Без auto layout");
    if ($(".exclude").checked) active.push("Исключить блоки");
    if ($(".logging").checked) active.push("Логирование");
    if ($(".extrainfo").checked) active.push("Доп. информация");
    if ($(".tokens").checked) active.push("Токены дизайна");
    const widths = [...root.querySelectorAll(".widths input[data-width]:checked")].map((i) => i.dataset.width);
    if (widths.length) active.push(`Ширины: ${widths.join(", ")}`);
    const custom = $(".widthcustom").value.trim();
    if (custom) active.push(`Своя ширина: ${custom}`);
    const badge = $(".advbadge");
    badge.textContent = active.length ? String(active.length) : "";
    badge.classList.toggle("hidden", !active.length);
    badge.title = active.join("\n");
    $("details.advanced").classList.toggle("has-settings", active.length > 0);
  };

  const updateHideBox = () => $(".hidebox").classList.toggle("hidden", !$(".exclude").checked);
  $(".exclude").addEventListener("change", () => {
    updateHideBox();
    saveSettings();
    updateAdvancedBadge();
  });
  $(".abs").addEventListener("change", () => {
    saveSettings();
    updateAdvancedBadge();
  });
  $(".logging").addEventListener("change", () => {
    updateLogVisibility();
    saveSettings();
    updateAdvancedBadge();
    if ($(".logging").checked) addLog("Логирование включено");
  });
  $(".extrainfo").addEventListener("change", () => {
    saveSettings();
    updateAdvancedBadge();
  });
  $(".tokens").addEventListener("change", () => {
    saveSettings();
    updateAdvancedBadge();
  });
  $(".widthlist").addEventListener("change", () => {
    saveSettings();
    updateAdvancedBadge();
  });
  $(".widthcustom").addEventListener("input", () => {
    saveSettings();
    updateAdvancedBadge();
  });
  $(".hide").addEventListener("input", saveSettings);
  $(".advreset").addEventListener("click", () => {
    for (const sel of [".abs", ".exclude", ".logging", ".extrainfo", ".tokens"]) $(sel).checked = false;
    for (const input of root.querySelectorAll(".widths input[data-width]")) input.checked = false;
    $(".widthcustom").value = "";
    $(".hide").value = "";
    updateHideBox();
    updateLogVisibility();
    updateAdvancedBadge();
    saveSettings();
    status("Дополнительные настройки сброшены");
  });
  updateHideBox();
  updateAdvancedBadge();

  function renderWidths(selected = []) {
    const list = $(".widthlist");
    list.textContent = "";
    $(".widthcount").textContent = detectedWidths.length ? `(${detectedWidths.length})` : "";
    if (!detectedWidths.length) {
      const empty = document.createElement("span");
      empty.className = "muted";
      empty.textContent = "не найдены";
      list.append(empty);
      updateAdvancedBadge();
      return;
    }
    for (const width of detectedWidths) {
      const label = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.dataset.width = String(width);
      cb.checked = selected.includes(width);
      label.append(cb, document.createTextNode(` ${width}`));
      list.append(label);
    }
    updateAdvancedBadge();
  }

  async function scanCssWidths() {
    if (widthScanning) return;
    widthScanTried = true;
    widthScanning = true;
    $(".widthscan").disabled = true;
    status("Ищу ширины в медиа-запросах…");
    addLog("Сканирую CSS на медиа-запросы…");
    try {
      const found = await scanBreakpoints(net);
      detectedWidths = found;
      renderWidths(found);
      saveSettings();
      if (found.length) {
        const text = `Ширины из CSS: ${found.join(", ")}px`;
        status(text, "ok");
        addLog(text);
      } else {
        status("Медиа-запросы с шириной не найдены");
        addLog("Медиа-запросы с шириной не найдены", "warn");
      }
    } catch (e) {
      status("Ошибка поиска ширин: " + (e.message || e), "err");
      addLog("Ошибка поиска ширин: " + (e.message || e), "err");
    } finally {
      widthScanning = false;
      $(".widthscan").disabled = false;
    }
  }

  $(".widthscan").addEventListener("click", scanCssWidths);
  $("details.advanced").addEventListener("toggle", (e) => {
    if (e.target.open && !widthScanTried && !detectedWidths.length) scanCssWidths();
  });

  // Restore the last options. Selected blocks are saved as CSS selectors and only come
  // back if the same elements still exist on the page.
  chrome.storage?.local?.get(SETTINGS_KEY).then((res) => {
    const saved = res?.[SETTINGS_KEY];
    if (!saved) return;
    $(".abs").checked = Boolean(saved.abs);
    $(".exclude").checked = Boolean(saved.exclude);
    $(".logging").checked = Boolean(saved.logging);
    $(".extrainfo").checked = Boolean(saved.extraInfo);
    $(".tokens").checked = Boolean(saved.designTokens);
    updateLogVisibility();
    if ($(".logging").checked) addLog("Логирование включено");
    detectedWidths = Array.isArray(saved.detectedWidths) ? saved.detectedWidths : Array.isArray(saved.widths) ? saved.widths : [];
    if (detectedWidths.length) widthScanTried = true;
    renderWidths(saved.widths || []);
    $(".widthcustom").value = saved.customWidth || "";
    $(".hide").value = saved.hide || "";
    updateHideBox();
    if (saved.tab) selectTab(saved.tab);
    if (Array.isArray(saved.targets) && saved.targets.length) {
      const els = saved.targets
        .map((sel) => {
          try {
            return document.querySelector(sel);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      if (els.length) {
        targets = els;
        updateTarget();
      }
    }
    updateAdvancedBadge();
  }).catch(() => {});

  // Pick a block on the page. The panel is hidden while the picker overlay is active.
  const startPick = async () => {
    if (busy) return;
    host.style.display = "none";
    await nextFrame();
    let picked = [];
    try {
      picked = await pickElements();
    } finally {
      host.style.display = "";
    }
    if (picked.length) {
      targets = picked;
      updateTarget();
      saveSettings();
      status(picked.length === 1 ? `Выбран блок ${describe(picked[0])}` : `Выбрано блоков: ${picked.length}`, "ok");
    }
  };
  $(".pick").addEventListener("click", startPick);

  $(".clear").addEventListener("click", () => {
    targets = [];
    updateTarget();
    saveSettings();
    status("Будет захвачена вся страница");
  });

  // Screenshot of the top of the page for the .fig thumbnail; the panel is hidden meanwhile.
  async function thumbnail(info) {
    host.style.display = "none";
    await nextFrame();
    try {
      const r = await send({ type: "shot" });
      if (!r.dataUrl) return null;
      const bmp = await createImageBitmap(await (await fetch(r.dataUrl)).blob());
      const BOX = 400;
      const source = info?.width ? { width: info.width, height: info.height } : { width: bmp.width, height: bmp.height };
      const fit = Math.min(BOX / source.width, BOX / source.height);
      const w = Math.max(1, Math.round(source.width * fit));
      const h = Math.max(1, Math.round(source.height * fit));
      const canvas = new OffscreenCanvas(w, h);
      const scale = Math.max(w / bmp.width, h / bmp.height);
      const dw = bmp.width * scale;
      const dh = bmp.height * scale;
      canvas.getContext("2d").drawImage(bmp, (w - dw) / 2, 0, dw, dh);
      bmp.close?.();
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

  async function applyViewport(width) {
    const height = Math.max(600, Math.round(window.innerHeight));
    const res = await send({ type: "emulate-width", width, height }).catch((e) => ({ error: String(e.message || e) }));
    if (res?.error) {
      const reason = /another debugger/i.test(res.error) ? "закройте DevTools на этой вкладке и повторите" : res.error;
      throw new Error(`Не удалось задать ширину ${width}px: ${reason}`);
    }
    await new Promise((r) => setTimeout(r, 400));
    const actual = Math.round(window.innerWidth);
    if (Math.abs(actual - width) > 2) throw new Error(`Ширина ${width}px не применилась (получилось ${actual}px)`);
  }

  async function blankThumbnail(width, height) {
    const fit = Math.min(400 / Math.max(1, width), 400 / Math.max(1, height));
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(width * fit)), Math.max(1, Math.round(height * fit)));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#f5f5f5";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
  }

  const stop = () => {
    if (!cancelRequested) return;
    const error = new Error("Захват отменён");
    error.name = "AbortError";
    throw error;
  };

  // One capture per width, merged side by side into a single .fig.
  async function captureWidths(widths) {
    const results = [];
    const parts = [];
    const logs = [];
    let totalWidth = 0;
    let totalHeight = 0;
    const gap = 80;
    try {
      for (const width of widths) {
        stop();
        status(`Ширина ${width}px…`);
        progressValue = Math.min(progressValue, 8);
        progressCap = 10;
        paintProgress();
        try {
          await applyViewport(width);
          stop();
          const r = await capture(
            {
              layout: $(".abs").checked ? "absolute" : "auto",
              hideSelectors: $(".exclude").checked ? $(".hide").value : "",
              targets: targets.length ? targets : undefined,
              extraInfo: $(".extrainfo").checked,
              designTokens: $(".tokens").checked,
              shouldCancel: () => cancelRequested,
            },
            { net, thumbnail, captureViewport, bundledFont, progress: (m) => stageProgress(m) }
          );
          results.push(r);
          parts.push({ message: r.debug.message, x: totalWidth, y: 0 });
          totalWidth += r.width + gap;
          totalHeight = Math.max(totalHeight, r.height);
          logs.push(...r.log);
        } catch (e) {
          if (e?.name === "AbortError") throw e;
          logs.push(`Ширина ${width}px: ${e.message || e}`);
          addLog(`Ширина ${width}px: ${e.message || e}`, "err");
        }
      }
      stop();
      if (!results.length) throw new Error("Не удалось захватить ни одной ширины");
      totalWidth = Math.max(1, totalWidth - gap);
      totalHeight = Math.max(1, totalHeight);
      const first = results[0];
      const message = mergeMessages(parts);
      const name = `${document.title || location.hostname} — ${results.map((r) => r.width).join(" / ")}px`;
      const shot = (await thumbnail({ width: totalWidth, height: totalHeight }).catch(() => null)) || (await blankThumbnail(totalWidth, totalHeight));
      return {
        ...first,
        name,
        width: totalWidth,
        height: totalHeight,
        nodes: results.reduce((n, r) => n + r.nodes, 0),
        images: results.reduce((n, r) => n + r.images, 0),
        clipboardHtml: toClipboardHtml(message),
        fig: toFigFile(message, { name, width: totalWidth, height: totalHeight, thumbnail: shot }),
        log: [...new Set(logs)],
        debug: {
          ...first.debug,
          message,
          failures: results.flatMap((r) => r.debug.failures || []),
          imageFailures: results.flatMap((r) => r.debug.imageFailures || []),
          fontFailures: results.flatMap((r) => r.debug.fontFailures || []),
          fixes: results.reduce((acc, r) => {
            for (const [k, v] of Object.entries(r.debug.fixes || {})) if (typeof v === "number") acc[k] = (acc[k] || 0) + v;
            return acc;
          }, {}),
        },
      };
    } finally {
      await send({ type: "emulate-clear" }).catch(() => null);
    }
  }

  const runCapture = async () => {
    if (busy) return;
    if (targets.some((t) => !t.isConnected)) {
      targets = targets.filter((t) => t.isConnected);
      updateTarget();
    }
    busy = true;
    result = null;
    $(".go").disabled = true;
    $(".result").classList.add("hidden");
    startProgress();
    const t0 = Date.now();
    try {
      const widths = [...root.querySelectorAll(".widths input[data-width]:checked")].map((i) => Number(i.dataset.width));
      const custom = Number($(".widthcustom").value);
      if (Number.isFinite(custom) && custom >= 200 && custom <= 4000 && !widths.includes(custom)) widths.push(custom);
      if (widths.length) {
        result = await captureWidths(widths);
      } else {
        result = await capture(
          {
            layout: $(".abs").checked ? "absolute" : "auto",
            hideSelectors: $(".exclude").checked ? $(".hide").value : "",
            targets: targets.length ? targets : undefined,
            extraInfo: $(".extrainfo").checked,
            designTokens: $(".tokens").checked,
            shouldCancel: () => cancelRequested,
          },
          { net, thumbnail, captureViewport, bundledFont, progress: (m) => stageProgress(m) }
        );
      }
      finishProgress();
      for (const line of result.log || []) addLog(line, /Не удалось|Не загрузились/.test(line) ? "warn" : "");
      console.info("site2figma: capture", JSON.stringify(result.debug.fixes), "fonts", JSON.stringify(result.debug.fonts));
      const notes = result.log.filter((line) => !/Не удалось|Не загрузились/.test(line)).join(" ");
      const summary = `Готово за ${Math.round((Date.now() - t0) / 1000)} с: ${result.width}px, ${result.nodes} слоёв, ${result.images} картинок, ${(result.fig.length / 1048576).toFixed(1)} МБ.`;
      $(".result").classList.remove("hidden");
      renderSvgList();
      renderDiagnostics();
      status(`${summary} Копирую в буфер…`);
      const copied = await copyHtml(result.clipboardHtml).catch(() => false);
      if (copied) {
        status(`${summary} Скопировано в буфер — Ctrl+V в Figma.${notes ? " " + notes : ""}`, "ok");
        toast("Скопировано в буфер обмена — Ctrl+V в Figma");
        $(".copy").textContent = "Скопировано — Ctrl+V в Figma";
        setTimeout(() => ($(".copy").textContent = "Копировать для вставки в Figma"), 3200);
      } else {
        status(`${summary} Не удалось скопировать автоматически — нажмите «Копировать для вставки в Figma».`, "err");
        toast("Не удалось скопировать автоматически — нажмите «Копировать для вставки в Figma»");
      }
      hideProgress(1200);
    } catch (e) {
      if (e?.name === "AbortError") {
        stopProgress(0);
        $(".progresswrap").classList.add("hidden");
        status("Захват отменён", "warn");
      } else {
        console.error("site2figma", e);
        stopProgress(0);
        $(".progresswrap").classList.add("hidden");
        status("Ошибка: " + (e.message || e), "err");
        if (e?.stack) addLog(String(e.stack), "err");
      }
    } finally {
      busy = false;
      $(".go").disabled = false;
    }
  };
  $(".go").addEventListener("click", runCapture);

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

  function renderDiagnostics() {
    const d = result?.debug || {};
    const rows = [
      ...(d.failures || []).map((x) => ["Элемент", x]),
      ...(d.imageFailures || []).map((x) => ["Картинка", x]),
      ...(d.fontFailures || []).map((x) => ["Шрифт", x]),
    ];
    const box = $(".diag");
    box.classList.toggle("hidden", !rows.length);
    box.open = rows.length > 0;
    box.querySelector("summary").textContent = rows.length ? `Ошибки при конвертации (${rows.length})` : "Диагностика";
    const list = $(".diaglist");
    list.textContent = "";
    for (const [kind, text] of rows) {
      const row = document.createElement("div");
      row.className = "diagrow";
      row.textContent = `${kind}: ${text}`;
      list.append(row);
      addLog(`${kind}: ${text}`, "err");
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
  const selectTab = (name) => {
    for (const b of root.querySelectorAll(".tabs button")) b.classList.toggle("active", b.dataset.tab === name);
    for (const t of root.querySelectorAll(".tab")) t.classList.toggle("hidden", !t.classList.contains("tab-" + name));
  };
  for (const btn of root.querySelectorAll(".tabs button")) {
    btn.addEventListener("click", () => {
      selectTab(btn.dataset.tab);
      saveSettings();
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
    addLog(text, cls);
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
    addLog(text, cls);
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
  return {
    toggle,
    capture: () => {
      host.style.display = "";
      runCapture();
    },
    pick: () => {
      host.style.display = "";
      startPick();
    },
  };
}

// Bootstrap last: everything above (styles, helpers) must be initialised first.
if (!window.__s2fPanel) window.__s2fPanel = createPanel();
if (!window.__s2fMessages) {
  window.__s2fMessages = true;
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "s2f-ping") {
      sendResponse({ ok: true });
      return;
    }
    const panel = window.__s2fPanel;
    if (!panel) return;
    if (msg.type === "s2f-toggle") panel.toggle();
    else if (msg.type === "s2f-capture") panel.capture();
    else if (msg.type === "s2f-pick") panel.pick();
  });
}
