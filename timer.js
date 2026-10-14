(() => {
  if (globalThis.__pauseTimerInstalled) return;
  globalThis.__pauseTimerInstalled = true;
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
  let expiryAction = "pause";
  let paused;
  let active = true;
  let syncVersion = 0;
  const prompt = new globalThis.PauseExpiryPrompt({
    resume: async input => {
      const response = await chrome.runtime.sendMessage({ type: "resumeVisit", ...input });
      if (!response?.ok) throw new Error(response?.error || "恢复失败，请重试。");
      if (!response.data) throw new Error("页面已切换，请刷新状态后重试。");
      syncVersion++;
      applyState(response.data);
      tick();
    },
    close: async data => {
      let response = await chrome.runtime.sendMessage({ type: "endVisit", recordId: data.recordId });
      while (response?.ok && response.data?.confirmationRequired) {
        const count = response.data.tabCount;
        if (!confirm(`关闭 ${count} 个已到期的相关标签页？请先保存未完成的内容。`)) return;
        response = await chrome.runtime.sendMessage({ type: "endVisit", recordId: data.recordId, confirmedTabs: count });
      }
      if (!response?.ok) throw new Error(response?.error || "关闭失败，请重试。");
      if (response.data?.ended) { paused = null; prompt.hide(); }
    }
  });

  function applyState(data) {
    if (data?.inactive) data = null;
    active = Boolean(data);
    if (active) timer ??= setInterval(tick, 500);
    else {
      clearInterval(timer);
      timer = undefined;
    }
    if (data?.paused) {
      paused = data;
      deadline = null;
      host?.remove();
      prompt.show(data);
      return;
    }
    paused = null;
    prompt.hide();
    if (!data) {
      deadline = null;
      host?.remove();
      return;
    }
    deadline = data.expiresAt;
    warningSeconds = data.warningSeconds;
    expiryAction = data.expiryAction;
    reason = data.reason || "";
    relatedTabs = data.relatedTabs || 1;
    if (!initialized) {
      layout = data.timerLayout || layout;
      initialized = true;
    }
  }

  function viewportSize() {
    const root = document.compatMode === "BackCompat" ? document.body : document.documentElement;
    return { width: root?.clientWidth || innerWidth, height: root?.clientHeight || innerHeight };
  }

  function position() {
    if (!host) return;
    const viewport = viewportSize();
    host.style.maxWidth = `${Math.max(0, viewport.width - 16)}px`;
    const bounds = host.getBoundingClientRect();
    const y = host._clock.classList.contains("readonly") ? 0 : layout.y;
    host.style.left = `${8 + layout.x * Math.max(0, viewport.width - bounds.width - 16)}px`;
    host.style.top = `${8 + y * Math.max(0, viewport.height - bounds.height - 16)}px`;
  }

  function saveLayout() {
    void chrome.runtime.sendMessage({ type: "timerLayout", layout }).catch(() => {});
  }

  function fullscreenLayer() {
    if (!host?.isConnected) return;
    try {
      if (host.matches(":popover-open")) host.hidePopover();
      let fullscreen = document.fullscreenElement;
      while (fullscreen?.shadowRoot?.fullscreenElement) fullscreen = fullscreen.shadowRoot.fullscreenElement;
      // Replaced elements cannot render children; their overlay is display-only.
      const readOnly = fullscreen && /^(VIDEO|AUDIO|IFRAME|EMBED|OBJECT|IMG|CANVAS|INPUT|TEXTAREA|SELECT)$/.test(fullscreen.tagName);
      const parent = fullscreen && !readOnly ? fullscreen : document.documentElement;
      // Fullscreen makes nodes outside its subtree inert, even in the top layer.
      if (host.parentNode !== parent) parent.append(host);
      host._clock.classList.toggle("readonly", Boolean(readOnly));
      if (fullscreen) {
        // Reopen after each fullscreen transition, including nested players.
        host.popover = "manual";
        host.showPopover();
      } else host.removeAttribute("popover");
    } catch {
      host.removeAttribute("popover");
    }
    position();
  }

  function mount() {
    if (!document.documentElement || host?.isConnected) return;
    host = document.createElement("div");
    host.id = "pause-before-scroll-timer";
    // Auto width shrinks against the right edge before labels render or scrollbars appear.
    host.style.cssText = "all:initial;position:fixed;width:max-content;inset:auto;left:8px;top:8px;margin:0;z-index:2147483647;";
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host::backdrop { display:none; }
      .clock { box-sizing:border-box; display:flex; align-items:center; gap:8px;
        width:max-content; max-width:100%; min-height:50px; padding:6px 8px; border:1px solid #cbd5ce;
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
      .readonly button { display:none; }
      .readonly .label { display:inline; }
      .label { font-size:12px; flex:0 0 4em; }
      strong { width:7ch; flex:none; white-space:nowrap; text-align:center; }
      .done { width:auto; max-width:110px; font:12px/1.5 system-ui; padding:3px 7px;
        border:1px solid #aebfb5; color:#22543d; white-space:normal; }
      @media(max-width:360px) { .clock { gap:4px; padding-inline:4px; } }
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
      const viewport = viewportSize();
      const bounds = host.getBoundingClientRect();
      layout.x = Math.max(0, Math.min(1, (event.clientX - drag.x - 8) / Math.max(1, viewport.width - bounds.width - 16)));
      layout.y = Math.max(0, Math.min(1, (event.clientY - drag.y - 8) / Math.max(1, viewport.height - bounds.height - 16)));
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
    fullscreenLayer();
  }

  async function sync(type = "timer") {
    if (!active) return;
    const version = ++syncVersion;
    lastSync = Date.now();
    try {
      const response = await chrome.runtime.sendMessage({
        type, foreground: document.visibilityState === "visible" && document.hasFocus()
      });
      // Null can mean navigation has not committed yet, not that this page is exempt.
      if (version === syncVersion && response?.ok && response.data !== null) applyState(response.data);
    } catch {
      if (version === syncVersion) applyState(null);
    }
  }

  function tick() {
    if (!active) return;
    if (Date.now() - lastSync > (document.hidden ? 15000 : 5000)) void sync();
    if (paused) { prompt.show(paused); return; }
    if (!deadline) return;
    mount();
    if (!host) return;
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    const warning = remaining <= warningSeconds;
    host._clock.classList.toggle("warning", warning);
    host._label.textContent = warning ? expiryAction === "close" ? "标签页即将关闭" : "即将暂停" : "本次剩余";
    host._value.textContent = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
    host._clock.title = warning ?
      expiryAction === "close" ? "本次浏览即将结束，到期关闭相关标签页" : "本次浏览即将结束，保留页面并暂停" :
      `这次是为了：${reason}`;
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
  document.addEventListener("fullscreenchange", fullscreenLayer);
  chrome.runtime.onMessage.addListener(message => {
    if (message.type === "visitReleased") {
      syncVersion++;
      applyState(null);
    }
    if (message.type === "visitPaused") void sync().then(tick);
  });
  void sync().then(tick);
  timer = setInterval(tick, 500);
})();
