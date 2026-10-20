// Font files for text layout. Network access goes through `net` ({ text(url), get(url) → { b64, mime } }),
// so the same code runs in the extension (background fetch, no CORS) and in headless Chrome.
//
// Order of sources for a requested family/weight/style:
// 1. the page's own @font-face file — metrics must come from the exact file the browser
//    rendered with (another version of "the same" font can be 10%+ wider);
// 2. Google Fonts with `text=<page chars>` — one file with exactly the characters used,
//    including Cyrillic (default Google files are Latin-only → invisible glyphs in Figma);
// 3. Inter, for metrics only (Figma still gets the original family name).
const FALLBACK_FAMILY = "Inter";
const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900];

// `bundled(weight)` (optional) → Promise<base64 | null>: Inter shipped with the extension,
// the last resort when Google Fonts can't be reached (without any font file, text is lost).
export function createFontLoader(net, bundled) {
  const variantsCache = new Map(); // family|text -> Promise<Array<{ weight, italic, url }>>
  const fileCache = new Map(); // url -> Promise<base64>

  const once = (cache, key, make) => {
    if (!cache.has(key)) {
      const p = make().catch((e) => {
        cache.delete(key); // network error: allow retry
        throw e;
      });
      cache.set(key, p);
    }
    return cache.get(key);
  };

  const googleVariants = (family, text) =>
    once(variantsCache, family + "|" + text, async () => {
      const spec = [...WEIGHTS, ...WEIGHTS.map((w) => w + "i")].join(",");
      let url = `https://fonts.googleapis.com/css?family=${encodeURIComponent(family)}:${spec}`;
      if (text) url += `&text=${encodeURIComponent(text)}`;
      const css = await net.text(url).catch(() => "");
      const out = [];
      for (const block of css.split("@font-face").slice(1)) {
        const style = block.match(/font-style:\s*(\w+)/)?.[1];
        const weight = Number(block.match(/font-weight:\s*(\d+)/)?.[1]);
        const src = block.match(/url\((https:[^)]+)\)/)?.[1];
        if (src && weight && !out.some((v) => v.weight === weight && v.italic === (style === "italic"))) {
          out.push({ weight, italic: style === "italic", url: src });
        }
      }
      return out;
    });

  const fetchFile = (url) =>
    url.startsWith("data:") ? Promise.resolve(url.slice(url.indexOf(",") + 1).trim()) : once(fileCache, url, () => net.get(url).then((r) => r.b64));

  async function isOnGoogle(family, text) {
    return (await googleVariants(family, text).catch(() => [])).length > 0;
  }

  async function load({ family, weight, italic }, text = "", pageFaces = []) {
    const face = pickPageFace(pageFaces, { family, weight, italic });
    if (face) {
      // The page's file may be a rebranded cut with other style names/weights than the
      // Google family Figma has (FinlandicaText-Black for "Finlandica Black"). Metrics come
      // from the page's file, but the style must be one Figma can resolve, or the text
      // layers arrive empty.
      const variants = await googleVariants(family, text).catch(() => []);
      const v = variants.length ? pickVariant(variants, weight, face.italic) : null;
      for (const url of face.urls) {
        try {
          return {
            b64: await fetchFile(url),
            weight: v ? v.weight : face.weightMin,
            italic: v ? v.italic : face.italic,
            source: "page",
          };
        } catch {}
      }
    }
    for (const fam of [family, FALLBACK_FAMILY]) {
      let variants = await googleVariants(fam, text).catch(() => []);
      if (!variants.length && text) variants = await googleVariants(fam, "").catch(() => []);
      if (!variants.length) continue;
      const v = pickVariant(variants, weight, italic);
      try {
        return { b64: await fetchFile(v.url), weight: v.weight, italic: v.italic, family: fam === family ? undefined : fam, source: "google" };
      } catch {}
    }
    if (bundled) {
      const w = [300, 400, 500, 600, 700].reduce((a, b) => (Math.abs(b - weight) < Math.abs(a - weight) ? b : a));
      const b64 = await bundled(w).catch(() => null);
      if (b64) return { b64, weight: w, italic: false, family: family === FALLBACK_FAMILY ? undefined : FALLBACK_FAMILY, source: "bundled" };
    }
    return { error: `font not available: ${family}` };
  }

  return { load, isOnGoogle };
}

function pickVariant(variants, weight, italic) {
  const sameStyle = variants.filter((v) => v.italic === italic);
  const pool = sameStyle.length ? sameStyle : variants;
  return pool.reduce((best, v) => (Math.abs(v.weight - weight) < Math.abs(best.weight - weight) ? v : best));
}

// Unique characters of a page, in both cases (CSS text-transform can change them).
// Spaces must be included, otherwise the font has no space glyph and Figma draws .notdef.
export function charsetOf(text) {
  const set = new Set(text + text.toUpperCase() + text.toLowerCase() + "0123456789 ., ");
  return [...set].filter((c) => !/[\u0000-\u001f\u007f]/.test(c)).sort().join("");
}

// Similar Google fonts for popular system/commercial fonts. Arimo, Tinos, Cousine,
// Carlito and Caladea are metric-compatible, so line breaks stay the same.
const SIMILAR = {
  arial: "Arimo",
  helvetica: "Arimo",
  "helvetica neue": "Arimo",
  "liberation sans": "Arimo",
  "times new roman": "Tinos",
  times: "Tinos",
  "liberation serif": "Tinos",
  "courier new": "Cousine",
  courier: "Cousine",
  "liberation mono": "Cousine",
  georgia: "Gelasio",
  calibri: "Carlito",
  cambria: "Caladea",
  verdana: "PT Sans",
  tahoma: "PT Sans",
  "trebuchet ms": "Fira Sans",
  "segoe ui": "Open Sans",
  "sf pro display": "Inter",
  "sf pro text": "Inter",
  "-apple-system": "Inter",
  blinkmacsystemfont: "Inter",
  "system-ui": "Inter",
  "ui-sans-serif": "Inter",
  "sans-serif": "Inter",
  serif: "PT Serif",
  "ui-serif": "PT Serif",
  monospace: "Roboto Mono",
  "ui-monospace": "Roboto Mono",
  menlo: "Roboto Mono",
  consolas: "Roboto Mono",
  monaco: "Roboto Mono",
  cursive: "Caveat",
  // Commercial fonts (not in Figma): close Google families, all with Cyrillic.
  "san francisco": "Inter",
  "motiva sans": "Inter",
  "proxima nova": "Montserrat",
  gotham: "Montserrat",
  "gotham pro": "Montserrat",
  gilroy: "Manrope",
  futura: "Jost",
  "futura pt": "Jost",
  avenir: "Nunito Sans",
  "avenir next": "Nunito Sans",
  graphik: "Inter",
  "graphik lc": "Inter",
  sohne: "Inter",
  "söhne": "Inter",
  "circular std": "Inter",
  circular: "Inter",
  "neue haas grotesk": "Inter",
  "neue haas grotesk display": "Inter",
  "helvetica now": "Inter",
  "museo sans": "Nunito Sans",
  "segoe ui variable": "Open Sans",
  "ys text": "Inter",
  "ys display": "Inter",
  "new york": "Noto Serif",
};
// Families by prefix (SF Pro Text / SF Pro Display / SF Compact …).
const SIMILAR_PREFIX = [
  [/^sf (pro|compact|ui)/, "Inter"],
  [/^-?apple/, "Inter"],
  [/^helvetica/, "Arimo"],
];
const similarFor = (fam) => {
  const key = fam.toLowerCase();
  return SIMILAR[key] || SIMILAR_PREFIX.find(([re]) => re.test(key))?.[1];
};

const unquote = (f) => f.trim().replace(/^["']|["']$/g, "").trim();
export const firstFamily = (stack) => unquote(stack.split(",")[0] || "");

// Name as is, or without a technical suffix ("Inter Variable", "Mona Sans VF").
function nameVariants(fam) {
  const base = fam.replace(/[\s_-]*(var|variable|vf|web|webfont|wf)$/i, "").trim();
  return [...new Set([fam, base].filter(Boolean))];
}

// Pick the font Figma will get, by the stack's main (first) family. Figma has every Google
// font, so a family that is on Google Fonts is kept (if the page ships the file itself, its
// exact metrics are still used). Known commercial/system fonts get a similar Google font
// (SIMILAR); anything unrecognised gets one default font — Inter.
export async function resolveStack(stack, text, fonts) {
  const fam = firstFamily(stack);
  if (!fam) return FALLBACK_FAMILY;
  for (const name of nameVariants(fam)) {
    if (!similarFor(name) && (await fonts.isOnGoogle(name, text))) return name;
  }
  return similarFor(fam) || FALLBACK_FAMILY;
}

// ---- Fonts the page itself uses (@font-face) ----

const parseWeight = (w) => {
  const map = { normal: 400, bold: 700, lighter: 300, bolder: 700 };
  const parts = String(w || "400").trim().split(/\s+/).map((x) => map[x] ?? Number(x));
  return { min: parts[0] || 400, max: parts[1] || parts[0] || 400 };
};

// Parse @font-face blocks from CSS text; relative URLs resolve against baseUrl.
export function parseFontFaces(cssText, baseUrl) {
  const faces = [];
  for (const m of cssText.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const body = m[1];
    const prop = (name) => body.match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, "i"))?.[1].trim();
    const family = prop("font-family")?.replace(/^["']|["']$/g, "");
    const src = prop("src");
    if (!family || !src) continue;
    const urls = [];
    for (const u of src.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/g)) {
      try {
        const url = new URL(u[2], baseUrl).href;
        if (!/\.(eot|svg)(\?|#|$)/i.test(url)) urls.push(url);
      } catch {}
    }
    if (!urls.length) continue;
    const weight = parseWeight(prop("font-weight"));
    faces.push({
      family: family.toLowerCase(),
      weightMin: weight.min,
      weightMax: weight.max,
      italic: /italic|oblique/i.test(prop("font-style") || ""),
      unicodeRange: prop("unicode-range") || "",
      urls,
    });
  }
  return faces;
}

// The page's own file for a request. Skipped (→ Google Fonts) for variable fonts (one file
// for a weight range: the converter can't apply the axis) and unicode-range subsets (the
// converter takes a single file per style).
function pickPageFace(faces, { family, weight, italic }) {
  const own = faces.filter((f) => f.family === family.toLowerCase());
  if (!own.length) return null;
  const sameStyle = own.filter((f) => f.italic === italic);
  const pool = sameStyle.length ? sameStyle : own;
  const dist = (f) => (weight < f.weightMin ? f.weightMin - weight : weight > f.weightMax ? weight - f.weightMax : 0);
  const best = pool.reduce((a, b) => (dist(b) < dist(a) ? b : a));
  const siblings = pool.filter((f) => f.weightMin === best.weightMin && f.weightMax === best.weightMax);
  if (best.weightMin !== best.weightMax || siblings.some((f) => f.unicodeRange)) return null;
  return best;
}
