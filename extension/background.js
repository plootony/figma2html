// Toolbar click → inject the capture panel into the tab. The background also serves network
// requests for the page (extension fetch has no CORS limits) and takes the thumbnail.

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    await chrome.action.setBadgeText({ tabId: tab.id, text: "" });
    await chrome.action.setTitle({ tabId: tab.id, title: "Site to Figma — захватить страницу" });
  } catch (e) {
    // chrome://, the new tab page, the Web Store and PDFs can't be scripted: say so on the icon.
    console.warn("site2figma: cannot run on this page", e);
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#c62f2f" });
    await chrome.action.setBadgeText({ tabId: tab.id, text: "✕" });
    await chrome.action.setTitle({ tabId: tab.id, title: "Site to Figma не работает на этой странице: " + (e.message || e) });
  }
});

function bytesToBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function net(url, kind) {
  try {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    if (kind === "text") return { text: await res.text() };
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { b64: bytesToBase64(bytes), mime: (res.headers.get("content-type") || "application/octet-stream").split(";")[0].trim() };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

const EXT_BY_MIME = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp", "image/avif": ".avif",
  "image/svg+xml": ".svg", "image/x-icon": ".ico", "image/vnd.microsoft.icon": ".ico", "image/bmp": ".bmp",
  "video/mp4": ".mp4", "video/webm": ".webm", "video/ogg": ".ogv", "video/quicktime": ".mov",
};

// Save one media file into Downloads/<path>. Names without an extension (common for CSS
// backgrounds and CDN URLs) get one from the server's content type.
async function download(url, path) {
  if (!/\.[a-z0-9]{2,5}$/i.test(path) && !url.startsWith("data:")) {
    try {
      const res = await fetch(url, { method: "HEAD", credentials: "include" });
      const ext = EXT_BY_MIME[(res.headers.get("content-type") || "").split(";")[0].trim()];
      if (ext) path += ext;
    } catch {}
  }
  const id = await chrome.downloads.download({ url, filename: path, conflictAction: "uniquify", saveAs: false });
  return { id };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "download") {
    download(msg.url, msg.path)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String(e.message || e) }));
    return true;
  }
  if (msg.type === "net") {
    net(msg.url, msg.kind).then(sendResponse);
    return true;
  }
  if (msg.type === "shot") {
    chrome.tabs
      .captureVisibleTab(sender.tab.windowId, { format: "png" })
      .then((dataUrl) => sendResponse({ dataUrl }))
      .catch((e) => sendResponse({ error: String(e.message || e) }));
    return true;
  }
});
