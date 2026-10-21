// Typography check: captures a page and compares every Figma TEXT node with the
// browser's rendering of its source DOM text.
// Usage: node verify.mjs <url> [width] [block selector]
import { decodeFigmaData } from "@figit/fig-kiwi";
import { capturePage, closeBrowser } from "./capture.mjs";

const url = process.argv[2];
const width = Number(process.argv[3]) || 1440;
const targetSelector = process.argv[4] || "";
if (!url) {
  console.error("Usage: node verify.mjs <url> [width] [block selector]");
  process.exit(1);
}

// Runs in the page: DOM truth for every traced text node.
function domTruth([entries, targetSelector]) {
  const canvas = document.createElement("canvas").getContext("2d");
  const root = targetSelector ? document.querySelector(targetSelector) : document.body;
  // In block mode message coordinates are relative to the block, not the document.
  const rootRect = targetSelector ? root.getBoundingClientRect() : null;
  const originTop = rootRect ? rootRect.top : -window.scrollY;
  const originLeft = rootRect ? rootRect.left : 0;
  const out = {};
  for (const e of entries) {
    const m = e.domPath.match(/^(.*)::text\[(\d+)\]$/);
    const elPath = m ? m[1] : e.domPath;
    const owner = elPath === ":scope" ? root : root.querySelector(elPath);
    if (!owner) continue;
    const textNode = m ? owner.childNodes[Number(m[2])] : owner;
    const el = textNode.nodeType === 3 ? textNode.parentElement : textNode;
    const cs = getComputedStyle(el);
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0);
    if (!rects.length) continue;
    const tops = [];
    for (const r of rects) if (!tops.some((t) => Math.abs(t - r.top) < 2)) tops.push(r.top);
    const first = rects[0];
    canvas.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const asc = canvas.measureText("Hg").fontBoundingBoxAscent;
    const lh = parseFloat(cs.lineHeight);
    out[`${e.guid.sessionID}:${e.guid.localID}`] = {
      text: textNode.textContent.trim().slice(0, 40),
      fontSize: parseFloat(cs.fontSize),
      lineHeight: lh,
      letterSpacing:
        cs.letterSpacing === "normal" ? 0
        : cs.letterSpacing.endsWith("%") ? (parseFloat(cs.letterSpacing) / 100) * parseFloat(cs.fontSize)
        : cs.letterSpacing.endsWith("em") ? parseFloat(cs.letterSpacing) * parseFloat(cs.fontSize)
        : parseFloat(cs.letterSpacing),
      textTransform: cs.textTransform,
      textAlign: cs.textAlign,
      decoration: cs.textDecorationLine,
      weight: Number(cs.fontWeight),
      lines: tops.length,
      // Top of the first CSS line box (content area centred in line-height) and baseline.
      lineTop: first.top + window.scrollY - originTop - (lh - first.height) / 2,
      baseline: first.top + window.scrollY - originTop + asc,
      left: first.left - originLeft,
      width: el.getBoundingClientRect().width,
    };
  }
  return out;
}

const { clipboardHtml, inspected: truth } = await capturePage({
  url,
  width,
  targetSelector,
  inspect: (page, trace) => page.evaluate(domTruth, [trace.entries.filter((e) => e.kind === "text"), targetSelector]),
});
await closeBrowser();
const message = decodeFigmaData(Buffer.from(clipboardHtml.match(/\(figma\)([^(]*)\(\/figma\)/)[1], "base64")).message;

const byId = new Map(message.nodeChanges.map((n) => [`${n.guid.sessionID}:${n.guid.localID}`, n]));
const absPos = (n) => {
  let x = 0, y = 0;
  for (let c = n; c && c.type !== "CANVAS"; c = c.parentIndex && byId.get(`${c.parentIndex.guid.sessionID}:${c.parentIndex.guid.localID}`)) {
    x += c.transform?.m02 || 0;
    y += c.transform?.m12 || 0;
  }
  return { x, y };
};

const CASE = { none: undefined, uppercase: "UPPER", lowercase: "LOWER", capitalize: "TITLE" };
const ALIGN = { left: "LEFT", center: "CENTER", right: "RIGHT", justify: "JUSTIFIED" };
const DECOR = { none: undefined, underline: "UNDERLINE", "line-through": "STRIKETHROUGH" };
const issues = {};
const add = (k, msg) => (issues[k] ||= []).push(msg);
let checked = 0;

for (const [id, t] of Object.entries(truth)) {
  const n = byId.get(id);
  if (!n || n.type !== "TEXT") continue;
  checked++;
  const label = JSON.stringify(t.text);
  const near = (a, b, tol = 0.6) => Math.abs(a - b) <= tol;
  if (!near(n.fontSize, t.fontSize, 0.01)) add("fontSize", `${label}: ${n.fontSize} vs ${t.fontSize}`);
  if (!near(n.lineHeight?.value, t.lineHeight, 0.05) || n.lineHeight?.units !== "PIXELS")
    add("lineHeight", `${label}: ${n.lineHeight?.value}${n.lineHeight?.units} vs ${t.lineHeight}px`);
  if (!near(n.letterSpacing?.value || 0, t.letterSpacing, 0.01))
    add("letterSpacing", `${label}: ${n.letterSpacing?.value} vs ${t.letterSpacing}`);
  if (n.textCase !== CASE[t.textTransform]) add("textCase", `${label}: ${n.textCase} vs ${t.textTransform}`);
  if (n.textDecoration !== DECOR[t.decoration] && t.decoration !== "none")
    add("decoration", `${label}: ${n.textDecoration} vs ${t.decoration}`);
  if ((n.textAlignHorizontal || "LEFT") !== (ALIGN[t.textAlign] || "LEFT") && t.lines > 1)
    add("textAlign", `${label}: ${n.textAlignHorizontal} vs ${t.textAlign}`);
  const lines = n.derivedTextData?.baselines?.length || 1;
  if (lines !== t.lines) add("lines", `${label}: ${lines} vs ${t.lines}`);
  const p = absPos(n);
  if (!near(p.y, t.lineTop, 1)) add("top (line box)", `${label}: ${p.y.toFixed(1)} vs ${t.lineTop.toFixed(1)} (Δ${(p.y - t.lineTop).toFixed(1)})`);
  const bl = p.y + (n.derivedTextData?.baselines?.[0]?.position?.y ?? 0);
  if (!near(bl, t.baseline, 1)) add("baseline", `${label}: ${bl.toFixed(1)} vs ${t.baseline.toFixed(1)} (Δ${(bl - t.baseline).toFixed(1)})`);
  // Ink start of the first line: box x + first glyph x (glyph positions include alignment).
  const b0 = n.derivedTextData?.baselines?.[0];
  const g0 = n.derivedTextData?.glyphs?.[0];
  const inkLeft = p.x + (g0?.position?.x ?? b0?.position?.x ?? 0);
  if (!near(inkLeft, t.left, 1.5)) add("left", `${label}: ${inkLeft.toFixed(1)} vs ${t.left.toFixed(1)} (box ${p.x.toFixed(1)}, align ${n.textAlignHorizontal})`);
}

console.log(`\nChecked ${checked} text layers on ${url} @${width}px`);
const props = ["fontSize", "lineHeight", "letterSpacing", "textCase", "decoration", "textAlign", "lines", "top (line box)", "baseline", "left"];
for (const k of props) {
  const list = issues[k] || [];
  console.log(`${list.length ? "✗" : "✓"} ${k.padEnd(15)} ${list.length} mismatches`);
  for (const m of list.slice(0, 6)) console.log("    " + m);
}
