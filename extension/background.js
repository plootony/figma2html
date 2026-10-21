// Toolbar click → inject the capture panel into the tab. The background also serves network
// requests for the page (extension fetch has no CORS limits) and takes the thumbnail.

async function ensureContent(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "s2f-ping" });
    return false;
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return true;
  }
}

async function sendToTab(tab, type) {
  const injected = await ensureContent(tab.id);
  // On a fresh injection the panel is already visible: toggling would hide it.
  if (!(injected && type === "s2f-toggle")) await chrome.tabs.sendMessage(tab.id, { type });
  await chrome.action.setBadgeText({ tabId: tab.id, text: "" });
  await chrome.action.setTitle({ tabId: tab.id, title: "Site to Figma — захватить страницу" });
}

const windowStates = new Map();

async function normalizeWindow(windowId) {
  const win = await chrome.windows.get(windowId);
  if (win.state === "normal") return { ok: true, changed: false };
  await chrome.windows.update(windowId, { state: "normal" });
  await new Promise((r) => setTimeout(r, 700));
  return { ok: true, changed: true };
}

async function resizeWindow(windowId, width, height) {
  if (!windowStates.has(windowId)) {
    const win = await chrome.windows.get(windowId);
    windowStates.set(windowId, { width: win.width, height: win.height, state: win.state });
  }
  const current = await chrome.windows.get(windowId);
  if (current.state !== "normal") {
    await chrome.windows.update(windowId, { state: "normal" });
    // Window managers restore a maximized window asynchronously, and the chrome frame
    // changes width at the same time. Unmaximize first, let the caller measure the new
    // viewport, then apply the requested bounds on the next call.
    await new Promise((r) => setTimeout(r, 400));
    return { ok: true, unmaximized: true, state: current.state };
  }
  await chrome.windows.update(windowId, { width: Math.max(400, Math.round(width)), height: Math.max(400, Math.round(height)) });
  return { ok: true, state: "normal" };
}

async function restoreWindow(windowId) {
  const saved = windowStates.get(windowId);
  if (!saved) return { ok: true };
  windowStates.delete(windowId);
  if (saved.state === "maximized" || saved.state === "fullscreen") await chrome.windows.update(windowId, { state: saved.state });
  else await chrome.windows.update(windowId, { state: "normal", width: saved.width, height: saved.height });
  return { ok: true };
}

async function fail(tabId, e) {
  // chrome://, the new tab page, the Web Store and PDFs can't be scripted: say so on the icon.
  console.warn("site2figma: cannot run on this page", e);
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#c62f2f" });
  await chrome.action.setBadgeText({ tabId, text: "✕" });
  await chrome.action.setTitle({ tabId, title: "Site to Figma не работает на этой странице: " + (e.message || e) });
}

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await sendToTab(tab, "s2f-toggle");
  } catch (e) {
    await fail(tab.id, e);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) return;
  const type = command === "capture-page" ? "s2f-capture" : command === "pick-block" ? "s2f-pick" : null;
  if (!type) return;
  try {
    await sendToTab(tab, type);
  } catch (e) {
    await fail(tab.id, e);
  }
});

function bytesToBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function netOnce(url, kind, timeout = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { credentials: "include", signal: controller.signal });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.retry = res.status >= 500 || res.status === 429;
      throw err;
    }
    if (kind === "text") return { text: await res.text() };
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { b64: bytesToBase64(bytes), mime: (res.headers.get("content-type") || "application/octet-stream").split(";")[0].trim() };
  } finally {
    clearTimeout(timer);
  }
}

async function net(url, kind) {
  let last;
  for (let i = 0; i < 2; i++) {
    try {
      return await netOnce(url, kind);
    } catch (e) {
      last = e;
      if (e.retry === false || i === 1) break;
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  return { error: String(last?.message || last) };
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
  if (msg.type === "normalize-window") {
    normalizeWindow(sender.tab.windowId)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String(e.message || e) }));
    return true;
  }
  if (msg.type === "resize") {
    resizeWindow(sender.tab.windowId, msg.width, msg.height)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String(e.message || e) }));
    return true;
  }
  if (msg.type === "restore-window") {
    restoreWindow(sender.tab.windowId)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String(e.message || e) }));
    return true;
  }
});
