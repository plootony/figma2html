// CSS breakpoints for the width picker: reads every stylesheet (including cross-origin
// ones through the background) and extracts widths from @media conditions.

const RANGE = 3840;
const MIN = 240;
const UNIT = { px: 1, em: 16, rem: 16, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54 };
const WIDTH_VALUE = /(?:min|max)-(?:device-)?width\s*:\s*([\d.]+)\s*(px|em|rem|pt|pc|in|cm)\b/gi;
const VALUE_LEFT = /([\d.]+)\s*(px|em|rem|pt|pc|in|cm)\s*(<=|<|>=|>)\s*width\b/gi;
const WIDTH_LEFT = /width\s*(<=|<|>=|>)\s*([\d.]+)\s*(px|em|rem|pt|pc|in|cm)\b/gi;

const toPx = (value, unit) => parseFloat(value) * (UNIT[unit.toLowerCase()] || 1);
const strictEdge = (value, op) => (op === "<" ? value - 1 : op === ">" ? value + 1 : value);
const INVERSE = { "<": ">", ">": "<", "<=": ">=", ">=": "<=" };

function widthsFromCondition(condition) {
  if (!condition || (/\bprint\b/i.test(condition) && !/\bscreen\b/i.test(condition))) return [];
  const out = [];
  for (const m of condition.matchAll(WIDTH_VALUE)) {
    const px = toPx(m[1], m[2]);
    const max = /^max/i.test(m[0]);
    out.push({ width: max ? Math.floor(px) : Math.ceil(px), min: !max, max });
  }
  // "600px < width" means width is strictly greater than 600.
  for (const m of condition.matchAll(VALUE_LEFT)) {
    out.push({ width: Math.ceil(strictEdge(toPx(m[1], m[2]), INVERSE[m[3]])) });
  }
  for (const m of condition.matchAll(WIDTH_LEFT)) {
    out.push({ width: Math.floor(strictEdge(toPx(m[2], m[3]), m[1])) });
  }
  return out;
}

function importUrls(css, base) {
  const out = [];
  for (const m of css.matchAll(/@import\s+(?:url\(\s*["']?([^"')]+)["']?\s*\)|["']([^"']+)["'])/gi)) {
    try {
      out.push(new URL(m[1] || m[2], base).href);
    } catch {}
  }
  return out;
}

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

/** Returns sorted widths (px) at which the site changes its layout. */
export async function scanBreakpoints(net) {
  const conditions = [];
  const seenHrefs = new Set();
  const queue = [];

  const readCss = (css, base) => {
    for (const m of css.matchAll(/@media\s+([^{]+)\{/gi)) conditions.push(m[1].trim());
    for (const href of importUrls(css, base)) loadSheet(href);
  };
  const loadSheet = (href) => {
    if (!href || seenHrefs.has(href)) return;
    seenHrefs.add(href);
    queue.push(net.text(href).then((css) => readCss(css, href)).catch(() => {}));
  };
  const walkRules = (rules, base) => {
    for (const rule of rules) {
      if (rule.type === CSSRule.MEDIA_RULE) conditions.push(rule.conditionText || rule.media?.mediaText || "");
      if (rule.type === CSSRule.IMPORT_RULE) {
        if (rule.styleSheet) walkSheet(rule.styleSheet);
        else if (rule.href) loadSheet(new URL(rule.href, base).href);
        continue;
      }
      if (rule.cssRules) walkRules(rule.cssRules, base);
    }
  };
  const walkSheet = (sheet) => {
    const base = sheet.href || document.baseURI;
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      if (sheet.href) loadSheet(sheet.href);
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

  const widths = new Set();
  const mins = [];
  const maxs = [];
  for (const condition of conditions) {
    for (const entry of widthsFromCondition(condition)) {
      if (!Number.isFinite(entry.width)) continue;
      if (entry.width >= MIN && entry.width <= RANGE) widths.add(entry.width);
      if (entry.min) mins.push(entry.width);
      if (entry.max) maxs.push(entry.width);
    }
  }
  // A layout below the smallest min-width / above the largest max-width has no explicit
  // breakpoint; one pixel outside the boundary is a valid representative width.
  if (mins.length) {
    const smallest = Math.min(...mins);
    if (smallest > MIN) widths.add(smallest - 1);
  }
  if (maxs.length) {
    const largest = Math.max(...maxs);
    if (largest < RANGE) widths.add(largest + 1);
  }
  return [...widths].filter((w) => w >= MIN && w <= RANGE).sort((a, b) => a - b);
}
