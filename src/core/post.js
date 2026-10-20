// Post-processing of the dom-to-figma message: repairs, text box rules, image downscaling,
// clipboard HTML and the .fig file. Runs in the browser (extension, headless Chrome).
import { decodeFigmaData, encodeFigmaData, composeClipboardHtml } from "@figit/fig-kiwi";
import { inflateSync, zipSync, strToU8 } from "fflate";
import { base64ToBytes, sha1, toHex, zstdStore } from "./bytes.js";

// .fig versions known to be accepted by Figma import: 101, 105, 106.
const FIG_VERSION = 101;
const CANVAS_BG = { r: 0.9607843160629272, g: 0.9607843160629272, b: 0.9607843160629272, a: 1 };

export function decodePayload(base64) {
  return decodeFigmaData(base64ToBytes(base64)).message;
}

// The converter occasionally emits NaN (e.g. cornerRadius, strokeWeight) — Figma runs out of memory on it.
export function sanitize(message) {
  let fixed = 0;
  const walk = (obj) => {
    if (!obj || typeof obj !== "object" || ArrayBuffer.isView(obj)) return;
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        if (typeof obj[i] === "number" && !Number.isFinite(obj[i])) {
          obj[i] = 0;
          fixed++;
        } else walk(obj[i]);
      }
      return;
    }
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === "number" && !Number.isFinite(v)) {
        delete obj[k];
        fixed++;
      } else walk(v);
    }
  };
  for (const node of message.nodeChanges) walk(node);
  return fixed;
}

// Glyphs without an outline (non-breaking space, characters missing from the font) come
// out pointing at blob 0, which is some letter's outline — Figma draws that letter instead.
// Cyrillic letters that share outlines with Latin ones (fonts reuse the same glyph):
const HOMOGLYPHS = { А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", Х: "X", а: "a", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x", і: "i", ј: "j", ѕ: "s", Ѕ: "S", І: "I", Ј: "J" };
const skeleton = (ch) => HOMOGLYPHS[ch] || ch;

export function fixBlankGlyphs(message) {
  const blank = /[\s​-‍⁠﻿]/;
  let emptyIdx = message.blobs.findIndex((b) => b.bytes.length === 1 && b.bytes[0] === 0);
  // Blob indices are assigned in order of first use, so the first glyph referencing
  // blob 0 (per font) is its real owner; other characters on blob 0 are strays.
  const owner = new Map();
  const isStray = (n, g, ch) => {
    if (g.commandsBlob !== 0) return false;
    const key = JSON.stringify(n.fontName);
    const o = owner.get(key);
    if (!o) {
      owner.set(key, ch);
      return false;
    }
    return skeleton(ch) !== skeleton(o);
  };
  let fixed = 0;
  for (const n of message.nodeChanges) {
    if (n.type !== "TEXT") continue;
    const chars = n.textData?.characters || "";
    for (const g of n.derivedTextData?.glyphs || []) {
      const ch = chars[g.firstCharacter] || "";
      const stray = isStray(n, g, ch);
      if (!stray && !blank.test(ch)) continue;
      if (message.blobs[g.commandsBlob]?.bytes.length <= 1) continue;
      if (emptyIdx < 0) emptyIdx = message.blobs.push({ bytes: new Uint8Array([0]) }) - 1;
      g.commandsBlob = emptyIdx;
      fixed++;
    }
  }
  return fixed;
}

// Center/right alignment: the converter offsets lines inside (box width + safety buffer)
// and ignores the letter-spacing after the last glyph, shifting lines by a few px.
// Re-align each line inside the real box, as CSS does (trailing spaces hang).
function realignLines(n) {
  const align = n.textAlignHorizontal;
  if (align !== "CENTER" && align !== "RIGHT") return;
  const d = n.derivedTextData;
  if (!d?.baselines?.length || !d.glyphs?.length) return;
  const W = n.size.x;
  const ls = n.letterSpacing?.units === "PIXELS" ? n.letterSpacing.value || 0 : 0;
  const chars = n.textData?.characters || "";
  for (const b of d.baselines) {
    const glyphs = d.glyphs.filter((g) => g.firstCharacter >= b.firstCharacter && g.firstCharacter < b.endCharacter);
    const ink = glyphs.filter((g) => !/\s/.test(chars[g.firstCharacter] || ""));
    if (!ink.length) continue;
    const start = ink[0].position.x;
    const last = ink[ink.length - 1];
    const lineWidth = last.position.x + last.advance * last.fontSize + ls - start;
    const target = align === "CENTER" ? (W - lineWidth) / 2 : W - lineWidth;
    const dx = target - start;
    if (Math.abs(dx) < 0.01) continue;
    for (const g of glyphs) g.position.x += dx;
    b.position.x += dx;
  }
}

// Text boxes: the converter leaves textAutoResize unset (fixed box), so swapping the font
// in Figma clips or wraps text. Rules, mirroring CSS:
// - multi-line → fixed width (the block's width), height grows;
// - single-line left-aligned → auto width;
// - single-line centered/right-aligned or stretched by auto layout → fixed width, so the
//   text stays centred/right-aligned in its box.
export function fixTextLayout(message) {
  for (const n of message.nodeChanges) {
    if (n.type !== "TEXT") continue;
    realignLines(n);
    const lines = n.derivedTextData?.baselines?.length || 1;
    const left = !n.textAlignHorizontal || n.textAlignHorizontal === "LEFT";
    const stretched = n.stackChildAlignSelf === "STRETCH" || n.stackChildPrimaryGrow > 0;
    n.textAutoResize = lines === 1 && left && !stretched ? "WIDTH_AND_HEIGHT" : "HEIGHT";
  }
}

// Auto layout: a "hug contents" frame can't have "fill container" children — Figma sizes
// the frame by its other children and squeezes the fill ones (a card caption shrank to its
// 160px logo's width and wrapped into 4 lines). The conflict is resolved like this:
// - if the frame's size on the page holds its children, the frame gets that fixed size
//   (what Figma itself does when a child is set to fill);
// - otherwise (e.g. a 100vh wrapper whose content is the whole 3500px page) fixing the
//   frame would cut the page off, so the children lose fill/grow and keep their own size,
//   and the frame keeps hugging them. Same when a fixed frame is smaller than its content.
export function fixAutoLayoutSizing(message) {
  const children = new Map();
  for (const n of message.nodeChanges) {
    const pi = n.parentIndex;
    if (!pi || n.stackPositioning === "ABSOLUTE") continue;
    const key = `${pi.guid.sessionID}:${pi.guid.localID}`;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(n);
  }
  let fixed = 0;
  for (const n of message.nodeChanges) {
    if ((n.stackMode !== "VERTICAL" && n.stackMode !== "HORIZONTAL") || !n.size) continue;
    const kids = (children.get(`${n.guid.sessionID}:${n.guid.localID}`) || []).filter((k) => k.size && k.transform);
    const vertical = n.stackMode === "VERTICAL";
    const extent = (axis) => Math.max(0, ...kids.map((k) => (axis === "y" ? k.transform.m12 : k.transform.m02) + k.size[axis]));
    const resolve = (sizingKey, axis, isFill, unfill) => {
      const fills = kids.filter(isFill);
      if (!fills.length) return;
      const fits = extent(axis) <= n.size[axis] + 1;
      if (n[sizingKey] === "RESIZE_TO_FIT" && fits) n[sizingKey] = "FIXED";
      else if (!fits) fills.forEach(unfill); // hug or fixed, content larger than the frame: keep children's size
      else return;
      fixed++;
    };
    resolve("stackCounterSizing", vertical ? "x" : "y", (k) => k.stackChildAlignSelf === "STRETCH", (k) => delete k.stackChildAlignSelf);
    resolve("stackPrimarySizing", vertical ? "y" : "x", (k) => k.stackChildPrimaryGrow > 0, (k) => delete k.stackChildPrimaryGrow);
  }
  // The page frame keeps the full page size: left to "hug", Figma shrank it to a 100vh
  // wrapper inside and its clipping cut the rest of the page off.
  const canvas = message.nodeChanges.find((n) => n.type === "CANVAS");
  for (const n of message.nodeChanges) {
    if (n.type !== "FRAME" || !canvas || n.parentIndex?.guid.localID !== canvas.guid.localID) continue;
    if (n.stackMode === "VERTICAL" || n.stackMode === "HORIZONTAL") {
      n.stackPrimarySizing = "FIXED";
      n.stackCounterSizing = "FIXED";
    }
  }
  return fixed;
}

// A pasted/imported file has no prototype settings of its own: use the page frame as the
// start screen and a device whose width matches the capture, so Present doesn't crop a wide layout.
// The device is at least 16:9: when Present scales to fill the window, a screen-height device
// would be enlarged until its width overflows; a taller one keeps the width as the limiting side.
export function setPrototypeDevice(message, { width, height }) {
  const canvas = message.nodeChanges.find((n) => n.type === "CANVAS");
  if (!canvas) return 0;
  const root = message.nodeChanges.find(
    (n) =>
      n.type === "FRAME" &&
      n.size &&
      !n.scrollDirection &&
      n.parentIndex?.guid.sessionID === canvas.guid.sessionID &&
      n.parentIndex?.guid.localID === canvas.guid.localID
  );
  if (!root) return 0;
  canvas.prototypeStartNodeID = { ...root.guid };
  canvas.prototypeDevice = { type: "CUSTOM", size: { x: width, y: Math.max(height, Math.round((width * 9) / 16)) } };
  return 1;
}

// Sibling order: the converter numbers children "0", "1", … "10", but Figma compares
// parentIndex.position as strings, so "10" sorted before "2" — e.g. a sticky header
// (painted last because of z-index) ended up under the hero section. Renumber every
// sibling group with fixed-width strings from the allowed alphabet "!"…"~".
export function fixSiblingOrder(message) {
  const groups = new Map();
  for (const n of message.nodeChanges) {
    const pi = n.parentIndex;
    if (!pi || !/^-?\d+$/.test(pi.position)) continue;
    const key = `${pi.guid.sessionID}:${pi.guid.localID}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }
  let fixed = 0;
  for (const nodes of groups.values()) {
    // "0"…"9" already compare correctly; "-1" (inserted Background frames) and "10"+ don't.
    if (nodes.length < 11 && nodes.every((n) => !n.parentIndex.position.startsWith("-"))) continue;
    nodes.sort((a, b) => Number(a.parentIndex.position) - Number(b.parentIndex.position));
    const width = Math.ceil(Math.log(nodes.length + 1) / Math.log(94));
    nodes.forEach((n, i) => {
      let pos = "";
      for (let k = 0, v = i; k < width; k++, v = Math.floor(v / 94)) pos = String.fromCharCode(33 + (v % 94)) + pos;
      n.parentIndex.position = pos;
    });
    fixed++;
  }
  return fixed;
}

// Move a text node vertically by dy while keeping its glyphs where they are on the page.
export function shiftTextBox(n, dy, height) {
  n.transform.m12 += dy;
  if (height) n.size.y = height;
  const d = n.derivedTextData;
  if (!d) return;
  for (const b of d.baselines || []) b.position.y -= dy;
  for (const g of d.glyphs || []) g.position.y -= dy;
  for (const dec of d.decorations || []) for (const r of dec.rects || []) if (typeof r.y === "number") r.y -= dy;
}

// Sites often serve full-size photos for small thumbnails. Downscale every image to
// 2x its largest on-page size, so Figma doesn't run out of memory.
// `resize(bytes, mime, w, h)` → { bytes } | null is provided by the environment.
export async function optimizeImages(message, resize, scale = 2) {
  const uses = new Map(); // blob index -> { w, h, paints, mime }
  for (const n of message.nodeChanges) {
    for (const p of [...(n.fillPaints || []), ...(n.strokePaints || [])]) {
      if (p.type !== "IMAGE" || p.image?.dataBlob == null) continue;
      const u = uses.get(p.image.dataBlob) || { w: 0, h: 0, paints: [] };
      u.w = Math.max(u.w, n.size?.x || 0);
      u.h = Math.max(u.h, n.size?.y || 0);
      u.paints.push(p);
      uses.set(p.image.dataBlob, u);
    }
  }
  let before = 0;
  let after = 0;
  for (const [idx, u] of uses) {
    // TILE fills repeat the image at its pixel size × scale: resizing would change the pattern.
    if (u.paints.some((p) => p.imageScaleMode === "TILE")) continue;
    const bytes = message.blobs[idx].bytes;
    before += bytes.length;
    after += bytes.length;
    if (u.w < 1 || u.h < 1) continue;
    const out = await resize(bytes, Math.ceil(u.w * scale), Math.ceil(u.h * scale)).catch(() => null);
    if (!out || out.length >= bytes.length) continue;
    message.blobs[idx].bytes = out;
    const hash = Array.from(sha1(out));
    for (const p of u.paints) p.image.hash = hash;
    after += out.length - bytes.length;
  }
  return { before, after };
}

export function stats(message) {
  const s = { nodes: message.nodeChanges.length, images: 0 };
  for (const n of message.nodeChanges) for (const p of n.fillPaints || []) if (p.type === "IMAGE") s.images++;
  return s;
}

export function toClipboardHtml(message) {
  const { base64 } = encodeFigmaData(message);
  return composeClipboardHtml(base64, { dataType: "scene", fileKey: "TEST", pasteID: 123 });
}

// fig-kiwi bytes: "fig-kiwi" | u32 version | u32 len, deflated schema | u32 len, deflated message
function splitFigKiwi(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  let off = 12;
  while (off + 4 <= bytes.length) {
    const len = view.getUint32(off, true);
    chunks.push(bytes.subarray(off + 4, off + 4 + len));
    off += 4 + len;
  }
  return chunks;
}

// A .fig is a ZIP (store mode): canvas.fig (fig-kiwi, message chunk zstd), meta.json,
// thumbnail.png and images/<sha1>. Format per openfig-core docs.
export function toFigFile(message, { name, thumbnail, width, height }) {
  const msg = structuredClone(message);
  for (const k of ["pasteID", "pasteFileKey", "pasteIsPartiallyOutsideEnclosingFrame", "isCut", "pasteEditorType", "publishedAssetGuids"]) delete msg[k];
  msg.type = "NODE_CHANGES";
  msg.sessionID = 0;
  msg.ackID = 0;

  const nodes = msg.nodeChanges;
  const doc = nodes.find((n) => n.type === "DOCUMENT");
  doc.name = name;
  const canvas = nodes.find((n) => n.type === "CANVAS");
  canvas.name = "Page 1";
  canvas.backgroundColor = CANVAS_BG;
  canvas.backgroundEnabled = true;

  // Real Figma documents always carry a hidden internal canvas.
  const maxId = Math.max(...nodes.map((n) => (n.guid.sessionID === 0 ? n.guid.localID : 0)));
  nodes.push({
    guid: { sessionID: 0, localID: maxId + 1 },
    phase: "CREATED",
    parentIndex: { guid: doc.guid, position: "~" },
    type: "CANVAS",
    name: "Internal Only Canvas",
    visible: false,
    opacity: 1,
    transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
    internalOnly: true,
  });

  // In a .fig, images live in images/<sha1>, not inline blobs.
  const images = {};
  for (const n of nodes) {
    for (const p of [...(n.fillPaints || []), ...(n.strokePaints || [])]) {
      if (p.type !== "IMAGE" || !p.image?.hash) continue;
      const h = toHex(p.image.hash);
      if (p.image.dataBlob != null) {
        const blob = msg.blobs[p.image.dataBlob];
        if (!images[h] && blob.bytes.length && toHex(sha1(blob.bytes)) === h) images[h] = blob.bytes;
        // The bytes now live in images/; keep the blob slot so other blob indices stay valid.
        if (images[h]) blob.bytes = new Uint8Array(0);
      }
      delete p.image.dataBlob;
      p.image.name = h;
      p.imageThumbnail = { hash: p.image.hash, name: h };
    }
  }

  const [schemaChunk, dataChunk] = splitFigKiwi(encodeFigmaData(msg).figBytes);
  const messageZstd = zstdStore(inflateSync(dataChunk));

  const canvasFig = new Uint8Array(12 + 4 + schemaChunk.length + 4 + messageZstd.length);
  const view = new DataView(canvasFig.buffer);
  canvasFig.set(strToU8("fig-kiwi"), 0);
  view.setUint32(8, FIG_VERSION, true);
  view.setUint32(12, schemaChunk.length, true);
  canvasFig.set(schemaChunk, 16);
  view.setUint32(16 + schemaChunk.length, messageZstd.length, true);
  canvasFig.set(messageZstd, 20 + schemaChunk.length);

  const shotHeight = Math.min(height, Math.round(width * 0.625));
  const meta = {
    client_meta: {
      background_color: CANVAS_BG,
      thumbnail_size: { width: 400, height: Math.round((400 * shotHeight) / width) },
      render_coordinates: { x: 0, y: 0, width, height: shotHeight },
    },
    file_name: name,
    developer_related_links: [],
    version: "1",
  };
  const files = {
    "canvas.fig": [canvasFig, { level: 0 }],
    "meta.json": [strToU8(JSON.stringify(meta)), { level: 0 }],
    "thumbnail.png": [thumbnail, { level: 0 }],
  };
  for (const [h, bytes] of Object.entries(images)) files[`images/${h}`] = [bytes, { level: 0 }];
  return zipSync(files);
}
