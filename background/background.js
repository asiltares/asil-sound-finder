import { addToHistory } from "../lib/history.js";
import { t } from "../lib/i18n.js";

const OFFSCREEN_URL = "offscreen/offscreen.html";
const MENU_ID = "asf-find";

async function setState(state) {
  await chrome.storage.session.set({ state: { ...state, updatedAt: Date.now() } });
}

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA"],
    justification: "Capture tab audio to recognize the song",
  });
}

async function closeOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (existing.length) await chrome.offscreen.closeDocument();
}

const siteOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
};

async function openPanel(tab, auto = false) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (flag) => { window.__asfAuto = flag; },
      args: [auto],
    });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["popup/overlay.js"] });
  } catch {
    openPopupFallback(tab.id, auto);
  }
}

async function openPopupFallback(tabId, auto = false) {
  try {
    await chrome.action.setPopup({ tabId, popup: auto ? "popup/popup.html?auto=1" : "popup/popup.html" });
    await chrome.action.openPopup();
  } catch {
  } finally {
    chrome.action.setPopup({ tabId, popup: "" }).catch(() => {});
  }
}

chrome.action.onClicked.addListener((tab) => openPanel(tab));

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_ID, title: t("contextMenu"), contexts: ["all"] });
  });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.contextMenus.update(MENU_ID, { title: t("contextMenu") }, () => void chrome.runtime.lastError);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID && tab?.id) openPanel(tab, true);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== "background") return;

  if (msg.type === "fallback") {
    if (sender.tab?.id) openPopupFallback(sender.tab.id, !!msg.auto);
    return;
  }

  if (msg.type === "start") {
    (async () => {
      try {
        let streamId;
        try {
          streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: msg.tabId });
        } catch (e) {
          throw new Error(`${t("cannotCapture")}: ${e.message}`);
        }
        const tab = await chrome.tabs.get(msg.tabId).catch(() => null);
        await chrome.storage.session.set({ listeningSite: siteOf(tab?.url) });
        await closeOffscreen();
        await setState({ status: "listening" });
        await ensureOffscreen();
        const { auddToken = "" } = await chrome.storage.local.get("auddToken");
        await chrome.runtime.sendMessage({
          target: "offscreen",
          type: "record",
          streamId,
          auddToken,
        });
        sendResponse({ ok: true });
      } catch (e) {
        await setState({ status: "error", error: e.message });
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.type === "done") {
    (async () => {
      if (msg.error) {
        await setState({ status: "error", error: msg.error });
      } else if (msg.result) {
        const { listeningSite = "" } = await chrome.storage.session.get("listeningSite");
        const result = { ...msg.result, site: listeningSite };
        await setState({ status: "result", result });
        await addToHistory(result);
      } else {
        await setState({ status: "notfound" });
      }
      await closeOffscreen();
    })();
  }
});
