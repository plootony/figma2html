// Smoke tests on local fixtures: whole page, block, multi-block and merging captures of
// different widths into one canvas.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeFigmaData } from "@figit/fig-kiwi";
import { unzipSync, strFromU8 } from "fflate";
import { capturePage, closeBrowser } from "../capture.mjs";
import { mergeMessages, toClipboardHtml } from "../src/core/post.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures.push(name);
};

const server = http.createServer((req, res) => {
  const file = path.join(ROOT, "fixtures", new URL(req.url, "http://x").pathname === "/" ? "page.html" : new URL(req.url, "http://x").pathname);
  if (!fs.existsSync(file)) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

const decode = (html) => decodeFigmaData(Buffer.from(html.match(/\(figma\)([^(]*)\(\/figma\)/)[1], "base64")).message;
const textOf = (message) => message.nodeChanges.filter((n) => n.type === "TEXT").map((n) => n.textData?.characters || "").join("\n");
const rootFrames = (message) => message.nodeChanges.filter((n) => n.type === "FRAME" && n.parentIndex?.guid.sessionID === 0 && n.parentIndex?.guid.localID === 1);
const figInfo = (fig) => {
  const zip = unzipSync(new Uint8Array(fig));
  const meta = JSON.parse(strFromU8(zip["meta.json"]));
  const png = zip["thumbnail.png"];
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const message = decodeFigmaData(zip["canvas.fig"]).message;
  const roots = message.nodeChanges.filter((n) => n.type === "FRAME" && n.parentIndex?.guid.sessionID === 0 && n.parentIndex?.guid.localID === 1);
  return {
    meta: meta.client_meta,
    png: { width: view.getUint32(16), height: view.getUint32(20) },
    root: roots[0] && { x: roots[0].transform.m02, y: roots[0].transform.m12, width: roots[0].size.x, height: roots[0].size.y },
    hasImagesDir: Boolean(zip["images/"]),
  };
};

try {
  const whole = await capturePage({ url, width: 1200 });
  const wholeMsg = decode(whole.clipboardHtml);
  check("whole page has layers", whole.nodes > 0 && wholeMsg.nodeChanges.length > 3);
  check("whole page includes outside content", textOf(wholeMsg).includes("Outside header"));
  check("whole page .fig is non-empty", whole.fig.length > 1000);
  const info = figInfo(whole.fig);
  check("thumbnail metadata matches the PNG", info.meta.thumbnail_size.width === info.png.width && info.meta.thumbnail_size.height === info.png.height, JSON.stringify(info));
  check("thumbnail fits in 400x400", info.png.width <= 400 && info.png.height <= 400, JSON.stringify(info.png));
  check("render coordinates match the root frame", info.root && Math.abs(info.meta.render_coordinates.width - info.root.width) < 0.5 && Math.abs(info.meta.render_coordinates.height - info.root.height) < 0.5, JSON.stringify(info));
  check("images/ directory is present", info.hasImagesDir);
  check("css background layer added", whole.debug.fixes.backgrounds >= 1);
  check("pseudo-element text materialized", textOf(wholeMsg).includes("Before"));

  const block = await capturePage({ url, width: 1200, targetSelector: "#hero" });
  const blockMsg = decode(block.clipboardHtml);
  const blockText = textOf(blockMsg);
  check("block excludes outside content", !blockText.includes("Outside header") && !blockText.includes("Card one") && !blockText.includes("Tall section"));
  check("block keeps its own content", blockText.includes("Hero title") && blockText.includes("Hero text"));
  check("block has one root frame", rootFrames(blockMsg).length === 1);

  const extra = await capturePage({ url, width: 1200, extraInfo: true });
  const infoMsg = decode(extra.clipboardHtml);
  const infoFrame = rootFrames(infoMsg).find((n) => n.name === "Доп. информация");
  check("additional info frame is added", Boolean(infoFrame));
  const infoImage = infoFrame && infoMsg.nodeChanges.some((n) => n.parentIndex?.guid.sessionID === infoFrame.guid.sessionID && n.parentIndex?.guid.localID === infoFrame.guid.localID && n.fillPaints?.some((p) => p.type === "IMAGE"));
  check("additional info is rendered as an image", Boolean(infoImage));

  const multi = await capturePage({ url, width: 1200, targetSelectors: ["#hero", "#cards"] });
  const multiMsg = decode(multi.clipboardHtml);
  const roots = rootFrames(multiMsg);
  check("multi-block capture has two frames", roots.length === 2, `got ${roots.length}`);
  if (roots.length === 2) {
    check("multi-block frames are side by side", Math.abs(roots[1].transform.m02 - (roots[0].size.x + 80)) < 1, `${roots[1].transform.m02} vs ${roots[0].size.x + 80}`);
    check("multi-block frames keep both contents", textOf(multiMsg).includes("Hero title") && textOf(multiMsg).includes("Card one"));
  }

  const w1 = await capturePage({ url, width: 1200 });
  const w2 = await capturePage({ url, width: 900 });
  const merged = mergeMessages([
    { message: decode(w1.clipboardHtml), x: 0, y: 0 },
    { message: decode(w2.clipboardHtml), x: w1.width + 80, y: 0 },
  ]);
  const mergedRoots = rootFrames(merged);
  check("widths merge into two root frames", mergedRoots.length === 2, `got ${mergedRoots.length}`);
  check("widths merged message encodes", toClipboardHtml(merged).includes("(figma)"));
} finally {
  await closeBrowser();
  server.close();
}

console.log(failures.length ? `\n${failures.length} test(s) failed` : "\nAll tests passed");
process.exit(failures.length ? 1 : 0);
