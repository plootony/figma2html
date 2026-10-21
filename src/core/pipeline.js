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
import { ICON_FONT, rasterizeIconFonts, applyIconFonts } from "./icons.js";
import { zipSync, strToU8 } from "fflate";
import { decodePayload, sanitize, fixBlankGlyphs, fixTextLayout, fixAutoLayoutSizing, fixSiblingOrder, setPrototypeDevice, shiftTextBox, optimizeImages, stats, toClipboardHtml, toFigFile, mergeMessages } from "./post.js";

// Elements that never paint themselves (the converter tried to turn <source> into a frame and failed).
const NON_RENDERED = new Set(["source", "track", "param", "area", "map", "datalist", "option", "optgroup", "base", "wbr"]);
const TEXT_CHAR = /[\p{L}\p{N}]/u;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const rootsOf = (root) => (Array.isArray(root) ? root : [root]);
const subtreeMany = (root) => [...new Set(rootsOf(root).flatMap((r) => [r, ...r.querySelectorAll("*")]))];

// Repeated captures on the same page (extension) reuse fonts/images already downloaded.
const NET_CACHE = new Map();
const NET_CACHE_LIMIT = 200;
function cachedNet(kind, url, load) {
  const key = `${kind} ${url}`;
  if (NET_CACHE.has(key)) return NET_CACHE.get(key);
  const promise = load();
  NET_CACHE.set(key, promise);
  promise.catch(() => NET_CACHE.delete(key));
  while (NET_CACHE.size > NET_CACHE_LIMIT) NET_CACHE.delete(NET_CACHE.keys().next().value);
  return promise;
}

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

// The captured root: <body> for a whole page, or the chosen block. Subtree helpers use it so
// a block capture leaves the rest of the page (and its expensive media) alone.
const subtree = (root) => [root, ...root.querySelectorAll("*")];
const describe = (el) => {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((c) => `.${c}`).join("") : "";
  return tag + id + cls;
};

// Scroll through the page so lazy-loaded images and sections render. Capped in time so a
// very long page can't stall the capture forever.
async function autoScroll(shouldCancel) {
  const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
  const stopAt = Date.now() + 30000;
  for (let y = 0; y < document.documentElement.scrollHeight && y < 60000 && Date.now() < stopAt; y += step) {
    shouldCancel?.();
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

export function materializePseudoElements(journal, root = document.body) {
  const hideRule = document.createElement("style");
  hideRule.textContent =
    "[data-s2f-before]::before{content:none!important;display:none!important}[data-s2f-after]::after{content:none!important;display:none!important}";
  const created = [];
  for (const host of subtreeMany(root)) {
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
async function substituteFonts(chars, fonts, journal, bundledFont, root = document.body) {
  const elements = subtreeMany(root);
  const stacks = new Set();
  for (const el of elements) if (isTextElement(el)) stacks.add(getComputedStyle(el).fontFamily);
  const plan = {};
  const mapping = new Map();
  for (const stack of stacks) {
    const first = firstFamily(stack);
    if (ICON_FONT.test(first)) continue;
    const target = await resolveStack(stack, chars, fonts);
    mapping.set(`${first}->${target}`, { from: first, to: target });
    if (target !== first) plan[stack] = target;
  }
  const targets = [...new Set(Object.values(plan))];
  if (!targets.length) return { changes: [], mapping: [...mapping.values()] };

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
  for (const el of elements) {
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
  return {
    changes: [...new Set(Object.entries(plan).map(([stack, t]) => `${firstFamily(stack)} → ${t}`))],
    mapping: [...mapping.values()],
  };
}

// Make typography explicit before conversion, so the converter reads exact values:
// - `line-height: normal` depends on font metrics (the converter would assume 1.2 × size):
//   measured in the browser and pinned in px;
// - logical/vendor text-align values (start, end, -webkit-center) → physical ones;
// - letter/word spacing in % or em → px (the converter would read "40%" as 40px).
function normalizeTypography(journal, root = document.body) {
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
  for (const el of subtreeMany(root)) {
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
function collapseWhitespace(journal, root = document.body) {
  let changed = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
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
  const stop = globalThis.__s2fCaptureRoot || document.body;
  let block = el;
  while (block && block !== stop && /^(inline|contents)/.test(getComputedStyle(block).display)) block = block.parentElement;
  if (!block) block = stop;
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
const resolveTraceElement = (domPath) => {
  const root = globalThis.__s2fCaptureRoot || document.body;
  return domPath === ":scope" ? root : root.querySelector(domPath);
};

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
  const fit = Math.min(400 / Math.max(1, width), 400 / Math.max(1, height));
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(width * fit)), Math.max(1, Math.round(height * fit)));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = getComputedStyle(document.body).backgroundColor || "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
}


// A small image placed next to the captured layout with the facts that are easy to lose
// when converting: sizes, body padding/margins, font mapping and text sizes. It is drawn
// to a canvas rather than converted as text: Figma's cached glyph data from a web font
// subset renders as garbage until the layer is edited, while a PNG is always correct.
async function createInfoImage({ title, sections }) {
  const WIDTH = 420;
  const PAD = 24;
  const SCALE = 2;
  const family = getComputedStyle(document.body).fontFamily;
  const probe = new OffscreenCanvas(1, 1).getContext("2d");
  const font = (size, weight) => `${weight} ${size}px ${family}`;
  const maxWidth = WIDTH - PAD * 2;

  const wrap = (text, size, weight) => {
    probe.font = font(size, weight);
    const lines = [];
    let line = "";
    for (const word of String(text).split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (probe.measureText(next).width <= maxWidth) {
        line = next;
        continue;
      }
      if (line) lines.push(line);
      line = "";
      if (probe.measureText(word).width <= maxWidth) {
        line = word;
        continue;
      }
      for (const char of word) {
        if (line && probe.measureText(line + char).width > maxWidth) {
          lines.push(line);
          line = char;
        } else line += char;
      }
    }
    if (line) lines.push(line);
    return lines.length ? lines : [""];
  };

  const items = [];
  const add = (text, size, weight, color, before = 0, lineHeight = 1.45) => items.push({ text, size, weight, color, before, lineHeight });
  add(title, 16, 700, "#111111", 0, 1.3);
  for (const section of sections) {
    if (!section.lines.length) continue;
    add(section.heading, 11, 700, "#777777", 14, 1.3);
    for (const line of section.lines) add(line, 13, 400, "#111111");
  }

  let y = PAD;
  const rows = [];
  for (const item of items) {
    y += item.before;
    for (const line of wrap(item.text, item.size, item.weight)) {
      rows.push({ line, y, size: item.size, weight: item.weight, color: item.color });
      y += item.size * item.lineHeight;
    }
  }
  const height = Math.ceil(y + PAD);
  const canvas = new OffscreenCanvas(WIDTH * SCALE, height * SCALE);
  const ctx = canvas.getContext("2d");
  ctx.scale(SCALE, SCALE);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, WIDTH, height);
  ctx.strokeStyle = "#dddddd";
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, WIDTH - 1, height - 1);
  ctx.textBaseline = "top";
  for (const row of rows) {
    ctx.font = font(row.size, row.weight);
    ctx.fillStyle = row.color;
    ctx.fillText(row.line, PAD, row.y);
  }
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return { dataUrl, width: WIDTH, height };
}


const fmtPx = (n) => `${Math.round(n * 10) / 10}px`;
const hexColor = (css) => {
  const m = /^rgba?\(([^)]+)\)$/i.exec((css || "").trim());
  if (!m) return null;
  const p = m[1].split(/[,/ ]+/).filter(Boolean).map(Number);
  if (p.length < 3 || p.some((v) => !Number.isFinite(v))) return null;
  const a = p[3] ?? 1;
  if (a <= 0) return null;
  const h = (v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
  return `#${h(p[0])}${h(p[1])}${h(p[2])}${a < 1 ? h(a * 255) : ""}`.toUpperCase();
};

function collectTokens(roots) {
  const colors = new Map();
  const typography = new Map();
  const spacing = new Map();
  const radii = new Map();
  const shadows = new Map();
  const bump = (map, key, amount = 1) => map.set(key, (map.get(key) || 0) + amount);
  const addSpacing = (value) => {
    const n = parseFloat(value);
    if (Number.isFinite(n) && n > 0) bump(spacing, fmtPx(n));
  };
  const addColor = (value) => {
    const hex = hexColor(value);
    if (hex) bump(colors, hex);
  };
  for (const root of roots) {
    for (const el of [root, ...root.querySelectorAll("*")]) {
      const cs = getComputedStyle(el);
      addColor(cs.color);
      addColor(cs.backgroundColor);
      for (const side of ["Top", "Right", "Bottom", "Left"]) {
        if (parseFloat(cs[`border${side}Width`]) > 0) addColor(cs[`border${side}Color`]);
      }
      for (const prop of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "marginTop", "marginRight", "marginBottom", "marginLeft", "rowGap", "columnGap"]) addSpacing(cs[prop]);
      for (const prop of ["borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius", "borderBottomLeftRadius"]) {
        const n = parseFloat(cs[prop]);
        if (n > 0) bump(radii, fmtPx(n));
      }
      if (cs.boxShadow && cs.boxShadow !== "none") bump(shadows, cs.boxShadow.replace(/\s+/g, " ").trim());
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent.trim()) continue;
      const el = node.parentElement;
      if (!el) continue;
      const cs = getComputedStyle(el);
      const family = cs.fontFamily.split(",")[0].replace(/["']/g, "").trim();
      const size = Math.round(parseFloat(cs.fontSize) * 10) / 10;
      const weight = cs.fontWeight;
      const lineHeight = cs.lineHeight === "normal" ? Math.round(size * 12) / 10 : Math.round(parseFloat(cs.lineHeight) * 10) / 10;
      if (family && size > 0) bump(typography, `${family}|${size}|${weight}|${lineHeight}`);
    }
  }
  const top = (map, count) => [...map].sort((a, b) => b[1] - a[1]).slice(0, count);
  return {
    colors: top(colors, 16).map(([hex, count]) => ({ hex, count })),
    typography: top(typography, 12).map(([key, count]) => {
      const [family, size, weight, lineHeight] = key.split("|");
      return { family, size: Number(size), weight, lineHeight: Number(lineHeight), count };
    }),
    spacing: top(spacing, 10).map(([label, count]) => ({ label, value: parseFloat(label), count })),
    radii: top(radii, 8).map(([label, count]) => ({ label, value: parseFloat(label), count })),
    shadows: top(shadows, 6).map(([value, count]) => ({ value, count })),
  };
}

async function createTokensImage({ url, tokens }) {
  const WIDTH = 420;
  const PAD = 24;
  const SCALE = 2;
  const bodyFamily = getComputedStyle(document.body).fontFamily;
  const canvas = new OffscreenCanvas(WIDTH * SCALE, 3200 * SCALE);
  const ctx = canvas.getContext("2d");
  ctx.scale(SCALE, SCALE);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, WIDTH, 3200);
  const text = (value, x, y, size, weight, color, family = bodyFamily, baseline = "top") => {
    ctx.font = `${weight} ${size}px ${family}`;
    ctx.fillStyle = color;
    ctx.textBaseline = baseline;
    ctx.fillText(value, x, y);
  };
  let y = PAD;
  text("SITE TO FIGMA / DESIGN TOKENS", PAD, y, 16, 700, "#111111");
  y += 24;
  text(`URL: ${url.slice(0, 76)}`, PAD, y, 10, 400, "#777777");
  y += 18;
  const section = (label) => {
    y += 14;
    text(label, PAD, y, 11, 700, "#777777");
    y += 17;
  };

  section("COLORS");
  for (let i = 0; i < tokens.colors.length; i += 2) {
    const row = tokens.colors.slice(i, i + 2);
    row.forEach((color, column) => {
      const x = PAD + column * 188;
      ctx.fillStyle = color.hex;
      ctx.fillRect(x, y, 18, 18);
      ctx.strokeStyle = "#dddddd";
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, 17, 17);
      text(`${color.hex} (${color.count})`, x + 25, y + 4, 10, 400, "#111111");
    });
    y += 24;
  }

  section("TYPOGRAPHY");
  for (const item of tokens.typography) {
    const sample = Math.min(26, Math.max(10, item.size));
    const rowHeight = Math.max(30, sample * 1.25 + 4);
    text("Aa", PAD, y + rowHeight - 6, sample, item.weight, "#111111", item.family, "alphabetic");
    text(`${item.family} ${item.size}/${item.lineHeight} ${item.weight} (${item.count})`, PAD + 52, y + 8, 10, 400, "#111111");
    y += rowHeight;
  }

  section("SPACING");
  for (const item of tokens.spacing) {
    const width = Math.min(180, Math.max(4, item.value));
    ctx.fillStyle = "#9a9a94";
    ctx.fillRect(PAD, y + 5, width, 6);
    text(`${item.label} (${item.count})`, PAD + 190, y + 2, 10, 400, "#111111");
    y += 18;
  }

  section("RADII");
  for (const item of tokens.radii) {
    const radius = Math.min(14, item.value);
    ctx.beginPath();
    ctx.roundRect(PAD, y, 28, 28, radius);
    ctx.fillStyle = "#f0f0ee";
    ctx.fill();
    ctx.strokeStyle = "#999999";
    ctx.stroke();
    text(`${item.label} (${item.count})`, PAD + 38, y + 8, 10, 400, "#111111");
    y += 34;
  }

  section("SHADOWS");
  for (const item of tokens.shadows) {
    const parts = [...item.value.matchAll(/(-?[\d.]+)px/g)].map((match) => parseFloat(match[1]));
    ctx.save();
    ctx.shadowColor = (item.value.match(/(rgba?\([^)]+\)|#[0-9a-f]{3,8}|\b[a-z]+\b)/i) || ["rgba(0,0,0,.2)"])[0];
    ctx.shadowOffsetX = parts[0] || 0;
    ctx.shadowOffsetY = parts[1] || 0;
    ctx.shadowBlur = parts[2] || 8;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(PAD, y + 2, 84, 26);
    ctx.restore();
    ctx.strokeStyle = "#dddddd";
    ctx.strokeRect(PAD + 0.5, y + 2.5, 83, 25);
    text(item.value.length > 54 ? item.value.slice(0, 54) + "..." : item.value, PAD + 94, y + 8, 9, 400, "#111111");
    y += 38;
  }

  const height = Math.ceil(y + PAD);
  const out = new OffscreenCanvas(WIDTH * SCALE, height * SCALE);
  const outCtx = out.getContext("2d");
  outCtx.drawImage(canvas, 0, 0, WIDTH * SCALE, height * SCALE, 0, 0, WIDTH * SCALE, height * SCALE);
  outCtx.strokeStyle = "#dddddd";
  outCtx.lineWidth = 2;
  outCtx.strokeRect(1, 1, WIDTH * SCALE - 2, height * SCALE - 2);
  const blob = await out.convertToBlob({ type: "image/png" });
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return { dataUrl, width: WIDTH, height };
}


export async function capture(options, env) {
  // keepModified: leave the prepared DOM in place (verify.mjs inspects it); call the
  // returned `restore()` afterwards.
  const { layout = "auto", hideSelectors = "", scroll = true, freezeAnimations = true, keepModified = false, extraInfo = false, designTokens = false } = options;
  const progress = env.progress || (() => {});
  const cancel = () => {
    if (!options.shouldCancel?.()) return;
    const error = new Error("Захват отменён");
    error.name = "AbortError";
    throw error;
  };
  const net = {
    text: (url) => cachedNet("text", url, () => env.net.text(url)),
    get: (url) => cachedNet("get", url, () => env.net.get(url)),
  };
  const fonts = createFontLoader(net, env.bundledFont);
  const journal = createStyleJournal();
  const log = [];
  const t0 = Date.now();
  const startScroll = window.scrollY;

  const selectors = options.targetSelectors?.length ? options.targetSelectors : options.targetSelector ? [options.targetSelector] : [];
  let roots = (options.targets?.length ? options.targets : selectors.map((sel) => document.querySelector(sel)))
    .filter((el) => el?.isConnected);
  if (selectors.length && roots.length < selectors.length) {
    const missing = selectors.filter((sel) => !document.querySelector(sel));
    throw new Error(`Блок не найден: ${missing.join(", ")}`);
  }
  if (!roots.length) roots = [document.body];
  if (roots.some((el) => el === document.body || el === document.documentElement)) roots = [document.body];
  roots = [...new Set(roots)].filter((el) => !roots.some((other) => other !== el && other.contains(el)));
  const block = !(roots.length === 1 && roots[0] === document.body);
  const wholePage = !block;
  globalThis.__s2fCaptureRoot = roots[0];

  try {
    cancel();
    if (freezeAnimations) {
      // Elements are captured in their final state, not mid-animation.
      const style = document.createElement("style");
      style.textContent = "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important;scroll-behavior:auto!important}";
      document.head.appendChild(style);
      journal.add(style);
    }
    if (scroll) {
      progress("Прокрутка страницы…");
      await autoScroll(cancel);
    }
    cancel();
    await Promise.race([document.fonts.ready, wait(5000)]);

    for (const sel of hideSelectors.split(",").map((s) => s.trim()).filter(Boolean)) {
      try {
        document.querySelectorAll(sel).forEach((el) => journal.set(el, "display", "none"));
      } catch {}
    }

    // Before any DOM changes: temporary elements carry inline !important styles that the
    // "hide everything else" rule of the snapshot can't override.
    progress("Снимки canvas/видео…");
    cancel();
    const snapshots = await snapshotMediaElements(env.captureViewport, roots);
    cancel();

    const pseudo = materializePseudoElements(journal, roots);
    let whitespace = 0;
    for (const root of roots) whitespace += collapseWhitespace(journal, root);
    progress("SVG…");
    cancel();
    let svgUses = 0;
    let svgInlined = 0;
    const svgOriginals = new Map();
    for (const root of roots) {
      svgUses += await resolveSvgUses(journal, net, root);
      const svgs = await prepareSvgImages(journal, net, root);
      svgInlined += svgs.inlined;
      for (const [url, original] of svgs.originals) if (!svgOriginals.has(url)) svgOriginals.set(url, original);
      cancel();
    }

    progress("Шрифты…");
    let text = "";
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) text += walker.currentNode.textContent;
      for (const el of [root, ...root.querySelectorAll("input, textarea")]) {
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") text += (el.placeholder || "") + (el.value || "");
      }
    }
    let chars = charsetOf(text);
    const pageFaces = await collectFontFaces(net);
    cancel();
    const fontSubstitution = await substituteFonts(chars, fonts, journal, env.bundledFont, roots);
    if (fontSubstitution.changes.length) log.push("Замена шрифтов: " + fontSubstitution.changes.join(", "));
    normalizeTypography(journal, roots);
    cancel();
    const iconImages = await rasterizeIconFonts(roots);

    const title = document.title || location.hostname;
    const viewportHeight = Math.max(1, Math.round(window.innerHeight));
    let frames;
    if (wholePage) {
      const width = document.documentElement.clientWidth;
      const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      frames = [{ element: document.body, width, height: Math.max(1, Math.round(height)), name: `${title} — ${width}px` }];
    } else {
      frames = roots.map((element) => {
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) throw new Error(`Блок ${describe(element)} не виден на странице (нулевой размер)`);
        const width = Math.max(1, Math.round(rect.width));
        return { element, width, height: Math.max(1, Math.round(rect.height)), name: `${title} — ${describe(element)} — ${width}px` };
      });
    }
    const mainFrames = frames;
    if (extraInfo) {
      const number = (value) => {
        const n = Math.round((parseFloat(value) || 0) * 10) / 10;
        return Number.isInteger(n) ? String(n) : n.toFixed(1);
      };
      const box = (value) => [value.paddingTop, value.paddingRight, value.paddingBottom, value.paddingLeft, value.marginTop, value.marginRight, value.marginBottom, value.marginLeft].map(number).join(" / ");
      const sizes = new Set();
      for (const root of roots) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const el = walker.currentNode.parentElement;
          if (!el) continue;
          const size = parseFloat(getComputedStyle(el).fontSize);
          if (size > 0) sizes.add(Math.round(size * 10) / 10);
        }
      }
      const sections = [
        { heading: "PAGE", lines: [`URL: ${location.href}`, `Captured: ${new Date().toISOString()}`, `Blocks: ${mainFrames.length}`] },
        {
          heading: "SIZES",
          lines: mainFrames.map((frame, i) => `${wholePage ? "Page" : describe(roots[i] || frame.element)}: ${frame.width} x ${frame.height} px`),
        },
        {
          heading: "PADDING / MARGIN (px)",
          lines: mainFrames.map((frame, i) => `${wholePage ? "Page" : describe(roots[i] || frame.element)}: ${box(getComputedStyle(frame.element))}`),
        },
        {
          heading: "FONTS (ORIGINAL -> IN FIGMA)",
          lines: fontSubstitution.mapping.map(({ from, to }) => `${from} -> ${to}`),
        },
        {
          heading: "TEXT SIZES (px)",
          lines: [[...sizes].sort((a, b) => a - b).map((n) => number(n)).join(", ")],
        },
      ];
      const info = await createInfoImage({ title: "SITE TO FIGMA / ADDITIONAL INFO", sections });
      const image = document.createElement("img");
      image.src = info.dataUrl;
      image.width = info.width;
      image.height = info.height;
      Object.assign(image.style, { position: "fixed", left: "-20000px", top: "0", width: `${info.width}px`, height: `${info.height}px` });
      document.documentElement.appendChild(image);
      journal.add(image);
      frames = [...mainFrames, { element: image, width: info.width, height: info.height, name: "Доп. информация" }];
    }
    if (designTokens) {
      const tokens = await createTokensImage({ url: location.href, tokens: collectTokens(roots) });
      const image = document.createElement("img");
      image.src = tokens.dataUrl;
      image.width = tokens.width;
      image.height = tokens.height;
      Object.assign(image.style, { position: "fixed", left: "-20000px", top: "0", width: `${tokens.width}px`, height: `${tokens.height}px` });
      document.documentElement.appendChild(image);
      journal.add(image);
      frames = [...frames, { element: image, width: tokens.width, height: tokens.height, name: "Токены дизайна" }];
    }
    const GAP = 80;
    let offsetX = 0;
    for (const frame of frames) {
      frame.x = offsetX;
      frame.y = 0;
      offsetX += frame.width + GAP;
    }
    const totalWidth = Math.max(1, offsetX - GAP);
    const totalHeight = Math.max(1, ...frames.map((f) => f.height));
    const name = mainFrames.length === 1 ? mainFrames[0].name : `${title} — блоки: ${mainFrames.length} — ${totalWidth}px`;

    cancel();
    let thumbnail = null;
    if (frames.length === 1) {
      if (!wholePage) {
        frames[0].element.scrollIntoView({ block: "start", inline: "nearest" });
        await wait(100);
      } else window.scrollTo(0, 0);
      thumbnail = env.thumbnail ? await env.thumbnail({ width: totalWidth, height: totalHeight }).catch(() => null) : null;
      window.scrollTo(0, 0);
    }
    if (!thumbnail) thumbnail = await placeholderThumbnail(totalWidth, totalHeight);

    progress("Конвертация…");
    const fontSources = new Map();
    const fontFailures = [];
    const imageFailures = [];
    const converter = createFigmaConverter({
      layout,
      trace: true,
      // A text-only element with a background image must stay a frame, or the image is lost.
      classify: (el, kind) =>
        NON_RENDERED.has(el.tagName.toLowerCase()) ? "skip" : kind === "text" && hasUrlBackground(el) ? "frame" : kind,
      fontLoader: async (req) => {
        cancel();
        const r = await fonts.load(req, chars, pageFaces);
        fontSources.set(`${req.family} ${req.weight}${req.italic ? "i" : ""}`, r.error ? "нет" : r.source);
        if (r.error) {
          fontFailures.push(`${req.family} ${req.weight}${req.italic ? " italic" : ""}: ${r.error}`);
          throw new Error(r.error);
        }
        return { bytes: base64ToBytes(r.b64).buffer, resolvedWeight: r.weight, resolvedItalic: r.italic, ...(r.family && { resolvedFamily: r.family }) };
      },
      imageLoader: async ({ src, element }) => {
        cancel();
        try {
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
        } catch (e) {
          imageFailures.push(`${src.slice(0, 160)}: ${String(e?.message || e).slice(0, 120)}`);
          throw e;
        }
      },
    });

    const parts = [];
    const failures = [];
    const fixes = { nan: 0, glyphs: 0, lineBoxes: 0, backgrounds: 0, snapshots: 0, svgNamed: 0, iconFonts: 0, hugWithFill: 0, siblingGroups: 0, scrollBehavior: 0, prototypeDevice: 0 };
    const images = { before: 0, after: 0 };
    let trace;
    for (let i = 0; i < frames.length; i++) {
      cancel();
      const frame = frames[i];
      if (frames.length > 1) progress(`Конвертация ${i + 1}/${frames.length}…`);
      globalThis.__s2fCaptureRoot = frame.element;
      globalThis.__s2fErrors = [];
      const rootTop = frame.element.getBoundingClientRect().top;
      globalThis.__s2fRootAtOrigin = frame.element !== document.body;
      let result;
      try {
        result = await converter.convert({ element: frame.element, width: frame.width, height: frame.height, name: frame.name });
      } finally {
        delete globalThis.__s2fRootAtOrigin;
      }
      trace = result.trace;
      cancel();

      // Elements the converter failed on (kept as plain frames with their content).
      const label = frames.length > 1 ? `[${describe(frame.element)}] ` : "";
      for (const { node, error } of globalThis.__s2fErrors || []) {
        const el = node.nodeType === 1 ? node : node.parentElement;
        const cls = el && typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
        failures.push(`${label}${el ? el.tagName.toLowerCase() + cls : "#text"}: ${String(error?.message || error).slice(0, 160)}`);
      }

      progress("Обработка…");
      cancel();
      const message = decodePayload(result.base64);
      const one = {
        nan: sanitize(message),
        glyphs: fixBlankGlyphs(message),
        lineBoxes: alignTextBoxesToLineBox(message, result.trace, rootTop),
        backgrounds: await addBackgroundImages(message, result.trace, net, resolveTraceElement),
        snapshots: applySnapshots(message, result.trace, snapshots, resolveTraceElement),
        svgNamed: nameSvgImages(message, result.trace, svgOriginals),
        hugWithFill: fixAutoLayoutSizing(message),
        siblingGroups: fixSiblingOrder(message),
        scrollBehavior: markScrollBehavior(message, result.trace),
        prototypeDevice: setPrototypeDevice(message, { width: frame.width, height: viewportHeight }),
      };
      for (const [k, v] of Object.entries(one)) fixes[k] = (fixes[k] || 0) + v;
      fixTextLayout(message);
      fixes.iconFonts += applyIconFonts(message, result.trace, iconImages, resolveTraceElement);
      const resized = await optimizeImages(message, resizeImage);
      images.before += resized.before;
      images.after += resized.after;
      parts.push({ message, x: frame.x, y: frame.y });
      cancel();
    }
    fixes.pseudo = pseudo;
    fixes.whitespace = whitespace;
    fixes.svgInlined = svgInlined;
    fixes.svgUses = svgUses;

    cancel();
    const message = mergeMessages(parts);
    if (failures.length) {
      log.push(`Не удалось полностью перенести элементов: ${failures.length} (их содержимое сохранено). Первая ошибка — ${failures[0]}`);
      console.warn("site2figma: conversion errors", failures);
    }
    if (fixes.iconFonts) log.push(`Иконочные шрифты: ${fixes.iconFonts} заменены картинками`);
    if (imageFailures.length) log.push(`Не загрузились картинки: ${imageFailures.length}. Первая — ${imageFailures[0]}`);
    if (fontFailures.length) log.push(`Не загрузились шрифты: ${fontFailures.length}. Первый — ${fontFailures[0]}`);

    // Originals of the SVGs kept as images, for dropping into Figma by hand.
    const svgFiles = {};
    for (const { name, text } of svgOriginals.values()) {
      let unique = name;
      for (let i = 2; svgFiles[unique]; i++) unique = name.replace(/(\.svg)?$/i, `-${i}.svg`);
      svgFiles[unique] = strToU8(text);
    }
    const svgZip = Object.keys(svgFiles).length ? zipSync(svgFiles) : null;

    const clipboardHtml = toClipboardHtml(message);
    const fig = toFigFile(message, { name, thumbnail, width: totalWidth, height: totalHeight });
    return {
      name,
      width: totalWidth,
      height: totalHeight,
      fig,
      clipboardHtml,
      svgZip,
      svgCount: svgOriginals.size,
      svgOriginals: [...svgOriginals.values()].map(({ name, text }) => ({ name, text })),
      log,
      ...stats(message),
      debug: {
        failures,
        imageFailures,
        fontFailures,
        seconds: (Date.now() - t0) / 1000,
        fixes,
        images,
        fonts: Object.fromEntries(fontSources),
        message,
        trace: frames.length === 1 ? trace : undefined,
      },
    };
  } finally {
    delete globalThis.__s2fCaptureRoot;
    delete globalThis.__s2fRootAtOrigin;
    const restore = () => {
      journal.restore();
      window.scrollTo(0, startScroll);
    };
    if (keepModified) globalThis.__s2fRestore = restore;
    else restore();
  }
}
