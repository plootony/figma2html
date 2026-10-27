// CSS backgrounds. The converter only understands a single gradient in background-image;
// url() layers (photos, patterns, decorations) and every layer after the first were lost.
// Here each element with such a background gets a clipped "Background" frame as its
// bottom child, holding all layers in paint order: images as tiles honouring
// background-size / -position / -repeat / -origin / -clip, gradients as rectangles.
// Runs in the page after conversion, while the prepared DOM still matches the trace.
import { base64ToBytes, sha1 } from "./bytes.js";

const IDENTITY = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
// Up to this many tiles per layer are separate rectangles (exact geometry); beyond that one
// rectangle with a Figma TILE image fill covers the area (needs a uniform scale).
const MAX_SEPARATE_TILES = 60;

// Split a computed list value on top-level commas: "url(a), linear-gradient(x, y)".
function splitLayers(value) {
  const out = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(value.slice(start).trim());
  return out.filter(Boolean);
}

// Per-layer value of a list property (CSS repeats the list to match the layer count).
const layerValue = (list, i) => list[i % list.length];

const hasUrl = (bg) => /url\(/.test(bg || "");
export const hasUrlBackground = (el) => hasUrl(getComputedStyle(el).backgroundImage);

// "calc(100% - 40px)", "50%", "12px" → value along an axis of free space `free`.
export function resolvePosition(v, free) {
  v = v.trim();
  const calc = v.match(/^calc\((.*)\)$/);
  const expr = calc ? calc[1] : v;
  let total = 0;
  for (const m of expr.replace(/\s*([+-])\s*/g, " $1").matchAll(/([+-]?\s*[\d.]+)(%|px)?/g)) {
    const n = parseFloat(m[1].replace(/\s/g, ""));
    total += m[2] === "%" ? (n / 100) * free : n;
  }
  return total;
}

export function tileSize(sizeValue, box, natural) {
  const ratio = natural.w / natural.h;
  if (sizeValue === "cover" || sizeValue === "contain") {
    const s = (sizeValue === "cover" ? Math.max : Math.min)(box.w / natural.w, box.h / natural.h);
    return { w: natural.w * s, h: natural.h * s };
  }
  const [a, b = "auto"] = sizeValue.split(/\s+/);
  const len = (v, full) => (v.endsWith("%") ? (parseFloat(v) / 100) * full : parseFloat(v));
  let w = a === "auto" ? null : len(a, box.w);
  let h = b === "auto" ? null : len(b, box.h);
  if (w == null && h == null) return { w: natural.w, h: natural.h };
  if (w == null) w = h * ratio;
  if (h == null) h = w / ratio;
  return { w, h };
}

function repeatAxes(value) {
  const map = { "repeat-x": ["repeat", "no-repeat"], "repeat-y": ["no-repeat", "repeat"] };
  const [x, y = x] = map[value] || value.split(/\s+/);
  const on = (v) => v === "repeat" || v === "space" || v === "round";
  return { x: on(x), y: on(y) };
}

// Start positions of tiles along one axis, covering [clipStart, clipEnd).
function tileStarts(pos, size, repeat, clipStart, clipEnd) {
  if (!repeat || size < 0.5) return [pos];
  let start = pos - Math.ceil((pos - clipStart) / size) * size;
  const out = [];
  for (; start < clipEnd && out.length < 100000; start += size) out.push(start);
  return out;
}

function boxes(el) {
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const px = (v) => parseFloat(v) || 0;
  const b = { t: px(cs.borderTopWidth), r: px(cs.borderRightWidth), bo: px(cs.borderBottomWidth), l: px(cs.borderLeftWidth) };
  const p = { t: px(cs.paddingTop), r: px(cs.paddingRight), bo: px(cs.paddingBottom), l: px(cs.paddingLeft) };
  const border = { x: 0, y: 0, w: r.width, h: r.height };
  const padding = { x: b.l, y: b.t, w: r.width - b.l - b.r, h: r.height - b.t - b.bo };
  const content = { x: b.l + p.l, y: b.t + p.t, w: padding.w - p.l - p.r, h: padding.h - p.t - p.bo };
  return { "border-box": border, "padding-box": padding, "content-box": content };
}

// Decode an image: natural size, plus PNG bytes for formats Figma can't take (SVG).
async function decodeImage(bytes, mime, target) {
  if (mime.includes("svg") || /^\s*</.test(new TextDecoder().decode(bytes.subarray(0, 64)))) {
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/svg+xml" }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const natural = { w: img.naturalWidth || 300, h: img.naturalHeight || 150 };
      const scale = Math.min(4, Math.max(1, (2 * (target?.w || natural.w)) / natural.w));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(natural.w * scale));
      canvas.height = Math.max(1, Math.round(natural.h * scale));
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      const png = new Uint8Array(await (await new Promise((r) => canvas.toBlob(r, "image/png"))).arrayBuffer());
      return { natural, pixels: { w: canvas.width, h: canvas.height }, bytes: png };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
  const natural = { w: bmp.width, h: bmp.height };
  bmp.close();
  return { natural, pixels: natural, bytes };
}

export async function addBackgroundImages(message, trace, net, resolveElement) {
  const key = (g) => `${g.sessionID}:${g.localID}`;
  const byId = new Map(message.nodeChanges.map((n) => [key(n.guid), n]));
  let nextId = Math.max(...message.nodeChanges.map((n) => (n.guid.sessionID === 0 ? n.guid.localID : 0))) + 1;
  const newGuid = () => ({ sessionID: 0, localID: nextId++ });
  const images = new Map(); // url -> Promise<{ paint, natural } | null>
  const cssBackground = globalThis.__s2fCssBackground; // exposed by the build patch

  const loadImage = (url) => {
    if (!images.has(url)) {
      images.set(
        url,
        (async () => {
          const r = url.startsWith("data:")
            ? await fetch(url).then(async (res) => ({ bytes: new Uint8Array(await res.arrayBuffer()), mime: res.headers.get("content-type") || "" }))
            : await net.get(url).then((x) => ({ bytes: base64ToBytes(x.b64), mime: x.mime || "" }));
          const { natural, pixels, bytes } = await decodeImage(r.bytes, r.mime);
          const blob = message.blobs.push({ bytes }) - 1;
          const paint = {
            type: "IMAGE",
            opacity: 1,
            visible: true,
            blendMode: "NORMAL",
            transform: IDENTITY,
            image: { hash: Array.from(sha1(bytes)), dataBlob: blob },
            imageScaleMode: "STRETCH",
          };
          return { paint, natural, pixels };
        })().catch(() => null)
      );
    }
    return images.get(url);
  };

  let added = 0;
  for (const e of trace.entries) {
    if (e.domPath.includes("::text")) continue;
    const n = byId.get(key(e.guid));
    if (!n || n.type !== "FRAME" || !n.size) continue;
    if (n.transform && (Math.abs(n.transform.m01) > 1e-6 || Math.abs(n.transform.m00 - 1) > 1e-6)) continue; // rotated/scaled
    const el = resolveElement(e.domPath);
    if (!el) continue;
    const cs = getComputedStyle(el);
    if (cs.backgroundClip.includes("text")) continue;
    const layers = splitLayers(cs.backgroundImage === "none" ? "" : cs.backgroundImage);
    if (!layers.length || (layers.length === 1 && !hasUrl(layers[0]))) continue; // single gradient: converter handles it

    const box = boxes(el);
    const lists = {
      size: splitLayers(cs.backgroundSize),
      posX: splitLayers(cs.backgroundPositionX),
      posY: splitLayers(cs.backgroundPositionY),
      repeat: splitLayers(cs.backgroundRepeat),
      origin: splitLayers(cs.backgroundOrigin),
      clip: splitLayers(cs.backgroundClip),
    };
    // One clip area for the whole background (the bottom layer's clip, as for background-color).
    const clip = box[layerValue(lists.clip, layers.length - 1)] || box["border-box"];
    const frame = {
      guid: newGuid(),
      phase: "CREATED",
      parentIndex: { guid: n.guid, position: "-1" },
      type: "FRAME",
      name: "Background",
      visible: true,
      opacity: 1,
      size: { x: clip.w, y: clip.h },
      transform: { ...IDENTITY, m02: clip.x, m12: clip.y },
      strokeWeight: 0,
      strokeAlign: "INSIDE",
      strokeJoin: "MITER",
      fillPaints: [],
      strokePaints: [],
      effects: [],
      frameMaskDisabled: false,
      stackMode: "NONE",
      ...(n.stackMode && n.stackMode !== "NONE" && { stackPositioning: "ABSOLUTE" }),
    };
    for (const f of ["cornerRadius", "rectangleTopLeftCornerRadius", "rectangleTopRightCornerRadius", "rectangleBottomLeftCornerRadius", "rectangleBottomRightCornerRadius", "rectangleCornerRadiiIndependent"]) {
      if (n[f] !== undefined) frame[f] = n[f];
    }
    const children = [];
    // CSS lists the top layer first; Figma paints children bottom-up.
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      const origin = box[layerValue(lists.origin, i)] || box["padding-box"];
      if (!hasUrl(layer)) {
        const paints = cssBackground ? cssBackground(layer, { width: origin.w, height: origin.h }) : [];
        if (!paints.length) continue;
        children.push({ name: "Gradient", x: origin.x - clip.x, y: origin.y - clip.y, w: origin.w, h: origin.h, paints });
        continue;
      }
      const url = layer.match(/url\((["']?)(.*?)\1\)/)?.[2];
      const img = url && (await loadImage(url));
      if (!img) continue;
      const t = tileSize(layerValue(lists.size, i), origin, img.natural);
      const rep = repeatAxes(layerValue(lists.repeat, i));
      const px = origin.x + resolvePosition(layerValue(lists.posX, i), origin.w - t.w);
      const py = origin.y + resolvePosition(layerValue(lists.posY, i), origin.h - t.h);
      const xs = tileStarts(px, t.w, rep.x, clip.x, clip.x + clip.w);
      const ys = tileStarts(py, t.h, rep.y, clip.y, clip.y + clip.h);
      const scaleX = t.w / img.pixels.w;
      const uniform = Math.abs(scaleX - t.h / img.pixels.h) < 0.01 * scaleX;
      if (xs.length * ys.length > MAX_SEPARATE_TILES && uniform) {
        // One rectangle from the first tile to the clip edge; Figma repeats the image.
        const x0 = xs[0], y0 = ys[0];
        const w = rep.x ? clip.x + clip.w - x0 : t.w;
        const h = rep.y ? clip.y + clip.h - y0 : t.h;
        const paint = { ...img.paint, imageScaleMode: "TILE", scale: scaleX, originalImageWidth: img.pixels.w, originalImageHeight: img.pixels.h };
        children.push({ name: "Background pattern", x: x0 - clip.x, y: y0 - clip.y, w, h, paints: [paint] });
        continue;
      }
      for (const y of ys.slice(0, MAX_SEPARATE_TILES)) {
        for (const x of xs.slice(0, MAX_SEPARATE_TILES)) {
          if (x >= clip.x + clip.w || y >= clip.y + clip.h || x + t.w <= clip.x || y + t.h <= clip.y) continue;
          children.push({ name: "Background image", x: x - clip.x, y: y - clip.y, w: t.w, h: t.h, paints: [img.paint] });
        }
      }
    }
    if (!children.length) continue;

    message.nodeChanges.push(frame);
    children.forEach((c, idx) => {
      message.nodeChanges.push({
        guid: newGuid(),
        phase: "CREATED",
        parentIndex: { guid: frame.guid, position: String(idx) },
        type: "ROUNDED_RECTANGLE",
        name: c.name,
        visible: true,
        opacity: 1,
        size: { x: c.w, y: c.h },
        transform: { ...IDENTITY, m02: c.x, m12: c.y },
        cornerRadius: 0,
        strokeWeight: 0,
        strokeAlign: "INSIDE",
        strokeJoin: "MITER",
        fillPaints: c.paints.map((p) => ({ ...p })),
        strokePaints: [],
        effects: [],
      });
    });
    // The converter may have put the first gradient on the frame itself; it now lives in
    // the Background frame, above background-color.
    n.fillPaints = (n.fillPaints || []).filter((p) => !p.type.startsWith("GRADIENT"));
    added++;
  }
  return added;
}
