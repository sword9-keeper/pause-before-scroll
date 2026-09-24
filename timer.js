(() => {
  let timer;
  let host;
  let deadline;
  let warningSeconds = 60;
  let expiring = false;
  let lastSync = 0;

  function mount() {
    if (!document.documentElement || host?.isConnected) return;
    host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;right:16px;top:16px;z-index:2147483647;";
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      .clock { box-sizing:border-box; display:flex; flex-wrap:wrap; align-items:center; gap:10px;
        max-width:calc(100vw - 32px); padding:10px 14px; border:1px solid #cbd5ce;
        border-radius:6px; background:#fff; color:#24352c;
        font:14px/1.5 system-ui,sans-serif; box-shadow:0 2px 10px #0002; }
      .warning { background:#fff1ee; border-color:#df654e; color:#a22c21; }
      strong { font-variant-numeric:tabular-nums; font-size:18px; }
    `;
    const clock = document.createElement("div");
    clock.className = "clock";
    clock.setAttribute("role", "timer");
    const label = document.createElement("span");
    const value = document.createElement("strong");
    clock.append(label, value);
    root.append(style, clock);
    host._clock = clock;
    host._label = label;
    host._value = value;
    document.documentElement.append(host);
  }

  async function sync(type = "timer") {
    lastSync = Date.now();
    try {
      const response = await chrome.runtime.sendMessage({ type });
      if (response?.ok && response.data) {
        deadline = response.data.expiresAt;
        warningSeconds = response.data.warningSeconds;
      } else if (response?.ok) {
        deadline = null;
        host?.remove();
      }
    } catch {
      clearInterval(timer);
      host?.remove();
    }
  }

  function tick() {
    if (Date.now() - lastSync > 15000) void sync();
    if (!deadline) return;
    mount();
    if (!host) return;
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    const warning = remaining <= warningSeconds;
    host._clock.classList.toggle("warning", warning);
    host._label.textContent = warning ? "标签页即将关闭" : "本次剩余";
    host._value.textContent = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
    if (remaining === 0 && !expiring) {
      expiring = true;
      sync("expire").finally(() => { expiring = false; });
    }
  }

  document.addEventListener("visibilitychange", () => { void sync().then(tick); });
  window.addEventListener("pageshow", () => { void sync().then(tick); });
  void sync().then(tick);
  timer = setInterval(tick, 500);
})();
