import { addToHistory, getHistory, clearHistory } from "../lib/history.js";
import { lang, t } from "../lib/i18n.js";

document.documentElement.lang = lang;
for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
for (const el of document.querySelectorAll("[data-i18n-aria]")) el.setAttribute("aria-label", t(el.dataset.i18nAria));
for (const el of document.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);

const STALE_MS = 30_000;

const MUSIC_HOSTS = [
  "open.spotify.com",
  "music.youtube.com",
  "music.apple.com",
  "soundcloud.com",
  "www.deezer.com",
  "listen.tidal.com",
];
const isMusicHost = (host) => MUSIC_HOSTS.includes(host) || /^music\.amazon\./.test(host);

const LINKS = [
  { key: "spotify", label: "Spotify" },
  { key: "youtube", label: "YouTube" },
  { key: "apple", label: "Apple Music" },
  { key: "songlink", label: t("allPlatforms") },
];

const $ = (id) => document.getElementById(id);
const views = ["idle", "listening", "result", "message", "history"];
let switchTabId = null;
let lastState = null;
let historyOpen = false;

function show(view) {
  for (const v of views) $(v).hidden = v !== view;
  const btn = $("listenBtn");
  btn.disabled = view === "listening";
  btn.hidden = view === "idle" || view === "listening";
  if (view === "history") btn.hidden = true;
  btn.textContent = {
    idle: t("listen"),
    listening: t("listening"),
    result: t("listenAgain"),
    message: t("tryAgain"),
    history: t("listen"),
  }[view];
}

function render(state) {
  lastState = state;
  if (historyOpen) return;
  if (!state || (state.status === "listening" && Date.now() - state.updatedAt > STALE_MS)) {
    show("idle");
    return;
  }
  switch (state.status) {
    case "listening":
      show("listening");
      break;
    case "result":
      renderResult(state.result);
      show("result");
      break;
    case "notfound":
      showMessage(t("notFound"));
      break;
    case "error":
      showMessage(state.error, true);
      break;
    default:
      show("idle");
  }
}

function showMessage(text, isError = false, tabId = null) {
  $("messageText").textContent = text;
  $("messageText").parentElement.classList.toggle("error", isError);
  switchTabId = tabId;
  $("switchTabBtn").hidden = tabId == null;
  show("message");
}

function renderResult(r) {
  $("title").textContent = r.title || t("unknownSong");
  $("artist").textContent = r.artist || "";
  const sameAsTitle = (r.album || "").toLowerCase() === (r.title || "").toLowerCase();
  const details = [sameAsTitle ? "" : r.album, r.year, r.genre].filter(Boolean).join(" · ");
  $("details").textContent = details;
  $("details").hidden = !details;
  const caught = $("caught");
  caught.hidden = !Number.isFinite(r.position);
  if (!caught.hidden) caught.textContent = `${t("caughtAt")} · ${formatTime(r.position)}`;

  const slot = $("coverSlot");
  slot.replaceChildren();
  if (/^https:\/\//.test(r.cover || "")) {
    const img = document.createElement("img");
    img.className = "cover";
    img.alt = "";
    img.src = r.cover;
    slot.append(img);
  }

  const links = $("links");
  links.replaceChildren();
  for (const { key, label } of LINKS) {
    const href = r.links?.[key];
    if (!href || !/^https:\/\//.test(href)) continue;
    const a = document.createElement("a");
    a.className = "btn btn-glass";
    a.textContent = label;
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
    links.append(a);
  }
}

const formatTime = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

const relTime = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
function ago(ts) {
  const s = (ts - Date.now()) / 1000;
  for (const [unit, size] of [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]]) {
    if (Math.abs(s) >= size) return relTime.format(Math.round(s / size), unit);
  }
  return t("justNow");
}

async function openHistory() {
  historyOpen = true;
  $("historyBtn").setAttribute("aria-pressed", "true");
  const list = await getHistory();
  const ul = $("historyList");
  ul.replaceChildren();
  $("historyEmpty").hidden = list.length > 0;
  $("clearHistory").hidden = list.length === 0;
  for (const item of list) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.className = "history-item";
    const thumb = document.createElement("span");
    thumb.className = "history-thumb";
    if (/^https:\/\//.test(item.cover || "")) {
      const img = document.createElement("img");
      img.alt = "";
      img.loading = "lazy";
      img.src = item.cover;
      thumb.append(img);
    }
    const text = document.createElement("span");
    text.className = "row-text";
    const t = document.createElement("span");
    t.className = "row-value";
    t.textContent = item.title || t("unknownSong");
    const meta = document.createElement("span");
    meta.className = "row-label history-meta";
    meta.textContent = item.artist || "";
    const when = document.createElement("span");
    when.className = "history-meta history-when";
    when.textContent = [item.site, ago(item.at)].filter(Boolean).join(" · ");
    text.append(t, meta, when);
    b.append(thumb, text);
    b.addEventListener("click", () => {
      closeHistory(false);
      renderResult(item);
      show("result");
    });
    li.append(b);
    ul.append(li);
  }
  show("history");
}

function closeHistory(rerender = true) {
  historyOpen = false;
  $("historyBtn").setAttribute("aria-pressed", "false");
  if (rerender) render(lastState);
}

async function getTab() {
  if (window.top !== window) {
    const own = await chrome.tabs.getCurrent();
    if (own) return own;
  }
  return (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
}

async function setState(state) {
  await chrome.storage.session.set({ state: { ...state, updatedAt: Date.now() } });
}

async function readPageMetadata(tabId) {
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const m = navigator.mediaSession?.metadata;
        if (!m?.title) return null;
        const art = [...(m.artwork || [])].pop();
        return { title: m.title, artist: m.artist, cover: art?.src || "" };
      },
    });
    return result;
  } catch {
    return null;
  }
}

async function listen() {
  if (historyOpen) closeHistory(false);
  const tab = await getTab();
  if (!tab) return;

  let host = "";
  try { host = new URL(tab.url).hostname; } catch {}

  if (isMusicHost(host)) {
    const meta = await readPageMetadata(tab.id);
    if (meta) {
      const result = {
        ...meta,
        site: host.replace(/^www\./, ""),
        links: searchLinks(meta.title, meta.artist),
      };
      await setState({ status: "result", result });
      await addToHistory(result);
      return;
    }
  }

  if (!tab.audible) {
    const [other] = await chrome.tabs.query({ audible: true });
    if (other) {
      showMessage(t("otherTabPlaying"), false, other.id);
    } else {
      showMessage(t("noSound"));
    }
    return;
  }

  await setState({ status: "listening" });
  const res = await chrome.runtime.sendMessage({ target: "background", type: "start", tabId: tab.id });
  if (res && !res.ok) showMessage(res.error, true);
}

function searchLinks(title, artist) {
  const q = encodeURIComponent(`${title} ${artist || ""}`.trim());
  return {
    spotify: `https://open.spotify.com/search/${q}`,
    youtube: `https://www.youtube.com/results?search_query=${q}`,
    apple: `https://music.apple.com/search?term=${q}`,
  };
}

const EMBEDDED = window.top !== window;
function closePanel() {
  if (EMBEDDED) parent.postMessage({ type: "asf-close" }, "*");
  else window.close();
}
if (EMBEDDED) {
  document.documentElement.classList.add("embedded");
  document.addEventListener("keydown", (e) => e.key === "Escape" && closePanel());
  new ResizeObserver(() => {
    parent.postMessage({ type: "asf-size", height: document.body.offsetHeight }, "*");
  }).observe(document.body);
}

$("listenBtn").addEventListener("click", listen);
$("orbBtn").addEventListener("click", listen);
$("closeBtn").addEventListener("click", closePanel);
$("historyBtn").addEventListener("click", () => (historyOpen ? closeHistory() : openHistory()));
$("clearHistory").addEventListener("click", async () => {
  await clearHistory();
  openHistory();
});

$("switchTabBtn").addEventListener("click", async () => {
  if (switchTabId == null) return;
  const tab = await chrome.tabs.update(switchTabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  closePanel();
});

$("settingsBtn").addEventListener("click", () => {
  const row = $("settingsRow");
  row.hidden = !row.hidden;
  $("settingsBtn").setAttribute("aria-expanded", String(!row.hidden));
  if (!row.hidden) $("token").focus();
});

async function saveToken() {
  await chrome.storage.local.set({ auddToken: $("token").value.trim() });
  $("saveToken").textContent = t("saved");
  setTimeout(() => {
    $("saveToken").textContent = t("save");
    $("settingsRow").hidden = true;
    $("settingsBtn").setAttribute("aria-expanded", "false");
  }, 900);
}
$("saveToken").addEventListener("click", saveToken);
$("token").addEventListener("keydown", (e) => e.key === "Enter" && saveToken());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.state) {
    if (historyOpen) closeHistory(false);
    render(changes.state.newValue);
  }
});

(async () => {
  const { state } = await chrome.storage.session.get("state");
  render(state);
  if (new URLSearchParams(location.search).has("auto")) listen();
  const { auddToken = "" } = await chrome.storage.local.get("auddToken");
  $("token").value = auddToken;
})();
