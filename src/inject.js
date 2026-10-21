// Entry point for headless Chrome (server.mjs, verify.mjs): the capture runs in the page,
// network requests go through functions exposed by Node (no CORS limits).
import { capture, createStyleJournal, materializePseudoElements } from "./core/pipeline.js";
import { prepareSvgImages, resolveSvgUses } from "./core/svg.js";
import { base64ToBytes, bytesToBase64 } from "./core/bytes.js";

window.__s2fCapture = async ({ layout, hideSelectors, targetSelector, thumbnailB64, withTrace }) => {
  const res = await capture(
    { layout, hideSelectors, targetSelector, scroll: false, freezeAnimations: false, keepModified: withTrace }, // Node already froze and scrolled
    {
      net: {
        text: async (url) => {
          const r = await window.__s2fNet(url, "text");
          if (r.error) throw new Error(r.error);
          return r.text;
        },
        get: async (url) => {
          const r = await window.__s2fNet(url, "bytes");
          if (r.error) throw new Error(r.error);
          return r;
        },
      },
      thumbnail: thumbnailB64 ? async () => base64ToBytes(thumbnailB64) : undefined,
      captureViewport: window.__s2fShot
        ? async () => createImageBitmap(new Blob([base64ToBytes(await window.__s2fShot())], { type: "image/png" }))
        : undefined,
      progress: (m) => console.log("[s2f] " + m),
    }
  );
  const { message, trace, ...debug } = res.debug;
  return {
    name: res.name,
    width: res.width,
    height: res.height,
    nodes: res.nodes,
    images: res.images,
    log: res.log,
    debug,
    figB64: bytesToBase64(res.fig),
    svgCount: res.svgCount,
    svgZipB64: res.svgZip ? bytesToBase64(res.svgZip) : null,
    clipboardHtml: res.clipboardHtml,
    trace: withTrace ? trace : undefined,
  };
};

// Test hook (tools/pseudo-check): materialize pseudo-elements, later roll back.
window.__s2fTest = {
  async svg() {
    const journal = createStyleJournal();
    const net = { text: async (u) => (await fetch(u)).text() };
    const uses = await resolveSvgUses(journal, net);
    const res = await prepareSvgImages(journal, net);
    window.__s2fTest.restore = () => journal.restore();
    return { uses, inlined: res.inlined, complex: [...res.originals.values()].map((o) => `${o.name} (${o.reason})`) };
  },
  materialize() {
    const journal = createStyleJournal();
    const count = materializePseudoElements(journal);
    window.__s2fTest.restore = () => journal.restore();
    return count;
  },
};
