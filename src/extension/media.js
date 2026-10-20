// Media scan for the "Медиа" tab: every image, SVG and video the page uses.

const VIDEO_EXT = /\.(mp4|webm|ogv|ogg|mov|m4v)(\?|#|$)/i;
const SVG_EXT = /\.svg(\?|#|$)/i;

function kindOf(url) {
  if (url.startsWith("data:")) return /^data:image\/svg/.test(url) ? "svg" : /^data:video/.test(url) ? "video" : "image";
  if (SVG_EXT.test(url)) return "svg";
  if (VIDEO_EXT.test(url)) return "video";
  return "image";
}

// Largest candidate of a srcset ("a.jpg 480w, b.jpg 1200w" / "a.jpg 1x, b.jpg 2x").
function largestFromSrcset(srcset, base) {
  let best = null;
  let bestScore = -1;
  for (const part of srcset.split(/,\s+/)) {
    const [url, desc = "1x"] = part.trim().split(/\s+/);
    if (!url) continue;
    const score = parseFloat(desc) * (desc.endsWith("w") ? 1 : 1000);
    if (score > bestScore) {
      bestScore = score;
      try {
        best = new URL(url, base).href;
      } catch {}
    }
  }
  return best;
}

const urlsInCss = (value) => [...(value || "").matchAll(/url\((["']?)(.*?)\1\)/g)].map((m) => m[2]);

function fileNameFor(url, kind, index) {
  if (url.startsWith("data:")) {
    const ext = { svg: ".svg", video: ".mp4" }[kind] || "." + (url.match(/^data:image\/([a-z0-9+]+)/)?.[1]?.replace("jpeg", "jpg").replace("svg+xml", "svg") || "png");
    return `${kind}-${index}${ext}`;
  }
  try {
    const last = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
    return last.replace(/[\\/:*?"<>|]+/g, "_") || `${kind}-${index}`;
  } catch {
    return `${kind}-${index}`;
  }
}

// Inline <svg> → standalone file text (with xmlns, size taken from the rendered box).
function serializeInlineSvg(svg) {
  const clone = svg.cloneNode(true);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  if (!clone.getAttribute("viewBox")) {
    const r = svg.getBoundingClientRect();
    clone.setAttribute("viewBox", `0 0 ${Math.round(r.width)} ${Math.round(r.height)}`);
  }
  // Inline icons often inherit their colour from the page: make it explicit.
  const cs = getComputedStyle(svg);
  if (!clone.getAttribute("color")) clone.setAttribute("color", cs.color);
  if (!clone.getAttribute("fill") && cs.fill && cs.fill !== "rgb(0, 0, 0)") clone.setAttribute("fill", cs.fill);
  return new XMLSerializer().serializeToString(clone);
}

/** Returns [{ url, kind: "image"|"svg"|"video", name, text? (inline svg), width, height }]. */
export function scanMedia(excludeRoot) {
  const found = new Map(); // url or svg text -> item
  const base = document.baseURI;
  const add = (rawUrl, kindHint, el) => {
    if (!rawUrl) return;
    let url;
    try {
      url = new URL(rawUrl, base).href;
    } catch {
      return;
    }
    if (url.startsWith("blob:") || url.startsWith("javascript:")) return; // streams / not files
    if (url.startsWith("data:") && url.length < 400) return; // 1×1 placeholders
    if (found.has(url)) return;
    const kind = kindHint === "video" ? "video" : kindOf(url);
    const r = el?.getBoundingClientRect?.();
    found.set(url, { url, kind, width: Math.round(r?.width || 0), height: Math.round(r?.height || 0) });
  };

  for (const img of document.querySelectorAll("img")) {
    if (excludeRoot?.contains(img)) continue;
    add((img.srcset && largestFromSrcset(img.srcset, base)) || img.currentSrc || img.src, null, img);
  }
  for (const source of document.querySelectorAll("picture source[srcset]")) add(largestFromSrcset(source.srcset, base), null, source.parentElement);
  for (const video of document.querySelectorAll("video")) {
    add(video.currentSrc || video.src, "video", video);
    for (const s of video.querySelectorAll("source[src]")) add(s.src, "video", video);
    if (video.poster) add(video.poster, null, video);
  }
  for (const el of document.querySelectorAll("body, body *")) {
    if (excludeRoot?.contains(el)) continue;
    for (const pseudo of [null, "::before", "::after"]) {
      const cs = getComputedStyle(el, pseudo);
      for (const u of urlsInCss(cs.backgroundImage)) add(u, null, el);
      if (pseudo) for (const u of urlsInCss(cs.content)) add(u, null, el);
    }
  }
  for (const image of document.querySelectorAll("svg image")) add(image.getAttribute("href") || image.getAttribute("xlink:href"), null, image);
  for (const obj of document.querySelectorAll("object[data], embed[src]")) add(obj.data || obj.src, null, obj);
  for (const link of document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]')) add(link.href, null, null);

  // Inline SVGs (top-level only), deduplicated by content.
  let inlineIndex = 0;
  for (const svg of document.querySelectorAll("svg")) {
    if (svg.parentElement?.closest("svg") || excludeRoot?.contains(svg)) continue;
    const r = svg.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const text = serializeInlineSvg(svg);
    if (found.has(text)) continue;
    found.set(text, { url: null, text, kind: "svg", width: Math.round(r.width), height: Math.round(r.height), name: `inline-${++inlineIndex}.svg` });
  }

  const items = [...found.values()];
  const counters = {};
  for (const item of items) {
    counters[item.kind] = (counters[item.kind] || 0) + 1;
    item.name ||= fileNameFor(item.url, item.kind, counters[item.kind]);
  }
  return items;
}
