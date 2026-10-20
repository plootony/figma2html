// The whole capture, running inside the page: prepare the DOM, convert it with
// dom-to-figma, post-process the message and build the clipboard HTML and the .fig file.
// Used by the Chrome extension (content script) and by the local server (headless Chrome).
//
// env = {
//   net: { text(url) → string, get(url) → { b64, mime } }   // network without CORS limits
//   thumbnail?: () → Promise<Uint8Array PNG>                 // optional page screenshot
//   captureViewport?: () → Promise<ImageBitmap>               // screenshots of canvas/video
//   bundledFont?: (weight) → Promise<base64>                  // Inter shipped with the extension
//   progress?: (message) → void
// }
import { createFigmaConverter } from "@figit/dom-to-figma";
import { base64ToBytes } from "./bytes.js";
import { createFontLoader, charsetOf, resolveStack, parseFontFaces, firstFamily } from "./fonts.js";
import { addBackgroundImages, hasUrlBackground } from "./backgrounds.js";
import { prepareSvgImages, resolveSvgUses, rasterizeSvg, isSvgUrl, fileName } from "./svg.js";
import { snapshotMediaElements, applySnapshots } from "./snapshots.js";
import { zipSync, strToU8 } from "fflate";
import { decodePayload, sanitize, fixBlankGlyphs, fixTextLayout, fixAutoLayoutSizing, fixSiblingOrder, setPrototypeDevice, shiftTextBox, optimizeImages, stats, toClipboardHtml, toFigFile } from "./post.js";

// Elements that never paint themselves (the converter tried to turn <source> into a frame and failed).
const NON_RENDERED = new Set(["source", "track", "param", "area", "map", "datalist", "option", "optgroup", "base", "wbr"]);
const ICON_FONT = /icon|awesome|lucide|material|symbol|glyph|feather|remix|ionic|dashicons|^fa[-\s]/i;
const TEXT_CHAR = /[\p{L}\p{N}]/u;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Every inline-style change made for the capture is recorded and rolled back afterwards,
// so the live page (extension) is left as it was.
export function createStyleJournal() {
  const saved = new Map(); // element -> Map(prop -> [value, priority])
  const added = [];
  const undos = [];
  return {
    set(el, prop, value) {
      let props = saved.get(el);
      if (!props) saved.set(el, (props = new Map()));
      if (!props.has(prop)) props.set(prop, [el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)]);
      el.style.setProperty(prop, value, "important");
    },
    add(node) {
      added.push(node);
    },
    undo(fn) {
      undos.push(fn);
    },
    restore() {
      for (const node of added) node.remove();
      for (const fn of undos.reverse()) fn();
      for (const [el, props] of saved) for (const [prop, [v, p]] of props) v ? el.style.setProperty(prop, v, p) : el.style.removeProperty(prop);
    },
  };
}

const ownText = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("");
const isTextElement = (el) =>
  TEXT_CHAR.test(ownText(el)) || ((el.tagName === "INPUT" || el.tagName === "TEXTAREA") && el.placeholder);

// Scroll through the page so lazy-loaded images and sections render.
async function autoScroll() {
  const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
  for (let y = 0; y < document.documentElement.scrollHeight && y < 60000; y += step) {
    window.scrollTo(0, y);
    await wait(120);
  }
  window.scrollTo(0, 0);
  await wait(300);
}

// ::before / ::after are invisible to the converter (it walks real DOM nodes). Each rendered
// pseudo-element becomes a temporary real element with the pseudo's computed style copied
// inline, and the pseudo itself is switched off — same rendering, now convertible.
// Everything is rolled back after the capture.
const NO_PSEUDO = new Set(["IMG", "INPUT", "TEXTAREA", "SELECT", "BR", "HR", "IFRAME", "VIDEO", "AUDIO", "CANVAS", "SVG", "OBJECT", "EMBED", "SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"]);
const SKIP_PROPS = /^(content|counter-|transition|animation|will-change|quotes$)/;

// Text of a computed `content` value: strings, attr(), open/close quotes; counters are dropped.
function pseudoContent(value, host) {
  if (!value || value === "none" || value === "normal") return null;
  const url = value.match(/^url\((["']?)(.*?)\1\)$/);
  if (url) return { image: url[2] };
  let text = "";
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|attr\(\s*([\w-]+)\s*\)|(open-quote)|(close-quote)|counters?\([^)]*\)|\S+/g;
  for (const m of value.matchAll(re)) {
    if (m[1] !== undefined || m[2] !== undefined) text += (m[1] ?? m[2]).replace(/\\(.)/g, "$1");
    else if (m[3]) text += host.getAttribute(m[3]) || "";
    else if (m[4]) text += "\u201c";
    else if (m[5]) text += "\u201d";
  }
  return { text };
}

export function materializePseudoElements(journal) {
  const hideRule = document.createElement("style");
  hideRule.textContent =
    "[data-s2f-before]::before{content:none!important;display:none!important}[data-s2f-after]::after{content:none!important;display:none!important}";
  const created = [];
  for (const host of document.querySelectorAll("body, body *")) {
    if (NO_PSEUDO.has(host.tagName.toUpperCase()) || host.closest("svg")) continue;
    for (const which of ["before", "after"]) {
      const cs = getComputedStyle(host, "::" + which);
      if (cs.display === "none") continue;
      const content = pseudoContent(cs.content, host);
      if (!content) continue;
      const el = document.createElement(content.image ? "img" : "s2f-pseudo");
      if (content.image) el.src = content.image;
      else if (content.text) el.textContent = content.text;
      for (const prop of cs) {
        if (!SKIP_PROPS.test(prop)) el.style.setProperty(prop, cs.getPropertyValue(prop), "important");
      }
      el.dataset.s2fPseudo = which;
      created.push({ host, which, el });
    }
  }
  if (!created.length) return 0;
  // Insert all at once after reading styles, so earlier insertions don't change later reads.
  document.head.appendChild(hideRule);
  journal.add(hideRule);
  for (const { host, which, el } of created) {
    host.setAttribute(`data-s2f-${which}`, "");
    if (which === "before") host.insertBefore(el, host.firstChild);
    else host.appendChild(el);
    journal.add(el);
    journal.undo(() => host.removeAttribute(`data-s2f-${which}`));
  }
  return created.length;
}

// All @font-face rules of the page; cross-origin stylesheets are fetched via env.net.
async function collectFontFaces(net) {
  const inline = [];
  const external = [];
  const walk = (sheet) => {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      if (sheet.href) external.push(sheet.href);
      return;
    }
    const base = sheet.href || document.baseURI;
    for (const r of rules) {
      if (r.type === CSSRule.FONT_FACE_RULE) inline.push(...parseFontFaces(r.cssText, base));
      else if (r.type === CSSRule.IMPORT_RULE && r.styleSheet) walk(r.styleSheet);
      else if (r.cssRules) for (const sub of r.cssRules) if (sub.type === CSSRule.FONT_FACE_RULE) inline.push(...parseFontFaces(sub.cssText, base));
    }
  };
  for (const sheet of document.styleSheets) walk(sheet);
  for (const href of external) {
    try {
      inline.push(...parseFontFaces(await net.text(href), href));
    } catch {}
  }
  return inline;
}

// Fonts Figma doesn't have (not on Google Fonts: SF Pro, Motiva Sans, Arial, Times…) are
// replaced with similar Google fonts in the page itself, so the browser layout and the
// Figma file use the same, available font. Icon fonts are left alone.
async function substituteFonts(chars, fonts, journal, bundledFont) {
  const stacks = new Set();
  for (const el of document.querySelectorAll("body, body *")) if (isTextElement(el)) stacks.add(getComputedStyle(el).fontFamily);
  const plan = {};
  for (const stack of stacks) {
    const first = firstFamily(stack);
    if (ICON_FONT.test(first)) continue;
    const target = await resolveStack(stack, chars, fonts);
    if (target !== first) plan[stack] = target;
  }
  const targets = [...new Set(Object.values(plan))];
  if (!targets.length) return [];

  const spec = "100,200,300,400,500,600,700,800,900,100i,200i,300i,400i,500i,600i,700i,800i,900i";
  await Promise.all(
    targets.map(
      (fam) =>
        new Promise((resolve) => {
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.href = `https://fonts.googleapis.com/css?family=${encodeURIComponent(fam)}:${spec}&display=block`;
          link.onload = link.onerror = resolve;
          setTimeout(resolve, 8000); // never hang on a stalled stylesheet request
          document.head.appendChild(link);
          journal.add(link);
        })
    )
  );
  for (const el of document.querySelectorAll("body, body *")) {
    const target = plan[getComputedStyle(el).fontFamily];
    if (target) journal.set(el, "font-family", `"${target}"`);
  }
  document.body.offsetHeight; // force layout so the browser requests the new fonts
  await Promise.race([document.fonts.ready, wait(8000)]);
  // Google Fonts unreachable: give the page the bundled Inter (loaded from bytes, no network,
  // not subject to the page's CSP), so the page and the Figma file are laid out alike.
  const interLoaded = [...document.fonts].some((f) => f.family.replace(/["']/g, "") === "Inter" && f.status === "loaded");
  if (targets.includes("Inter") && bundledFont && !interLoaded) {
    console.info("site2figma: Google Fonts unreachable, using bundled Inter in the page");
    for (const weight of [300, 400, 500, 600, 700]) {
      try {
        const b64 = await bundledFont(weight);
        if (!b64) continue;
        const face = new FontFace("Inter", base64ToBytes(b64), { weight: String(weight) });
        await face.load();
        document.fonts.add(face);
        journal.undo(() => document.fonts.delete(face));
      } catch {}
    }
    document.body.offsetHeight;
  }
  return [...new Set(Object.entries(plan).map(([stack, t]) => `${firstFamily(stack)} → ${t}`))];
}

// Make typography explicit before conversion, so the converter reads exact values:
// - `line-height: normal` depends on font metrics (the converter would assume 1.2 × size):
//   measured in the browser and pinned in px;
// - logical/vendor text-align values (start, end, -webkit-center) → physical ones;
// - letter/word spacing in % or em → px (the converter would read "40%" as 40px).
function normalizeTypography(journal) {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:absolute;left:-10000px;top:0;display:block;white-space:nowrap;line-height:normal;padding:0;border:0;margin:0;";
  probe.textContent = "Hg";
  document.body.appendChild(probe);
  const cache = new Map();
  const normalLineHeight = (cs) => {
    const key = [cs.fontFamily, cs.fontSize, cs.fontWeight, cs.fontStyle, cs.fontStretch].join("|");
    if (!cache.has(key)) {
      Object.assign(probe.style, {
        fontFamily: cs.fontFamily,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        fontStyle: cs.fontStyle,
        fontStretch: cs.fontStretch,
      });
      cache.set(key, probe.getBoundingClientRect().height);
    }
    return cache.get(key);
  };
  const ALIGN = { start: "left", "-webkit-left": "left", end: "right", "-webkit-right": "right", "-webkit-center": "center" };
  for (const el of document.querySelectorAll("body, body *")) {
    if (el === probe || !isTextElement(el)) continue;
    const cs = getComputedStyle(el);
    const fontSize = parseFloat(cs.fontSize);
    for (const prop of ["letter-spacing", "word-spacing"]) {
      const m = /^(-?[\d.]+)(%|em)$/.exec(cs.getPropertyValue(prop));
      if (m) {
        const px = m[2] === "%" ? (parseFloat(m[1]) / 100) * fontSize : parseFloat(m[1]) * fontSize;
        journal.set(el, prop, px + "px");
      }
    }
    if (cs.lineHeight === "normal") {
      journal.set(el, "line-height", normalLineHeight(cs) + "px");
    }
    const align = ALIGN[cs.textAlign];
    if (align && !(align === "left" && cs.textAlign === "start" && cs.direction !== "rtl")) {
      const physical = cs.direction === "rtl" && align !== "center" ? (align === "left" ? "right" : "left") : align;
      journal.set(el, "text-align", physical);
    }
  }
  probe.remove();
}

// The converter takes text nodes verbatim, but the browser collapses whitespace per CSS
// `white-space`: source formatting like "сердца!\n\n            Новые" renders as one space.
// Verbatim, the extra spaces and newlines broke the converter's line layout (lines running
// out of their box, words split). Collapse them in the DOM the way the browser renders them.
function collapseWhitespace(journal) {
  let changed = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node; (node = walker.nextNode()); ) {
    const text = node.textContent;
    if (!/[ \t\n\r\f]{2}|[\t\n\r\f]/.test(text)) continue;
    const el = node.parentElement;
    if (!el || el.closest("svg, script, style, textarea")) continue;
    const ws = getComputedStyle(el).whiteSpaceCollapse || getComputedStyle(el).whiteSpace;
    let next;
    if (ws === "collapse" || ws === "normal" || ws === "nowrap") next = text.replace(/[ \t\n\r\f]+/g, " ");
    else if (ws === "preserve-breaks" || ws === "pre-line") next = text.replace(/[ \t\f]+/g, " ").replace(/ ?\r?\n ?/g, "\n");
    else continue; // pre, pre-wrap, break-spaces: whitespace is meaningful
    if (next === text) continue;
    node.textContent = next;
    journal.undo(() => (node.textContent = text));
    changed++;
  }
  return changed;
}

const lineRects = (node) => {
  const range = document.createRange();
  range.selectNodeContents(node);
  return [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0);
};

// Wrap box for a multi-line text, called from the patched converter (see build.mjs): the
// content box of its block container — where the browser wraps lines. Only when no line
// of the text is shared with other content of the block (text after a <br> qualifies).
globalThis.__s2fTextBox = (node) => {
  const el = node.nodeType === 3 ? node.parentElement : node;
  let block = el;
  while (block && block !== document.body && /^(inline|contents)/.test(getComputedStyle(block).display)) block = block.parentElement;
  if (!block) return null;
  const own = lineRects(node);
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const t = walker.currentNode;
    if (node.contains(t) || !t.textContent.trim()) continue;
    for (const r of lineRects(t)) if (own.some((o) => Math.min(o.bottom, r.bottom) - Math.max(o.top, r.top) > 1)) return null;
  }
  const cs = getComputedStyle(block);
  const r = block.getBoundingClientRect();
  const px = (v) => parseFloat(v) || 0;
  const left = r.left + px(cs.borderLeftWidth) + px(cs.paddingLeft);
  const width = r.width - px(cs.borderLeftWidth) - px(cs.borderRightWidth) - px(cs.paddingLeft) - px(cs.paddingRight);
  const nodeLeft = node.nodeType === 3 ? (() => { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect().left; })() : node.getBoundingClientRect().left;
  return width > 0 ? { dx: left - nodeLeft, width } : null;
};

// Character index of each laid-out glyph, used by the patched converter (see build.mjs):
// glyphs follow the text in order, skipping only the spaces dropped at line breaks.
globalThis.__s2fGlyphCharIndexes = (text, positions) => {
  const out = [];
  let p = 0;
  for (const pos of positions) {
    const c = pos.character || "";
    let q = c ? text.indexOf(c, p) : -1;
    if (q < 0) q = p;
    out.push(q);
    p = q + Math.max(1, c.length);
  }
  return out;
};

// The converter puts a text box's top at the glyphs' content area; CSS (and Figma, once it
// re-lays the text out, e.g. after a font swap) start from the line box, which differs when
// line-height ≠ content height. Move boxes to the CSS line box using the DOM rects.
function alignTextBoxesToLineBox(message, trace, rootTop) {
  const byId = new Map(message.nodeChanges.map((n) => [`${n.guid.sessionID}:${n.guid.localID}`, n]));
  const parentOf = (n) => n.parentIndex && byId.get(`${n.parentIndex.guid.sessionID}:${n.parentIndex.guid.localID}`);
  const absY = (n) => {
    let y = 0;
    for (let c = n; c && c.type !== "CANVAS"; c = parentOf(c)) y += c.transform?.m12 || 0;
    return y;
  };
  const pathCount = new Map();
  for (const e of trace.entries) pathCount.set(e.domPath, (pathCount.get(e.domPath) || 0) + 1);
  let moved = 0;
  for (const e of trace.entries) {
    if (e.kind !== "text" || pathCount.get(e.domPath) > 1) continue; // split segments: skip
    const n = byId.get(`${e.guid.sessionID}:${e.guid.localID}`);
    if (!n || n.type !== "TEXT" || !n.transform || !n.size) continue;
    const lh = n.lineHeight?.units === "PIXELS" ? n.lineHeight.value : 0;
    if (!(lh > 0)) continue;
    const lines = n.derivedTextData?.baselines?.length || 1;
    const contentHeight = e.rect.height - (lines - 1) * lh;
    const lineTop = e.rect.y - rootTop - (lh - contentHeight) / 2;
    const dy = lineTop - absY(n);
    // Large offsets come from cases this model doesn't cover (e.g. vertical-align on an
    // inline element): leave those as the converter placed them.
    if (Math.abs(dy) < 0.25 || Math.abs(dy) > lh / 2) continue;
    shiftTextBox(n, dy, lines * lh);
    moved++;
  }
  return moved;
}

// position: fixed / sticky → Figma's prototype scroll behavior ("Fixed" / "Sticky").
// Resolved through the trace, while the prepared DOM is still in place.
const resolveTraceElement = (domPath) => (domPath === ":scope" ? document.body : document.body.querySelector(domPath));

function markScrollBehavior(message, trace) {
  const byId = new Map(message.nodeChanges.map((n) => [`${n.guid.sessionID}:${n.guid.localID}`, n]));
  let marked = 0;
  for (const e of trace.entries) {
    if (e.domPath.includes("::text")) continue;
    const el = resolveTraceElement(e.domPath);
    if (!el) continue;
    const pos = getComputedStyle(el).position;
    if (pos !== "fixed" && pos !== "sticky") continue;
    const n = byId.get(`${e.guid.sessionID}:${e.guid.localID}`);
    if (!n) continue;
    n.scrollBehavior = pos === "fixed" ? "FIXED_WHEN_CHILD_OF_SCROLLING_FRAME" : "STICKY_SCROLLS";
    marked++;
  }
  return marked;
}

// Image layers made from complex SVG files are named after the file (the original is in svgZip).
function nameSvgImages(message, trace, originals) {
  const byId = new Map(message.nodeChanges.map((n) => [`${n.guid.sessionID}:${n.guid.localID}`, n]));
  let named = 0;
  for (const e of trace.entries) {
    if (e.kind !== "image") continue;
    const el = resolveTraceElement(e.domPath);
    const url = el && (el.currentSrc || el.src);
    const n = byId.get(`${e.guid.sessionID}:${e.guid.localID}`);
    if (!n || !url || !originals.has(url)) continue;
    n.name = `SVG: ${fileName(url)}`;
    named++;
  }
  return named;
}

// Downscale with canvas: to `outside` fit of tw×th, JPEG unless the image has transparency.
async function resizeImage(bytes, tw, th) {
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return null; // GIF: keep animation
  const bmp = await createImageBitmap(new Blob([bytes]));
  const tooBig = bmp.width > tw * 1.15 && bmp.height > th * 1.15;
  if (!tooBig && bytes.length < 300_000) return null;
  const scale = tooBig ? Math.max(tw / bmp.width, th / bmp.height) : 1;
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const data = ctx.getImageData(0, 0, w, h).data;
  let alpha = false;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) { alpha = true; break; }
  const blob = await canvas.convertToBlob(alpha ? { type: "image/png" } : { type: "image/jpeg", quality: 0.85 });
  return new Uint8Array(await blob.arrayBuffer());
}

// Plain thumbnail when no screenshot is available (Figma requires thumbnail.png).
async function placeholderThumbnail(width, height) {
  const canvas = new OffscreenCanvas(400, Math.max(1, Math.round((400 * height) / width)));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = getComputedStyle(document.body).backgroundColor || "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
}

export async function capture(options, env) {
  // keepModified: leave the prepared DOM in place (verify.mjs inspects it); call the
  // returned `restore()` afterwards.
  const { layout = "auto", hideSelectors = "", scroll = true, freezeAnimations = true, keepModified = false } = options;
  const progress = env.progress || (() => {});
  const net = env.net;
  const fonts = createFontLoader(net, env.bundledFont);
  const journal = createStyleJournal();
  const log = [];
  const t0 = Date.now();
  const startScroll = window.scrollY;
  try {
    if (freezeAnimations) {
      // Elements are captured in their final state, not mid-animation.
      const style = document.createElement("style");
      style.textContent = "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important;scroll-behavior:auto!important}";
      document.head.appendChild(style);
      journal.add(style);
    }
    if (scroll) {
      progress("Прокрутка страницы…");
      await autoScroll();
    }
    await Promise.race([document.fonts.ready, wait(5000)]);

    for (const sel of hideSelectors.split(",").map((s) => s.trim()).filter(Boolean)) {
      try {
        document.querySelectorAll(sel).forEach((el) => journal.set(el, "display", "none"));
      } catch {}
    }

    // Before any DOM changes: temporary elements carry inline !important styles that the
    // "hide everything else" rule of the snapshot can't override.
    progress("Снимки canvas/видео…");
    const snapshots = await snapshotMediaElements(env.captureViewport);

    const pseudo = materializePseudoElements(journal);
    const whitespace = collapseWhitespace(journal);
    progress("SVG…");
    const svgUses = await resolveSvgUses(journal, net);
    const svgs = await prepareSvgImages(journal, net);

    progress("Шрифты…");
    let text = "";
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) text += walker.currentNode.textContent;
    document.querySelectorAll("input, textarea").forEach((el) => (text += (el.placeholder || "") + (el.value || "")));
    const chars = charsetOf(text);
    const pageFaces = await collectFontFaces(net);
    const substitutions = await substituteFonts(chars, fonts, journal, env.bundledFont);
    if (substitutions.length) log.push("Замена шрифтов: " + substitutions.join(", "));
    normalizeTypography(journal);

    const width = document.documentElement.clientWidth;
    const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    const viewportHeight = Math.max(1, Math.round(window.innerHeight));
    const name = `${document.title || location.hostname} — ${width}px`;
    window.scrollTo(0, 0);
    const thumbnail = (env.thumbnail && (await env.thumbnail().catch(() => null))) || (await placeholderThumbnail(width, Math.min(height, width * 0.625)));

    progress("Конвертация…");
    const fontSources = new Map();
    const converter = createFigmaConverter({
      layout,
      trace: true,
      // A text-only element with a background image must stay a frame, or the image is lost.
      classify: (el, kind) =>
        NON_RENDERED.has(el.tagName.toLowerCase()) ? "skip" : kind === "text" && hasUrlBackground(el) ? "frame" : kind,
      fontLoader: async (req) => {
        const r = await fonts.load(req, chars, pageFaces);
        fontSources.set(`${req.family} ${req.weight}${req.italic ? "i" : ""}`, r.error ? "нет" : r.source);
        if (r.error) throw new Error(r.error);
        return { bytes: base64ToBytes(r.b64).buffer, resolvedWeight: r.weight, resolvedItalic: r.italic, ...(r.family && { resolvedFamily: r.family }) };
      },
      imageLoader: async ({ src, element }) => {
        let bytes, mimeType;
        if (src.startsWith("data:")) {
          const res = await fetch(src);
          bytes = new Uint8Array(await res.arrayBuffer());
          mimeType = res.headers.get("content-type") || "image/png";
        } else {
          const r = await net.get(src);
          bytes = base64ToBytes(r.b64);
          mimeType = r.mime;
        }
        if (mimeType.includes("svg") || isSvgUrl(src)) {
          // Complex SVG kept as an image: rasterise at 2× its displayed size, not its natural size.
          const rect = element.getBoundingClientRect();
          bytes = await rasterizeSvg(bytes, rect.width || 100, rect.height || 100);
          mimeType = "image/png";
        }
        return { bytes: bytes.buffer, mimeType };
      },
    });
    globalThis.__s2fErrors = [];
    const rootTop = document.body.getBoundingClientRect().top;
    const result = await converter.convert({ element: document.body, width, height, name });

    // Elements the converter failed on (kept as plain frames with their content).
    const failures = (globalThis.__s2fErrors || []).map(({ node, error }) => {
      const el = node.nodeType === 1 ? node : node.parentElement;
      const cls = el && typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
      return `${el ? el.tagName.toLowerCase() + cls : "#text"}: ${String(error?.message || error).slice(0, 160)}`;
    });
    if (failures.length) {
      log.push(`Не удалось полностью перенести элементов: ${failures.length} (их содержимое сохранено). Первая ошибка — ${failures[0]}`);
      console.warn("site2figma: conversion errors", failures);
    }

    progress("Обработка…");
    const message = decodePayload(result.base64);
    const fixes = {
      nan: sanitize(message),
      glyphs: fixBlankGlyphs(message),
      lineBoxes: alignTextBoxesToLineBox(message, result.trace, rootTop),
      pseudo,
      whitespace,
      backgrounds: await addBackgroundImages(message, result.trace, net, resolveTraceElement),
      svgInlined: svgs.inlined,
      svgUses,
      snapshots: applySnapshots(message, result.trace, snapshots, resolveTraceElement),
      svgNamed: nameSvgImages(message, result.trace, svgs.originals),
      hugWithFill: fixAutoLayoutSizing(message),
      siblingGroups: fixSiblingOrder(message),
      scrollBehavior: markScrollBehavior(message, result.trace),
      prototypeDevice: setPrototypeDevice(message, { width, height: viewportHeight }),
    };
    fixTextLayout(message);
    const images = await optimizeImages(message, resizeImage);

    // Originals of the SVGs kept as images, for dropping into Figma by hand.
    const svgFiles = {};
    for (const { name, text } of svgs.originals.values()) {
      let unique = name;
      for (let i = 2; svgFiles[unique]; i++) unique = name.replace(/(\.svg)?$/i, `-${i}.svg`);
      svgFiles[unique] = strToU8(text);
    }
    const svgZip = Object.keys(svgFiles).length ? zipSync(svgFiles) : null;

    const clipboardHtml = toClipboardHtml(message);
    const fig = toFigFile(message, { name, thumbnail, width, height });
    return {
      name,
      width,
      height,
      fig,
      clipboardHtml,
      svgZip,
      svgCount: svgs.originals.size,
      svgOriginals: [...svgs.originals.values()].map(({ name, text }) => ({ name, text })),
      log,
      ...stats(message),
      debug: { failures, seconds: (Date.now() - t0) / 1000, fixes, images, fonts: Object.fromEntries(fontSources), message, trace: result.trace },
    };
  } finally {
    const restore = () => {
      journal.restore();
      window.scrollTo(0, startScroll);
    };
    if (keepModified) globalThis.__s2fRestore = restore;
    else restore();
  }
}
