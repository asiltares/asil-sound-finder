(() => {
  const ID = "asil-sound-finder-overlay";
  const auto = window.__asfAuto === true;
  window.__asfAuto = undefined;
  const existing = document.getElementById(ID);
  if (existing) {
    existing.dispatchEvent(new Event("asf-close"));
    if (!auto) return;
  }

  const host = document.createElement("div");
  host.id = ID;
  host.style.cssText = "all: initial; position: fixed; top: 12px; right: 12px; z-index: 2147483647;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      .panel {
        width: 340px;
        border-radius: 28px;
        overflow: hidden;
        background: rgba(16, 16, 18, .72);
        backdrop-filter: blur(30px) saturate(180%);
        -webkit-backdrop-filter: blur(30px) saturate(180%);
        border: 1px solid rgba(255, 255, 255, .14);
        box-shadow: 0 20px 50px -12px rgba(0, 0, 0, .55), inset 0 1px 0 rgba(255, 255, 255, .14);
        opacity: 0;
        transform: translateY(-6px) scale(.98);
        transform-origin: top right;
        transition: opacity .18s ease, transform .18s ease;
      }
      .panel.open { opacity: 1; transform: none; }
      iframe {
        display: block;
        width: 340px;
        height: 120px;
        max-height: calc(100vh - 24px);
        border: 0;
        background: transparent;
        color-scheme: dark;
      }
      @media (prefers-reduced-motion: reduce) { .panel { transition: none; } }
    </style>
    <div class="panel"><iframe allowtransparency="true"></iframe></div>`;
  const panel = root.querySelector(".panel");
  const frame = root.querySelector("iframe");
  let ready = false;

  function close() {
    window.removeEventListener("message", onMessage);
    document.removeEventListener("mousedown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
    panel.classList.remove("open");
    host.id = "";
    setTimeout(() => host.remove(), 180);
  }

  function onMessage(e) {
    if (e.source !== frame.contentWindow || !e.data) return;
    if (e.data.type === "asf-size") {
      ready = true;
      frame.style.height = Math.ceil(e.data.height) + "px";
      panel.classList.add("open");
    } else if (e.data.type === "asf-close") {
      close();
    }
  }
  const onOutside = (e) => { if (!e.composedPath().includes(host)) close(); };
  const onKey = (e) => { if (e.key === "Escape") close(); };

  host.addEventListener("asf-close", close);
  window.addEventListener("message", onMessage);
  document.addEventListener("mousedown", onOutside, true);
  document.addEventListener("keydown", onKey, true);
  frame.src = chrome.runtime.getURL(auto ? "popup/popup.html?auto=1" : "popup/popup.html");
  document.documentElement.append(host);

  let fellBack = false;
  function fallback() {
    if (ready || fellBack || !host.isConnected || !host.id) return;
    fellBack = true;
    close();
    try { chrome.runtime.sendMessage({ target: "background", type: "fallback", auto }).catch(() => {}); } catch {}
  }
  frame.addEventListener("load", () => setTimeout(fallback, 1500), { once: true });
  setTimeout(fallback, 8000);
})();
