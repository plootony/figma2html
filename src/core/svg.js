// SVG images (<img src="*.svg">). The converter rasterises them at their natural size
// (blurry) and Figma has no animated SVG at all. Two paths:
// - simple SVGs (shapes with plain fills/strokes — icons) are inlined into the page before
//   the capture, so the converter turns them into editable vectors from the original file;
// - complex ones (gradients, clip paths, filters, text, CSS/SMIL animation…) would lose too
//   much as vectors: they stay images, rasterised at 2× their size, the layer is named after
//   the file, and the original SVG is kept so it can be downloaded and dropped into Figma
//   (Figma's own SVG import handles all of that).

const SIMPLE_TAGS = new Set(["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "defs", "title", "desc", "metadata"]);

export const isSvgUrl = (url) => /\.svg(\?|#|$)/i.test(url) || url.startsWith("data:image/svg+xml");

export const fileName = (url) => {
  if (url.startsWith("data:")) return "image.svg";
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop()) || "image.svg";
  } catch {
    return "image.svg";
  }
};

// Why an SVG can't be inlined as vectors (null = simple enough).
export function complexity(svgRoot) {
  for (const el of [svgRoot, ...svgRoot.querySelectorAll("*")]) {
    const tag = el.localName;
    if (!SIMPLE_TAGS.has(tag)) return tag;
    for (const attr of ["clip-path", "mask", "filter", "fill", "stroke", "style"]) {
      if (/url\(/.test(el.getAttribute(attr) || "")) return `${attr}=url()`;
    }
  }
  return null;
}

export async function fetchSvgText(url, net) {
  if (url.startsWith("data:")) return await (await fetch(url)).text();
  return await net.text(url);
}

// Inherited painting properties: inside <img> the SVG is its own document, so they start
// from their initial values, not from the page (e.g. currentColor = black, not the page's
// text colour). The root's presentation attributes (fill="none" …) must win, so they are
// re-applied here — inline CSS would otherwise override them.
const INHERITED_SVG_PROPS = {
  color: "black",
  fill: "black",
  "fill-opacity": "1",
  "fill-rule": "nonzero",
  stroke: "none",
  "stroke-width": "1",
  "stroke-opacity": "1",
  "stroke-linecap": "butt",
  "stroke-linejoin": "miter",
  "stroke-miterlimit": "4",
  "stroke-dasharray": "none",
  "stroke-dashoffset": "0",
  "paint-order": "normal",
  "shape-rendering": "auto",
  "clip-rule": "nonzero",
  visibility: "visible",
  cursor: "auto",
  "pointer-events": "auto",
};

// Layout-related properties copied from the <img> to the inline <svg>.
const LAYOUT_PROPS = [
  "display", "position", "top", "right", "bottom", "left", "float", "clear", "z-index",
  "width", "height", "box-sizing", "vertical-align", "visibility", "opacity", "transform", "transform-origin",
  "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "border-top-style", "border-right-style", "border-bottom-style", "border-left-style",
  "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
  "border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius",
  "background-color", "flex-grow", "flex-shrink", "flex-basis", "align-self", "justify-self", "order",
  "grid-row-start", "grid-row-end", "grid-column-start", "grid-column-end", "filter", "mix-blend-mode",
];

/**
 * Inline simple SVG <img>s; collect the originals of the complex ones.
 * Returns { inlined, originals: Map(url -> { name, text, reason }) }.
 */
export async function prepareSvgImages(journal, net, root = document.body) {
  const originals = new Map();
  const texts = new Map(); // url -> Promise<text | null>
  const getText = (url) => {
    if (!texts.has(url)) texts.set(url, fetchSvgText(url, net).catch(() => null));
    return texts.get(url);
  };
  let inlined = 0;
  const images = [...root.querySelectorAll("img")];
  if (root.tagName === "IMG") images.unshift(root);
  for (const img of images) {
    const url = img.currentSrc || img.src;
    if (!url || !isSvgUrl(url)) continue;
    const rect = img.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    const text = await getText(url);
    if (!text) continue;
    const doc = new DOMParser().parseFromString(text, "image/svg+xml");
    const root = doc.documentElement;
    if (root.localName !== "svg" || doc.querySelector("parsererror")) continue;
    const reason = complexity(root);
    if (reason) {
      originals.set(url, { name: fileName(url), text, reason });
      continue;
    }
    const svg = document.importNode(root, true);
    const cs = getComputedStyle(img);
    if (!svg.getAttribute("viewBox")) {
      const w = parseFloat(root.getAttribute("width")) || rect.width;
      const h = parseFloat(root.getAttribute("height")) || rect.height;
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    }
    svg.setAttribute("width", rect.width);
    svg.setAttribute("height", rect.height);
    svg.setAttribute("data-s2f-svg", fileName(url));
    for (const [prop, initial] of Object.entries(INHERITED_SVG_PROPS)) {
      svg.style.setProperty(prop, root.getAttribute(prop) ?? initial, "important");
    }
    for (const prop of LAYOUT_PROPS) svg.style.setProperty(prop, cs.getPropertyValue(prop), "important");
    img.replaceWith(svg);
    journal.undo(() => svg.replaceWith(img));
    inlined++;
  }
  return { inlined, originals };
}

// Rasterise an SVG at `scale` × its displayed size (the converter would use its natural size).
export async function rasterizeSvg(bytes, displayW, displayH, scale = 2) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = Math.max(1, Math.round(displayW * scale));
    const h = Math.max(1, Math.round(displayH * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(img, 0, 0, w, h);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}

// <svg><use href="sprite.svg#icon"/></svg> — icon sprites (external file or inline <symbol>s).
// The converter doesn't follow <use>, so such icons vanished. Each <use> is replaced with
// a copy of what it references: a <symbol> becomes a nested <svg> with the symbol's
// viewBox (or, when the <use> is the icon's only content, the outer svg takes the viewBox).
const XLINK = "http://www.w3.org/1999/xlink";

// Styles inside an external sprite (<style>.st0{fill:none}</style>) don't reach copies of its
// symbols in the page, so they are applied as inline styles in the sprite document first.
function inlineSpriteStyles(doc) {
  const css = [...doc.querySelectorAll("style")].map((st) => st.textContent).join("\n");
  if (!css.trim()) return doc;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    for (const rule of sheet.cssRules) {
      if (!rule.selectorText || !rule.style) continue;
      let targets;
      try {
        targets = doc.querySelectorAll(rule.selectorText);
      } catch {
        continue;
      }
      for (const el of targets) {
        for (const prop of rule.style) {
          const value = rule.style.getPropertyValue(prop);
          const priority = rule.style.getPropertyPriority(prop);
          // Existing inline style wins unless the rule is !important (CSS cascade).
          if (el.style && (!el.style.getPropertyValue(prop) || priority)) el.style.setProperty(prop, value, priority);
        }
      }
    }
  } catch {}
  return doc;
}

export async function resolveSvgUses(journal, net, root = document.body) {
  const sprites = new Map(); // url -> Promise<Document | null>
  const loadSprite = (url) => {
    if (!sprites.has(url)) {
      sprites.set(
        url,
        fetchSvgText(url, net)
          .then((text) => inlineSpriteStyles(new DOMParser().parseFromString(text, "image/svg+xml")))
          .catch(() => null)
      );
    }
    return sprites.get(url);
  };
  let resolved = 0;
  const uses = [...root.querySelectorAll("svg use"), ...(root.tagName === "SVG" ? root.querySelectorAll("use") : [])];
  for (const use of uses) {
    const href = use.getAttribute("href") || use.getAttributeNS(XLINK, "href") || "";
    const hash = href.indexOf("#");
    if (hash < 0) continue;
    const id = decodeURIComponent(href.slice(hash + 1));
    const file = href.slice(0, hash);
    let target;
    if (file) {
      let url;
      try {
        url = new URL(file, document.baseURI).href;
      } catch {
        continue;
      }
      const doc = await loadSprite(url);
      target = doc && (doc.getElementById(id) || doc.querySelector(`[id="${CSS.escape(id)}"]`));
    } else {
      target = document.getElementById(id);
    }
    if (!target) continue;

    const outer = use.ownerSVGElement;
    const num = (a) => parseFloat(use.getAttribute(a)) || 0;
    let replacement;
    if (target.localName === "symbol" || target.localName === "svg") {
      const viewBox = target.getAttribute("viewBox");
      const onlyChild = outer && [...outer.children].filter((c) => c.localName !== "title" && c.localName !== "desc").length === 1;
      const plain = !use.getAttribute("x") && !use.getAttribute("y") && !use.getAttribute("width") && !use.getAttribute("height");
      if (viewBox && onlyChild && plain && !outer.getAttribute("viewBox")) {
        // Typical icon: the outer <svg> becomes the symbol's viewport.
        outer.setAttribute("viewBox", viewBox);
        journal.undo(() => outer.removeAttribute("viewBox"));
        const par = target.getAttribute("preserveAspectRatio");
        if (par && !outer.getAttribute("preserveAspectRatio")) {
          outer.setAttribute("preserveAspectRatio", par);
          journal.undo(() => outer.removeAttribute("preserveAspectRatio"));
        }
        replacement = document.createElementNS("http://www.w3.org/2000/svg", "g");
      } else {
        replacement = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        replacement.setAttribute("x", num("x"));
        replacement.setAttribute("y", num("y"));
        replacement.setAttribute("width", use.getAttribute("width") || "100%");
        replacement.setAttribute("height", use.getAttribute("height") || "100%");
        if (viewBox) replacement.setAttribute("viewBox", viewBox);
      }
      for (const child of target.childNodes) replacement.appendChild(document.importNode(child, true));
    } else {
      replacement = document.createElementNS("http://www.w3.org/2000/svg", "g");
      if (num("x") || num("y")) replacement.setAttribute("transform", `translate(${num("x")} ${num("y")})`);
      const clone = document.importNode(target, true);
      clone.removeAttribute("id");
      replacement.appendChild(clone);
    }
    // Presentation attributes: those of the <use> (inherited by the icon) and those of the
    // <symbol> itself — e.g. <symbol fill="none"> makes an outline icon; dropping it turned
    // outline icons into solid shapes. The symbol's own attributes win, as in the browser.
    const skip = /^(href|xlink:href|x|y|width|height|id|viewBox|preserveAspectRatio)$/;
    for (const attr of use.attributes) if (!skip.test(attr.name)) replacement.setAttribute(attr.name, attr.value);
    if (target.localName === "symbol" || target.localName === "svg") {
      for (const attr of target.attributes) {
        if (skip.test(attr.name)) continue;
        if (attr.name === "class") replacement.setAttribute("class", `${replacement.getAttribute("class") || ""} ${attr.value}`.trim());
        else if (attr.name === "style") replacement.setAttribute("style", `${replacement.getAttribute("style") || ""};${attr.value}`);
        else replacement.setAttribute(attr.name, attr.value);
      }
    }
    use.replaceWith(replacement);
    journal.undo(() => replacement.replaceWith(use));
    resolved++;
  }
  return resolved;
}
