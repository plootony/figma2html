// Font scan for the "Шрифты" tab: every font file the page declares through @font-face.
// Cross-origin stylesheets (e.g. Google Fonts) can't be read via CSSOM, so their text is
// fetched through the background page, the same way the capture loads remote CSS.

const SUPPORTED = new Set(["woff2", "woff", "ttf", "otf"]);
const RANK = { woff2: 0, woff: 1, ttf: 2, otf: 3 };
const EXT = /\.(woff2|woff|ttf|otf)(?:[?#]|$)/i;
const FORMAT = { woff2: "woff2", woff: "woff", truetype: "ttf", opentype: "otf", ttf: "ttf", otf: "otf" };

const clean = (s) => s.replace(/[\\/:*?"<>|~]+/g, "_").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 80) || "font";
const unquote = (v) => (v || "").trim().replace(/^["']|["']$/g, "").trim();

const resolve = (raw, base) => {
  if (!raw) return null;
  try {
    return new URL(raw, base).href;
  } catch {
    return null;
  }
};

function extFromUrl(url) {
  if (url.startsWith("data:")) {
    const mime = url.slice(5, url.indexOf(";") > 0 ? url.indexOf(";") : url.indexOf(",")).toLowerCase();
    const map = { "font/woff2": "woff2", "font/woff": "woff", "font/ttf": "ttf", "font/otf": "otf", "application/font-woff": "woff", "application/x-font-woff": "woff", "application/x-font-ttf": "ttf", "application/x-font-opentype": "otf" };
    return map[mime] || null;
  }
  return url.match(EXT)?.[1]?.toLowerCase() || null;
}

const extFromFormat = (format) => FORMAT[(format || "").toLowerCase().split(",")[0].trim()] || null;

const prop = (body, name) => body.match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, "i"))?.[1].trim();

function facesFromCss(css, base) {
  const faces = [];
  for (const block of css.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const body = block[1];
    const family = unquote(prop(body, "font-family"));
    const src = prop(body, "src");
    if (!family || !src) continue;
    const styleRaw = (prop(body, "font-style") || "normal").toLowerCase();
    const weightRaw = prop(body, "font-weight") || "400";
    const weight = /^\d/.test(weightRaw) ? weightRaw.replace(/\s+/g, "–") : weightRaw === "bold" ? "700" : "400";
    let best = null;
    for (const m of src.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)(?:\s*format\(\s*(["']?)([^"')]+)\3\s*\))?/gi)) {
      const url = resolve(m[2], base);
      if (!url) continue;
      const format = (m[4] || "").toLowerCase();
      const ext = extFromUrl(url) || extFromFormat(format);
      if (!ext || !SUPPORTED.has(ext)) continue;
      if (!best || RANK[ext] < RANK[best.ext]) best = { url, ext, format: format || ext };
    }
    if (!best) continue;
    faces.push({ ...best, family, weight, style: /italic|oblique/.test(styleRaw) ? "Italic" : "Regular" });
  }
  return faces;
}

// @import can pull another stylesheet with more @font-face rules (fonts often live one level down).
function importsFromCss(css, base) {
  const out = [];
  for (const m of css.matchAll(/@import\s+(?:url\(\s*["']?([^"')]+)["']?\s*\)|["']([^"']+)["'])/gi)) {
    const url = resolve(m[1] || m[2], base);
    if (url) out.push(url);
  }
  return out;
}

// document.styleSheets plus open shadow roots and adopted stylesheets.
function allStyleSheets() {
  const seen = new Set();
  const out = [];
  const add = (list) => {
    for (const sheet of list || []) {
      if (sheet && !seen.has(sheet)) {
        seen.add(sheet);
        out.push(sheet);
      }
    }
  };
  add(document.styleSheets);
  add(document.adoptedStyleSheets);
  const walk = (root) => {
    for (const el of root.querySelectorAll("*")) {
      const shadow = el.shadowRoot;
      if (!shadow) continue;
      add(shadow.styleSheets);
      add(shadow.adoptedStyleSheets);
      walk(shadow);
    }
  };
  walk(document);
  return out;
}

const familyFromFile = (url) => {
  try {
    return clean(decodeURIComponent(new URL(url).pathname.split("/").pop() || "").replace(EXT, "")) || "font";
  } catch {
    return "font";
  }
};

/** Returns [{ url, name, family, weight, style, format }] — one item per font file. */
export async function scanFonts(net) {
  const found = new Map(); // family + url -> face
  const seenHrefs = new Set();
  const queue = [];
  const addFace = (face) => {
    const key = `${face.family}\u0000${face.url}`;
    const existing = found.get(key);
    if (!existing) {
      found.set(key, { ...face, weights: [face.weight], styles: [face.style] });
      return;
    }
    if (!existing.weights.includes(face.weight)) existing.weights.push(face.weight);
    if (!existing.styles.includes(face.style)) existing.styles.push(face.style);
  };
  const addCss = (css, base) => {
    for (const face of facesFromCss(css, base)) addFace(face);
    for (const href of importsFromCss(css, base)) enqueue(href);
  };
  const loadSheet = (href) => {
    if (!href || seenHrefs.has(href)) return;
    seenHrefs.add(href);
    queue.push(
      net
        .text(href)
        .then((css) => addCss(css, href))
        .catch(() => {})
    );
  };
  const enqueue = loadSheet;
  const walkRules = (rules, base) => {
    for (const rule of rules) {
      if (rule.type === CSSRule.FONT_FACE_RULE) addCss(rule.cssText, base);
      else if (rule.type === CSSRule.IMPORT_RULE) {
        if (rule.styleSheet) walkSheet(rule.styleSheet);
        else if (rule.href) loadSheet(resolve(rule.href, base));
      } else if (rule.cssRules) walkRules(rule.cssRules, base);
    }
  };
  const walkSheet = (sheet) => {
    const base = sheet.href || document.baseURI;
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      if (sheet.href) loadSheet(sheet.href); // cross-origin: read it through the background
      return;
    }
    walkRules(rules, base);
  };

  for (const sheet of allStyleSheets()) {
    try {
      walkSheet(sheet);
    } catch {}
  }
  while (queue.length) await queue.shift();

  // Preloaded fonts may not be described by @font-face (loaded by JS); still offer them.
  for (const link of document.querySelectorAll('link[rel~="preload"][as="font"][href]')) {
    const url = resolve(link.href, document.baseURI);
    if (!url || [...found.values()].some((f) => f.url === url)) continue;
    const format = (link.getAttribute("type") || "").toLowerCase();
    const ext = extFromUrl(url) || extFromFormat(format);
    if (!ext || !SUPPORTED.has(ext)) continue;
    found.set(`\u0000${url}`, { url, ext, format: ext, family: "", weights: [], styles: [] });
  }

  const items = [...found.values()];
  items.sort((a, b) => (a.family || "").localeCompare(b.family || "") || (parseInt(a.weights[0], 10) || 0) - (parseInt(b.weights[0], 10) || 0) || a.styles.join("").localeCompare(b.styles.join("")));
  const used = new Set();
  for (const item of items) {
    const family = item.family || familyFromFile(item.url);
    item.family = family;
    const weight = item.weights.join(", ");
    const style = item.styles.join(", ");
    const nameWeight = item.weights.join("-");
    const base = `${[clean(family), nameWeight ? clean(nameWeight) : ""].filter(Boolean).join("-")}${item.styles.includes("Italic") ? "-Italic" : ""}`;
    let name = `${base}.${item.ext}`;
    for (let i = 2; used.has(name); i++) name = `${base}-${i}.${item.ext}`;
    used.add(name);
    item.name = name;
    item.weight = weight;
    item.style = style;
    delete item.weights;
    delete item.styles;
  }
  return items;
}
