// Icon fonts (Font Awesome, Linearicons, slick…) are not available in Figma, so their
// glyphs would paste as missing characters. Before conversion each icon-font element is
// rendered to a PNG and the matching TEXT layer is turned into an image fill.
import { sha1 } from "./bytes.js";
import { firstFamily } from "./fonts.js";

export const ICON_FONT = /icon|awesome|lucide|material|symbol|glyph|feather|remix|ionic|dashicons|slick|social|^fa[-\s]/i;
const IDENTITY = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
const ownText = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();

/** Map(Element → PNG bytes) for every element drawn with an icon font. */
export async function rasterizeIconFonts(roots) {
  const icons = new Map();
  const seen = new Set();
  const scale = 4;
  for (const root of roots) {
    for (const el of [root, ...root.querySelectorAll("*")]) {
      if (seen.has(el) || el.closest("svg")) continue;
      const text = ownText(el);
      if (!text) continue;
      const cs = getComputedStyle(el);
      if (!ICON_FONT.test(firstFamily(cs.fontFamily))) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.width > 512 || r.height > 512) continue;
      const canvas = new OffscreenCanvas(Math.max(1, Math.ceil(r.width * scale)), Math.max(1, Math.ceil(r.height * scale)));
      const ctx = canvas.getContext("2d");
      ctx.scale(scale, scale);
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      ctx.fillStyle = cs.color;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillText(text, 0, r.height / 2);
      const blob = await canvas.convertToBlob({ type: "image/png" });
      icons.set(el, new Uint8Array(await blob.arrayBuffer()));
      seen.add(el);
    }
  }
  return icons;
}

/** Replace converted TEXT layers of icon-font elements with the rendered images. */
export function applyIconFonts(message, trace, icons, resolveElement) {
  if (!icons.size) return 0;
  const byId = new Map(message.nodeChanges.map((n) => [`${n.guid.sessionID}:${n.guid.localID}`, n]));
  const done = new Set();
  let applied = 0;
  for (const entry of trace.entries) {
    if (entry.kind !== "text") continue;
    const elPath = entry.domPath.replace(/::text\[\d+\]$/, "");
    const el = resolveElement(elPath);
    const png = el && icons.get(el);
    const node = png && byId.get(`${entry.guid.sessionID}:${entry.guid.localID}`);
    if (!node) continue;
    if (done.has(el)) {
      node.phase = "REMOVED";
      continue;
    }
    done.add(el);
    const blob = message.blobs.push({ bytes: png }) - 1;
    node.type = "RECTANGLE";
    node.name = "Icon";
    node.fillPaints = [
      {
        type: "IMAGE",
        opacity: 1,
        visible: true,
        blendMode: "NORMAL",
        transform: IDENTITY,
        image: { hash: Array.from(sha1(png)), dataBlob: blob },
        imageScaleMode: "FILL",
      },
    ];
    node.strokePaints = [];
    node.effects = [];
    node.cornerRadius = 0;
    for (const key of [
      "textData",
      "fontName",
      "derivedTextData",
      "fontSize",
      "fontWeight",
      "lineHeight",
      "letterSpacing",
      "textAlignHorizontal",
      "textAlignVertical",
      "textCase",
      "textDecoration",
      "textAutoResize",
      "fontVariantCommonLigatures",
      "fontVariantContextualLigatures",
      "fontVariantDiscretionaryLigatures",
      "fontVersion",
      "textUserLayoutVersion",
      "textBidiVersion",
      "textExplicitLayoutVersion",
    ]) delete node[key];
    applied++;
  }
  return applied;
}
