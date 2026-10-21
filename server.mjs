import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { capturePage, closeBrowser } from "./capture.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4747;
const OUT_DIR = path.join(ROOT, "output");
fs.mkdirSync(OUT_DIR, { recursive: true });

async function capture({ url, width, layout, hideSelectors, targetSelector }) {
  const r = await capturePage({ url, width, layout, hideSelectors, targetSelector });
  const base = `${new URL(url).hostname}_${width}_${Date.now()}`;
  fs.writeFileSync(path.join(OUT_DIR, base + ".html"), r.clipboardHtml);
  fs.writeFileSync(path.join(OUT_DIR, base + ".fig"), r.fig);
  if (r.svgZipB64) fs.writeFileSync(path.join(OUT_DIR, base + "_svg.zip"), Buffer.from(r.svgZipB64, "base64"));
  return { base, name: r.name, height: r.height, figSize: r.fig.length, nodes: r.nodes, images: r.images, svgCount: r.svgCount, log: r.log };
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://localhost:${PORT}`);
    if (req.method === "GET" && u.pathname === "/") {
      return send(res, 200, fs.readFileSync(path.join(ROOT, "public/index.html")), "text/html; charset=utf-8");
    }
    if (req.method === "GET" && u.pathname === "/history") {
      const bases = fs
        .readdirSync(OUT_DIR)
        .filter((f) => f.endsWith(".html"))
        .map((f) => f.slice(0, -5))
        .map((base) => ({
          base,
          mtime: fs.statSync(path.join(OUT_DIR, base + ".html")).mtimeMs,
          hasFig: fs.existsSync(path.join(OUT_DIR, base + ".fig")),
          hasSvg: fs.existsSync(path.join(OUT_DIR, base + "_svg.zip")),
        }))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 30);
      return send(res, 200, bases);
    }
    if (req.method === "GET" && ["/clipboard", "/fig", "/svgzip"].includes(u.pathname)) {
      const base = path.basename(u.searchParams.get("base") || "");
      const suffix = { "/clipboard": ".html", "/fig": ".fig", "/svgzip": "_svg.zip" }[u.pathname];
      const p = path.join(OUT_DIR, base + suffix);
      if (!base || !fs.existsSync(p)) return send(res, 404, { error: "not found" });
      if (u.pathname === "/clipboard") return send(res, 200, fs.readFileSync(p, "utf8"), "text/plain; charset=utf-8");
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${base}${suffix}"`,
      });
      return res.end(fs.readFileSync(p));
    }
    if (req.method === "POST" && u.pathname === "/capture") {
      const body = JSON.parse((await readBody(req)) || "{}");
      let url = String(body.url || "").trim();
      if (!url) return send(res, 400, { error: "Укажите адрес сайта" });
      if (!/^https?:\/\//i.test(url)) url = "https://" + url;
      const widths = (Array.isArray(body.widths) && body.widths.length ? body.widths : [1440])
        .map(Number)
        .filter((w) => w >= 200 && w <= 4000);
      const layout = body.layout === "absolute" ? "absolute" : "auto";
      const results = [];
      for (const width of widths) {
        const t = Date.now();
        const r = await capture({ url, width, layout, hideSelectors: body.hideSelectors, targetSelector: body.targetSelector });
        console.log(`[ok] ${url} @${width}px → ${r.base} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
        results.push(r);
      }
      return send(res, 200, { results });
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    console.error("[error]", e);
    send(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`site2figma: http://localhost:${PORT}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    await closeBrowser();
    process.exit(0);
  });
}
