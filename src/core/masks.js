// CSS mask icons: `mask-image: url(icon.svg)` over a background colour. The converter ignores
// masks, so such an icon came out as a plain rectangle of its colour (or not at all). Before
// conversion each one is replaced with what it shows:
// - a simple SVG (plain shapes) centred by contain/cover/100% → an inline <svg> painted in the
//   icon's colour: vectors in Figma;
// - anything else → the masked colour drawn to a PNG background, which backgrounds.js turns
//   into an image layer.
import { complexity, fetchSvgText, isSvgUrl } from "./svg.js";
import { resolvePosition, tileSize } from "./backgrounds.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const PRESERVE = { contain: "xMidYMid meet", cover: "xMidYMid slice", "100% 100%": "none" };

const maskOf = (cs) => {
  const image = cs.maskImage && cs.maskImage !== "none" ? cs.maskImage : cs.webkitMaskImage;
  const url = /^url\((["']?)(.*?)\1\)$/.exec((image || "").trim())?.[2];
  if (!url) return null;
  const pick = (prop) => cs[prop] || cs[`webkit${prop[0].toUpperCase()}${prop.slice(1)}`] || "";
  return { url, size: pick("maskSize") || "auto", position: pick("maskPosition") || "0% 0%", repeat: pick("maskRepeat") || "repeat" };
};

const loadImage = (src) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });

// The SVG as inline vectors in `color`, or null when a mask this simple can't show it.
function vectorIcon(text, mask, color, box) {
  const preserve = PRESERVE[mask.size];
  if (!preserve || !/^50% 50%$|^center/.test(mask.position)) return null;
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const src = doc.documentElement;
  if (src.localName !== "svg" || doc.querySelector("parsererror") || complexity(src)) return null;
  const svg = document.importNode(src, true);
  if (!svg.getAttribute("viewBox")) {
    const w = parseFloat(src.getAttribute("width")) || box.w;
    const h = parseFloat(src.getAttribute("height")) || box.h;
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  }
  svg.setAttribute("preserveAspectRatio", preserve);
  svg.setAttribute("width", box.w);
  svg.setAttribute("height", box.h);
  svg.style.cssText = "display:block;width:100%;height:100%;color:inherit";
  return svg;
}

// A mask shows its own alpha in the element's colour: every painted shape becomes that colour.
function paintShapes(svg, color) {
  for (const shape of svg.querySelectorAll("path, rect, circle, ellipse, line, polyline, polygon")) {
    const cs = getComputedStyle(shape);
    shape.style.setProperty("fill", cs.fill === "none" ? "none" : color);
    shape.style.setProperty("stroke", cs.stroke === "none" ? "none" : color);
  }
}

// The masked colour as a PNG, laid out like the mask (mask-size / -position, no repeat).
async function rasterIcon(url, mask, color, box) {
  const img = await loadImage(url);
  const natural = { w: img.naturalWidth || box.w, h: img.naturalHeight || box.h };
  const size = tileSize(mask.size, box, natural);
  const [px, py = "50%"] = mask.position.split(/\s+(?![^(]*\))/);
  const x = resolvePosition(px, box.w - size.w);
  const y = resolvePosition(py, box.h - size.h);
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(box.w * scale));
  canvas.height = Math.max(1, Math.round(box.h * scale));
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  ctx.drawImage(img, x, y, size.w, size.h);
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, box.w, box.h);
  return canvas.toDataURL("image/png");
}

/** Replace mask icons inside `roots` with their picture. Returns how many were replaced. */
export async function prepareMaskIcons(journal, net, roots) {
  const candidates = [];
  for (const root of roots) {
    for (const el of [root, ...root.querySelectorAll("*")]) {
      if (el.children.length || el.closest("svg")) continue;
      const cs = getComputedStyle(el);
      const mask = maskOf(cs);
      const r = mask && el.getBoundingClientRect();
      // Only a solid colour through the mask: a gradient or image behind it isn't an icon.
      if (!r || r.width < 1 || r.height < 1 || cs.backgroundImage !== "none") continue;
      candidates.push({ el, cs, mask, box: { w: r.width, h: r.height } });
    }
  }
  const texts = new Map();
  let replaced = 0;
  for (const { el, cs, mask, box } of candidates) {
    const color = cs.backgroundColor;
    const url = new URL(mask.url, document.baseURI).href;
    try {
      let svg = null;
      if (isSvgUrl(url) || mask.url.startsWith("data:image/svg")) {
        if (!texts.has(url)) texts.set(url, fetchSvgText(url, net).catch(() => null));
        const text = await texts.get(url);
        svg = text && vectorIcon(text, mask, color, box);
      }
      for (const prop of ["mask-image", "-webkit-mask-image"]) journal.set(el, prop, "none");
      journal.set(el, "background-color", "transparent");
      if (svg) {
        // The icon fills the element's border box, like the mask did.
        journal.set(el, "box-sizing", "border-box");
        journal.set(el, "padding", "0");
        journal.set(el, "width", `${box.w}px`);
        journal.set(el, "height", `${box.h}px`);
        el.appendChild(svg);
        journal.add(svg);
        paintShapes(svg, color);
      } else {
        // Raster: the mask file as bytes (no CORS limits), drawn into the colour.
        let src = url;
        if (!url.startsWith("data:")) {
          const r = await net.get(url);
          src = `data:${r.mime || "image/svg+xml"};base64,${r.b64}`;
        }
        journal.set(el, "background-image", `url("${await rasterIcon(src, mask, color, box)}")`);
        for (const [prop, value] of [["background-size", "100% 100%"], ["background-position", "0 0"], ["background-repeat", "no-repeat"], ["background-origin", "border-box"], ["background-clip", "border-box"]]) {
          journal.set(el, prop, value);
        }
      }
      replaced++;
    } catch (e) {
      console.warn("site2figma: mask icon", url, e);
    }
  }
  return replaced;
}
