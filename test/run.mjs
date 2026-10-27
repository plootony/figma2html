// Smoke tests on local fixtures: whole page, block, multi-block and merging captures of
// different widths into one canvas.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { decodeFigmaData } from "@figit/fig-kiwi";
import { unzipSync, strFromU8 } from "fflate";
import { capturePage, closeBrowser, getBrowser } from "../capture.mjs";
import { mergeMessages, toClipboardHtml } from "../src/core/post.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures.push(name);
};

const serveFixture = (req, res) => {
  const file = path.join(ROOT, "fixtures", new URL(req.url, "http://x").pathname === "/" ? "page.html" : new URL(req.url, "http://x").pathname);
  if (!fs.existsSync(file)) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(fs.readFileSync(file));
};
const server = http.createServer(serveFixture);
// The same fixtures on a second origin, for the per-site panel settings.
const otherServer = http.createServer(serveFixture);
await new Promise((r) => server.listen(0, "127.0.0.1", r));
await new Promise((r) => otherServer.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;
const otherUrl = `http://127.0.0.1:${otherServer.address().port}/`;

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
const hasSolid = (node, hex) =>
  (node.fillPaints || []).some((p) => p.type === "SOLID" && p.visible !== false && [p.color.r, p.color.g, p.color.b].map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("") === hex);
// Position of a layer on the canvas: its transform plus those of its parents.
const absolute = (message, node) => {
  const byId = new Map(message.nodeChanges.map((n) => [`${n.guid.sessionID}:${n.guid.localID}`, n]));
  const pos = { x: 0, y: 0 };
  for (let n = node; n && n.type !== "CANVAS"; n = n.parentIndex && byId.get(`${n.parentIndex.guid.sessionID}:${n.parentIndex.guid.localID}`)) {
    pos.x += n.transform?.m02 || 0;
    pos.y += n.transform?.m12 || 0;
  }
  return pos;
};
const nodeKey = (g) => `${g.sessionID}:${g.localID}`;
const parentOf = (message, node) => node.parentIndex && message.nodeChanges.find((n) => nodeKey(n.guid) === nodeKey(node.parentIndex.guid));
const textNode = (message, start) => message.nodeChanges.find((n) => n.type === "TEXT" && n.textData?.characters?.startsWith(start));
// Capture with the layers of elements that have an id (through the trace), plus `readPage()`
// evaluated in the page while the capture's DOM changes are still in place.
async function captureById(pageUrl, width, readPage = () => null) {
  const result = await capturePage({
    url: pageUrl,
    width,
    inspect: async (page, trace) => ({
      ids: await page.evaluate((entries) => {
        const out = {};
        for (const e of entries) {
          if (e.domPath.includes("::text")) continue;
          const el = e.domPath === ":scope" ? document.body : document.body.querySelector(e.domPath);
          if (el?.id && !(el.id in out)) out[el.id] = `${e.guid.sessionID}:${e.guid.localID}`;
        }
        return out;
      }, trace.entries),
      page: await page.evaluate(readPage),
    }),
  });
  const message = decode(result.clipboardHtml);
  const byKey = new Map(message.nodeChanges.map((n) => [nodeKey(n.guid), n]));
  const nodes = Object.fromEntries(Object.entries(result.inspected.ids).map(([id, key]) => [id, byKey.get(key)]));
  return { result, message, nodes, page: result.inspected.page };
}
const withTimeout = (promise, ms) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`no result in ${ms} ms`)), ms)))]).finally(() => clearTimeout(timer));
};

// The extension panel (extension/content.js) in a plain page with chrome.* stubbed.
// `storage` is the initial chrome.storage.local; the page keeps it in window.__s2fStore.
const PANEL = fs.readFileSync(path.join(ROOT, "../extension/content.js"), "utf8");
async function openPanel(pageUrl, storage = {}) {
  const page = await (await getBrowser()).newPage();
  await page.setViewport({ width: 1200, height: 800 });
  await page.evaluateOnNewDocument((initial) => {
    const store = (window.__s2fStore = initial);
    const pick = (keys) => Object.fromEntries([].concat(keys ?? Object.keys(store)).filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
    const stub = {
      runtime: { id: "test", getURL: (p) => p, sendMessage: (msg, cb) => setTimeout(() => cb?.({}), 0), onMessage: { addListener() {} } },
      storage: { local: { get: async (keys) => pick(keys), set: async (items) => void Object.assign(store, structuredClone(items)) } },
    };
    Object.defineProperty(window, "chrome", { value: stub, configurable: true, writable: true });
  }, storage);
  await page.goto(pageUrl, { waitUntil: "load" });
  await page.addScriptTag({ content: PANEL });
  await page.waitForFunction(() => document.getElementById("site2figma-panel")?.shadowRoot);
  await new Promise((r) => setTimeout(r, 300)); // saved settings are restored asynchronously
  return page;
}
// Runs fn(shadowRoot, ...args) in the page.
const inPanel = async (page, fn, ...args) => {
  const root = await page.evaluateHandle(() => document.getElementById("site2figma-panel").shadowRoot);
  try {
    return await root.evaluate(fn, ...args);
  } finally {
    await root.dispose();
  }
};
async function pickBlock(page, selector) {
  await inPanel(page, (root) => root.querySelector(".pick").click());
  await page.waitForSelector("#site2figma-picker");
  const p = await page.evaluate((sel) => {
    const r = document.querySelector(sel).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, selector);
  await page.mouse.move(p.x, p.y);
  await page.mouse.click(p.x, p.y);
  await page.waitForFunction(() => !document.getElementById("site2figma-picker"));
  await new Promise((r) => setTimeout(r, 400)); // settings are saved with a debounce
}

// extension/background.js with chrome.* stubbed; `shot()` sends it the "shot" message.
function loadBackground(tab) {
  let onMessage;
  const shots = [];
  const listener = { addListener() {} };
  const chrome = {
    debugger: { onDetach: listener },
    action: { onClicked: listener },
    commands: { onCommand: listener },
    runtime: { onMessage: { addListener: (fn) => (onMessage = fn) } },
    tabs: {
      get: async (id) => ({ ...tab, id }),
      captureVisibleTab: async (windowId) => {
        shots.push(windowId);
        return "data:image/png;base64,";
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "../extension/background.js"), "utf8"), { chrome, console, setTimeout, clearTimeout });
  const shot = () => new Promise((resolve) => onMessage({ type: "shot" }, { tab: { id: 5, windowId: tab.windowId } }, resolve));
  return { shot, shots };
}

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
  const overlayColor = wholeMsg.nodeChanges.some((n) =>
    (n.fillPaints || []).some((p) => p.type === "SOLID" && Math.round(p.color.r * 255) === 0x12 && Math.round(p.color.g * 255) === 0x34 && Math.round(p.color.b * 255) === 0x56)
  );
  check("offscreen fixed overlays are skipped", !overlayColor);
  check("constant body background is not baked into sections", whole.debug.fixes.sectionBackgrounds === 0, `sectionBackgrounds ${whole.debug.fixes.sectionBackgrounds}`);

  const sections = await capturePage({ url: url + "sections.html", width: 1000 });
  const sectionsMsg = decode(sections.clipboardHtml);
  check(
    "changed body background is baked into its section only",
    sections.debug.fixes.sectionBackgrounds === 1 && sectionsMsg.nodeChanges.some((n) => n.type === "FRAME" && hasSolid(n, "102030")),
    `sectionBackgrounds ${sections.debug.fixes.sectionBackgrounds}`
  );

  // A clearfix ::after must not become a real child: the last item would lose :last-child,
  // get its margin back and wrap to a second line.
  const pseudo = await capturePage({ url: url + "pseudo.html", width: 800 });
  const pseudoMsg = decode(pseudo.clipboardHtml);
  const itemPos = (text) => {
    const n = pseudoMsg.nodeChanges.find((node) => node.type === "TEXT" && node.textData?.characters === text);
    return n && absolute(pseudoMsg, n);
  };
  const [one, three] = [itemPos("One"), itemPos("Three")];
  check("clearfix ::after keeps the menu on one line", one && three && Math.abs(one.y - three.y) < 1 && three.x > 250, JSON.stringify({ one, three }));
  check("pseudo-elements that paint nothing are not materialized", pseudo.debug.fixes.pseudo === 0, `pseudo ${pseudo.debug.fixes.pseudo}`);

  // Font names: every text must reach Figma under a family and style Figma has.
  const fonts = await captureById(url + "fonts.html", 900, () => ({
    helvStack: document.getElementById("helv").style.fontFamily,
    montserratLoaded: [...document.fonts].some((f) => f.family.replace(/["']/g, "") === "Montserrat" && f.status === "loaded"),
  }));
  const fontOf = (start) => {
    const n = textNode(fonts.message, start);
    return n ? `${n.fontName.family} / ${n.fontName.style}` : "no layer";
  };
  const expectFont = (name, start, expected) => check(name, fontOf(start) === expected, fontOf(start));
  expectFont("Inter 600 gets Figma's style name (Semi Bold)", "SystemSemi", "Inter / Semi Bold");
  expectFont("Inter 800 gets Figma's style name (Extra Bold)", "SansExtra", "Inter / Extra Bold");
  expectFont("lowercase Google family keeps the family", "LowerMont", "Montserrat / SemiBold");
  expectFont("family named after its style gets family and weight", "AliasMont", "Montserrat / Bold");
  expectFont("next/font family name is unwrapped", "NextOpen", "Open Sans / Regular");
  expectFont("commercial family named after its style keeps the weight", "GilroySemi", "Manrope / SemiBold");
  expectFont("prefix-matched family keeps the weight", "HelvBold", "Arimo / Bold");
  expectFont("Google family ending with a style word stays itself", "ArchivoBlack", "Archivo Black / Regular");
  check("substitute keeps the page's stack as fallback", /^"?Arimo"?, .*Arial/.test(fonts.page.helvStack), fonts.page.helvStack);
  check("substitute font is loaded into the page", fonts.page.montserratLoaded);
  const lineHeight = (start) => JSON.stringify(textNode(fonts.message, start)?.lineHeight);
  check("unitless line-height becomes relative (RAW)", lineHeight("RawLine") === JSON.stringify({ value: 1.5, units: "RAW" }), lineHeight("RawLine"));
  check("pixel line-height stays pixels", lineHeight("PixelLine") === JSON.stringify({ value: 30, units: "PIXELS" }), lineHeight("PixelLine"));
  check("normal line-height stays pixels", JSON.parse(lineHeight("NormalLine") || "{}").units === "PIXELS", lineHeight("NormalLine"));

  // Auto layout and layer names.
  const layout = await captureById(url + "layout.html", 1000);
  const { nodes } = layout;
  check("flex button with bare text gets auto layout", nodes.buy?.stackMode === "HORIZONTAL", nodes.buy?.stackMode);
  const guardedText = textNode(layout.message, "Guarded");
  const guardedDx = guardedText && nodes.guarded ? absolute(layout.message, guardedText).x - absolute(layout.message, nodes.guarded).x : NaN;
  check("text is not wrapped where CSS targets element children", Math.abs(guardedDx) < 1, `text offset ${guardedDx}`);
  check("align-items: baseline becomes baseline alignment", nodes.baseline?.stackCounterAlignItems === "BASELINE", nodes.baseline?.stackCounterAlignItems);
  check("baseline in a column falls back to start", nodes.column?.stackMode === "VERTICAL" && (nodes.column.stackCounterAlignItems ?? "MIN") === "MIN", `${nodes.column?.stackMode} ${nodes.column?.stackCounterAlignItems}`);
  check("space-evenly becomes SPACE_EVENLY", nodes.evenly?.stackPrimaryAlignItems === "SPACE_EVENLY", nodes.evenly?.stackPrimaryAlignItems);
  const frameNames = layout.message.nodeChanges.filter((n) => n.type === "FRAME").map((n) => n.name);
  check("semantic frame is named after its id", nodes.hero?.name === "Section · hero", nodes.hero?.name);
  check("frame is named after its class", frameNames.includes("product-card"), frameNames.join(", "));
  check("CSS module hash is dropped from the name", frameNames.includes("Header_root"), frameNames.join(", "));
  check("utility classes don't name a frame", parentOf(layout.message, textNode(layout.message, "Utility"))?.name === "Container", parentOf(layout.message, textNode(layout.message, "Utility"))?.name);
  const image = layout.message.nodeChanges.find((n) => n.fillPaints?.some((p) => p.type === "IMAGE") && n.name === "Company logo");
  check("image is named after its alt text", Boolean(image));

  // As in a background tab: requestAnimationFrame never fires. The canvas snapshot waited
  // for it forever.
  const hidden = await withTimeout(capturePage({ url: url + "hidden.html", width: 800 }), 45000).catch((error) => ({ error }));
  check("capture finishes without animation frames", !hidden.error, String(hidden.error?.message));
  check("canvas is snapshotted without animation frames", hidden.debug?.fixes.snapshots >= 1, JSON.stringify(hidden.debug?.fixes));

  const inactive = loadBackground({ windowId: 3, active: false });
  const refused = await inactive.shot();
  check("screenshot is refused when the tab is not active", Boolean(refused?.error) && !inactive.shots.length, JSON.stringify(refused));
  const active = loadBackground({ windowId: 3, active: true });
  const taken = await active.shot();
  check("screenshot is taken when the tab is active", Boolean(taken?.dataUrl) && active.shots[0] === 3, JSON.stringify(taken));

  // Panel settings. A block inside an element with an id is saved as a selector (CSS.escape
  // used to be shadowed by the panel's styles, and the selector came out empty).
  const siteKey = (u) => `s2fSite:${new URL(u).origin}`;
  const pageA = await openPanel(url + "panel.html");
  await inPanel(pageA, (root) => root.querySelector(".abs").click());
  await inPanel(pageA, (root) => (root.querySelector("details.advanced").open = true)); // scans the breakpoints
  await pickBlock(pageA, ".hero");
  const stored = await pageA.evaluate(() => window.__s2fStore);
  const savedTargets = stored[siteKey(url)]?.targets || [];
  const savedResolves = savedTargets.length === 1 && (await pageA.evaluate((sel) => document.querySelector(sel) === document.querySelector(".hero"), savedTargets[0]));
  check("chosen block inside an element with id is saved", savedResolves, JSON.stringify(stored));
  await pageA.close();

  const again = await openPanel(url + "panel.html", stored);
  check("chosen block is restored on the same page", (await inPanel(again, (root) => root.querySelector(".go").textContent)) === "Захватить выбранные блоки");
  check("breakpoints of the site are restored", (await inPanel(again, (root) => root.querySelector(".widthlist").textContent)).includes("700"));
  await again.close();

  const otherSite = await openPanel(otherUrl + "panel.html", stored);
  check("chosen block is not restored on another site", (await inPanel(otherSite, (root) => root.querySelector(".go").textContent)) === "Захватить всю страницу");
  check("breakpoints of another site are not shown", !(await inPanel(otherSite, (root) => root.querySelector(".widthlist").textContent)).includes("700"));
  check("general options are shared between sites", await inPanel(otherSite, (root) => root.querySelector(".abs").checked));
  await otherSite.close();

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

  const tokenResult = await capturePage({ url, width: 1200, designTokens: true });
  const tokenMsg = decode(tokenResult.clipboardHtml);
  const tokenFrame = rootFrames(tokenMsg).find((n) => n.name === "Токены дизайна");
  check("design tokens frame is added", Boolean(tokenFrame));
  const tokenImage = tokenFrame && tokenMsg.nodeChanges.some((n) => n.parentIndex?.guid.sessionID === tokenFrame.guid.sessionID && n.parentIndex?.guid.localID === tokenFrame.guid.localID && n.fillPaints?.some((p) => p.type === "IMAGE"));
  check("design tokens are rendered as an image", Boolean(tokenImage));

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
  otherServer.close();
}

console.log(failures.length ? `\n${failures.length} test(s) failed` : "\nAll tests passed");
process.exit(failures.length ? 1 : 0);
