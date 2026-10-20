// <canvas> (e.g. animated WebGL gradient backgrounds) and <video> have no convertible
// content: the converter leaves an empty frame. Each one is taken as a plain screenshot of
// its current state and put into its layer as an image.
//
// env.captureViewport() → Promise<ImageBitmap> of the visible viewport.
import { sha1 } from "./bytes.js";

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

// While shooting, everything except the target is hidden, so text and buttons drawn over a
// background canvas don't end up baked into the picture.
const SOLO_CSS =
  "html[data-s2f-solo-mode] *:not([data-s2f-solo]){visibility:hidden!important}" +
  "html[data-s2f-solo-mode] [data-s2f-solo]{visibility:visible!important}";

/** Screenshot every visible canvas/video. Returns Map(element → PNG bytes). */
export async function snapshotMediaElements(captureViewport) {
  const result = new Map();
  if (!captureViewport) return result;
  const targets = [...document.querySelectorAll("body canvas, body video")].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width >= 16 && r.height >= 16 && getComputedStyle(el).visibility !== "hidden";
  });
  if (!targets.length) return result;

  const style = document.createElement("style");
  style.textContent = SOLO_CSS;
  document.head.appendChild(style);
  const startScroll = window.scrollY;
  try {
    document.documentElement.setAttribute("data-s2f-solo-mode", "");
    for (const el of targets) {
      el.setAttribute("data-s2f-solo", "");
      try {
        el.scrollIntoView({ block: "nearest" });
        await nextFrame();
        const shot = await captureViewport();
        const scale = shot.width / window.innerWidth;
        const r = el.getBoundingClientRect();
        const left = Math.max(0, r.left);
        const top = Math.max(0, r.top);
        const w = Math.min(window.innerWidth, r.right) - left;
        const h = Math.min(window.innerHeight, r.bottom) - top;
        if (w > 0 && h > 0) {
          const canvas = new OffscreenCanvas(Math.round(w * scale), Math.round(h * scale));
          canvas.getContext("2d").drawImage(shot, left * scale, top * scale, w * scale, h * scale, 0, 0, canvas.width, canvas.height);
          result.set(el, new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer()));
        }
        shot.close?.();
      } catch (e) {
        console.warn("site2figma: snapshot failed", e);
      } finally {
        el.removeAttribute("data-s2f-solo");
      }
    }
  } finally {
    document.documentElement.removeAttribute("data-s2f-solo-mode");
    style.remove();
    window.scrollTo(0, startScroll);
  }
  return result;
}

/** Put the snapshots into the converted layers of those elements (via the trace). */
export function applySnapshots(message, trace, snapshots, resolveElement) {
  if (!snapshots.size) return 0;
  const byId = new Map(message.nodeChanges.map((n) => [`${n.guid.sessionID}:${n.guid.localID}`, n]));
  let applied = 0;
  for (const e of trace.entries) {
    if (e.domPath.includes("::text")) continue;
    const el = resolveElement(e.domPath);
    const png = el && snapshots.get(el);
    const n = png && byId.get(`${e.guid.sessionID}:${e.guid.localID}`);
    if (!n) continue;
    const blob = message.blobs.push({ bytes: png }) - 1;
    n.fillPaints = [
      ...(n.fillPaints || []),
      {
        type: "IMAGE",
        opacity: 1,
        visible: true,
        blendMode: "NORMAL",
        transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
        image: { hash: Array.from(sha1(png)), dataBlob: blob },
        imageScaleMode: "FILL",
      },
    ];
    n.name = el.tagName === "VIDEO" ? "Video (кадр)" : "Canvas (снимок)";
    applied++;
  }
  return applied;
}
