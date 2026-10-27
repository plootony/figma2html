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

const debuggerTabs = new Set();
const tabZooms = new Map();
chrome.debugger?.onDetach.addListener((source) => {
  debuggerTabs.delete(source.tabId);
  const zoom = tabZooms.get(source.tabId);
  tabZooms.delete(source.tabId);
  if (zoom != null) chrome.tabs.setZoom(source.tabId, zoom).catch(() => {});
});

async function restoreZoom(tabId) {
  const zoom = tabZooms.get(tabId);
  if (zoom == null) return;
  tabZooms.delete(tabId);
  try {
    await chrome.tabs.setZoom(tabId, zoom);
  } catch {}
}

async function emulateWidth(tabId, width, height) {
  if (!tabZooms.has(tabId)) {
    const zoom = await chrome.tabs.getZoom(tabId).catch(() => 1);
    tabZooms.set(tabId, zoom);
  }
  // Browser page zoom changes CSS pixels: 480 px at 80% zoom reports innerWidth 600.
  // Reset it while measuring, then restore it together with the emulation.
  try {
    await chrome.tabs.setZoom(tabId, 1);
  } catch {}
  let attached = false;
  try {
    if (!debuggerTabs.has(tabId)) {
      await chrome.debugger.attach({ tabId }, "1.3");
      debuggerTabs.add(tabId);
      attached = true;
    }
    await chrome.debugger.sendCommand({ tabId }, "Emulation.setDeviceMetricsOverride", {
      width: Math.round(width),
      height: Math.round(height),
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: Math.round(width),
      screenHeight: Math.round(height),
    });
    return { ok: true };
  } catch (e) {
    await restoreZoom(tabId);
    if (attached) {
      debuggerTabs.delete(tabId);
      await chrome.debugger.detach({ tabId }).catch(() => {});
    }
    throw e;
  }
}

async function clearEmulation(tabId) {
  await restoreZoom(tabId);
  if (!debuggerTabs.has(tabId)) return { ok: true };
  debuggerTabs.delete(tabId);
  try {
    await chrome.debugger.sendCommand({ tabId }, "Emulation.clearDeviceMetricsOverride");
  } catch {}
  try {
    await chrome.debugger.detach({ tabId });
  } catch {}
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

// captureVisibleTab shoots whichever tab is active in the window. If the user switched to
// another tab mid-capture, that tab would end up in the layout: refuse instead.
async function shot(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) throw new Error("вкладка неактивна");
  return { dataUrl: await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" }) };
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
    shot(sender.tab.id)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String(e.message || e) }));
    return true;
  }
  if (msg.type === "emulate-width") {
    emulateWidth(sender.tab.id, msg.width, msg.height)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String(e.message || e) }));
    return true;
  }
  if (msg.type === "emulate-clear") {
    clearEmulation(sender.tab.id)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String(e.message || e) }));
    return true;
  }
});
