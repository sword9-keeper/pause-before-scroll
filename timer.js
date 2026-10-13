(() => {
  let timer;
  let host;
  let deadline;
  let warningSeconds = 60;
  let expiring = false;
  let lastSync = 0;
  let layout = { x: 1, y: 0, collapsed: false };
  let initialized = false;
  let drag;
  let reason = "";
  let relatedTabs = 1;

  function position() {
    if (!host) return;
    const bounds = host.getBoundingClientRect();
    host.style.left = `${8 + layout.x * Math.max(0, innerWidth - bounds.width - 16)}px`;
    host.style.top = `${8 + layout.y * Math.max(0, innerHeight - bounds.height - 16)}px`;
  }

  function saveLayout() {
    void chrome.runtime.sendMessage({ type: "timerLayout", layout }).catch(() => {});
  }

  function mount() {
    if (!document.documentElement || host?.isConnected) return;
    host = document.createElement("div");
    host.id = "pause-before-scroll-timer";
    host.style.cssText = "all:initial;position:fixed;left:8px;top:8px;z-index:2147483647;";
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      .clock { box-sizing:border-box; display:flex; align-items:center; gap:8px;
        max-width:calc(100vw - 16px); padding:6px 8px; border:1px solid #cbd5ce;
        border-radius:6px; background:#fff; color:#24352c;
        font:14px/1.5 system-ui,sans-serif; box-shadow:0 2px 10px #0002; }
      .warning { background:#fff1ee; border-color:#df654e; color:#a22c21; }
      strong { font-variant-numeric:tabular-nums; font-size:18px; }
      button { display:grid; place-items:center; width:28px; height:28px; flex:none;
        padding:0; border:0; border-radius:4px; background:transparent; color:inherit;
        font:20px/1 system-ui; cursor:pointer; }
      button:hover { background:#0001; }
      button:focus-visible { outline:2px solid #287b58; }
      .drag { cursor:grab; touch-action:none; }
      .collapsed .label { display:none; }
      .label { font-size:12px; }
      strong { min-width:5ch; text-align:center; }
      .done { width:auto; max-width:110px; font:12px/1.5 system-ui; padding:3px 7px;
        border:1px solid #aebfb5; color:#22543d; white-space:normal; }
    `;
    const clock = document.createElement("div");
    clock.className = "clock";
    const grip = document.createElement("button");
    grip.className = "drag";
    grip.textContent = "\u283f";
    grip.title = "移动倒计时";
    grip.setAttribute("aria-label", grip.title);
    const label = document.createElement("span");
    const value = document.createElement("strong");
    value.setAttribute("role", "timer");
    label.className = "label";
    const toggle = document.createElement("button");
    const done = document.createElement("button");
    done.className = "done";
    done.textContent = "结束并关闭";
    done.addEventListener("click", async () => {
      done.disabled = true;
      try {
        let response = await chrome.runtime.sendMessage({ type: "endVisit" });
        while (response?.ok && response.data?.confirmationRequired) {
          const count = response.data.tabCount;
          if (!confirm(`结束本次浏览并关闭 ${count} 个相关标签页？请先保存未完成的内容。`)) return;
          response = await chrome.runtime.sendMessage({ type: "endVisit", confirmedTabs: count });
        }
        if (!response?.ok) {
          done.title = response?.error || "操作失败，请重试";
          return;
        }
        if (response.data?.ended) { deadline = null; host?.remove(); }
      } catch { host?.remove(); }
      finally { done.disabled = false; }
    });
    function appearance() {
      clock.classList.toggle("collapsed", layout.collapsed);
      toggle.textContent = layout.collapsed ? "+" : "\u2212";
      toggle.title = layout.collapsed ? "展开倒计时" : "收起倒计时";
      toggle.setAttribute("aria-label", toggle.title);
      toggle.setAttribute("aria-expanded", String(!layout.collapsed));
      position();
    }
    toggle.addEventListener("click", () => {
      layout.collapsed = !layout.collapsed;
      appearance();
      saveLayout();
    });
    grip.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      const bounds = host.getBoundingClientRect();
      drag = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
      grip.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    grip.addEventListener("pointermove", event => {
      if (!drag) return;
      const bounds = host.getBoundingClientRect();
      layout.x = Math.max(0, Math.min(1, (event.clientX - drag.x - 8) / Math.max(1, innerWidth - bounds.width - 16)));
      layout.y = Math.max(0, Math.min(1, (event.clientY - drag.y - 8) / Math.max(1, innerHeight - bounds.height - 16)));
      position();
    });
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) {
      grip.addEventListener(name, () => {
        if (!drag) return;
        drag = null;
        saveLayout();
      });
    }
    grip.addEventListener("keydown", event => {
      const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const delta = directions[event.key];
      if (!delta) return;
      event.preventDefault();
      layout.x = Math.max(0, Math.min(1, layout.x + delta[0] * 0.05));
      layout.y = Math.max(0, Math.min(1, layout.y + delta[1] * 0.05));
      position();
      saveLayout();
    });
    clock.append(grip, label, value, done, toggle);
    root.append(style, clock);
    host._clock = clock;
    host._label = label;
    host._value = value;
    host._done = done;
    document.documentElement.append(host);
    appearance();
  }

  async function sync(type = "timer") {
    lastSync = Date.now();
    try {
      const response = await chrome.runtime.sendMessage({
        type, foreground: document.visibilityState === "visible" && document.hasFocus()
      });
      if (response?.ok && response.data) {
        deadline = response.data.expiresAt;
        warningSeconds = response.data.warningSeconds;
        reason = response.data.reason || "";
        relatedTabs = response.data.relatedTabs || 1;
        if (!initialized) {
          layout = response.data.timerLayout || layout;
          initialized = true;
        }
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
    if (Date.now() - lastSync > (document.hidden ? 15000 : 5000)) void sync();
    if (!deadline) return;
    mount();
    if (!host) return;
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    const warning = remaining <= warningSeconds;
    host._clock.classList.toggle("warning", warning);
    host._label.textContent = warning ? "标签页即将关闭" : "本次剩余";
    host._value.textContent = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
    host._clock.title = warning ? "本次浏览即将结束，到期关闭相关标签页" : `这次是为了：${reason}`;
    host._done.title = `结束本次浏览并关闭 ${relatedTabs} 个相关标签页`;
    position();
    if (remaining === 0 && !expiring) {
      expiring = true;
      sync("expire").finally(() => { expiring = false; });
    }
  }

  document.addEventListener("visibilitychange", () => { void sync().then(tick); });
  window.addEventListener("pageshow", () => { void sync().then(tick); });
  window.addEventListener("focus", () => { void sync().then(tick); });
  window.addEventListener("blur", () => { void sync().then(tick); });
  window.addEventListener("resize", position);
  void sync().then(tick);
  timer = setInterval(tick, 500);
})();
