// Headless capture for the local server and verify.mjs: Node opens the page, scrolls it,
// takes a screenshot and serves network requests; the capture itself is the same in-page
// pipeline the Chrome extension uses (src/core/pipeline.js, bundled into dist/inject.js).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const INJECT = fs.readFileSync(path.join(ROOT, "dist/inject.js"), "utf8");
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/snap/bin/chromium",
].filter(Boolean);

function findChrome() {
  const found = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!found) throw new Error("Chrome/Chromium не найден. Укажите путь в переменной CHROME_PATH.");
  return found;
}

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer
      .launch({
        executablePath: findChrome(),
        headless: true,
        protocolTimeout: 600000,
        args: ["--no-sandbox", "--hide-scrollbars"],
      })
      .catch((e) => {
        browserPromise = null;
        throw e;
      });
  }
  return browserPromise;
}

export async function closeBrowser() {
  if (browserPromise) (await browserPromise.catch(() => null))?.close();
  browserPromise = null;
}

// Network for the in-page pipeline: Node has no CORS limits.
async function netFetch(url, kind, referer) {
  try {
    const headers = { Referer: referer };
    // A non-browser UA makes Google Fonts return one TTF per style instead of woff2 subsets.
    if (!url.startsWith("https://fonts.googleapis.com/")) headers["User-Agent"] = UA;
    const res = await fetch(url, { headers });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    if (kind === "text") return { text: await res.text() };
    const buf = Buffer.from(await res.arrayBuffer());
    return { b64: buf.toString("base64"), mime: (res.headers.get("content-type") || "application/octet-stream").split(";")[0].trim() };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

// Scroll through the page so lazy-loaded images and sections render.
async function autoScroll(page) {
  await page.evaluate(async () => {
    const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
    for (let y = 0; y < document.documentElement.scrollHeight && y < 60000; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
  });
}

// Disable animations/transitions so elements are captured in their final state.
const FREEZE_CSS = `*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important;scroll-behavior:auto!important}`;

/**
 * Capture a page. Returns { name, height, fig (Buffer), clipboardHtml, nodes, images, log, debug, trace? }.
 * `inspect(page, trace)` (optional, verify.mjs) runs on the live page after the capture.
 */
export async function capturePage({ url, width, layout = "auto", hideSelectors = "", inspect }) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  const log = [];
  const t0 = Date.now();
  const stage = (name) => process.env.S2F_DEBUG && console.log(`[stage] ${name} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  try {
    // Site CSP would block the injected pipeline and font stylesheets.
    await page.setBypassCSP(true);
    await page.setUserAgent(UA);
    await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
    await page.exposeFunction("__s2fNet", (u, kind) => netFetch(u, kind, url));
    // Viewport screenshot for canvas/video snapshots (src/core/snapshots.js).
    await page.exposeFunction("__s2fShot", async () => Buffer.from(await page.screenshot({ type: "png" })).toString("base64"));
    page.on("pageerror", () => {});
    page.on("console", (m) => m.text().startsWith("[s2f]") && console.log(m.text()));

    // Wait for "load", then for the network to calm down. Analytics and chat widgets
    // often keep connections open forever, so network idle is capped, not required.
    await page.goto(url, { waitUntil: "load", timeout: 60000 }).catch((e) => {
      if (!/timeout/i.test(e.message)) throw e;
      log.push("Страница грузилась слишком долго, захвачено то, что успело загрузиться");
    });
    stage("loaded");
    await page.waitForNetworkIdle({ idleTime: 800, concurrency: 2, timeout: 10000 }).catch(() => {});
    await page.addStyleTag({ content: FREEZE_CSS });
    stage("network idle");
    await autoScroll(page);
    stage("scrolled");
    await page.waitForNetworkIdle({ idleTime: 800, concurrency: 2, timeout: 8000 }).catch(() => {});

    const height = await page.evaluate(() => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight));
    stage("before thumbnail");
    const thumbnail = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width, height: Math.min(height, Math.round(width * 0.625)), scale: 400 / width },
    });

    stage("thumbnail");
    // Some sites redirect (locale, consent) after load, destroying the page context mid-capture:
    // wait for the new page to settle and start over.
    let res;
    for (let attempt = 1; ; attempt++) {
      try {
        await page.evaluate(INJECT);
        res = await page.evaluate((opts) => window.__s2fCapture(opts), {
          layout,
          hideSelectors,
          thumbnailB64: Buffer.from(thumbnail).toString("base64"),
          withTrace: Boolean(inspect),
        });
        break;
      } catch (e) {
        if (attempt >= 3 || !/context was destroyed|navigation|detached/i.test(e.message)) throw e;
        log.push("Страница перенаправила во время захвата — захват повторён");
        await page.waitForNavigation({ waitUntil: "load", timeout: 30000 }).catch(() => {});
        await page.waitForNetworkIdle({ idleTime: 800, concurrency: 2, timeout: 10000 }).catch(() => {});
        await page.addStyleTag({ content: FREEZE_CSS }).catch(() => {});
        await autoScroll(page).catch(() => {});
      }
    }
    console.log(`[capture] ${res.debug.seconds.toFixed(1)}s in page, fixes ${JSON.stringify(res.debug.fixes)}, fonts ${JSON.stringify(res.debug.fonts)}`);
    // With inspect, the pipeline leaves its DOM changes in place so trace paths still resolve.
    const inspected = inspect ? await inspect(page, res.trace) : undefined;
    if (inspect) await page.evaluate(() => globalThis.__s2fRestore?.());
    return { ...res, fig: Buffer.from(res.figB64, "base64"), log: [...log, ...res.log], inspected };
  } finally {
    await page.close().catch(() => {});
  }
}
