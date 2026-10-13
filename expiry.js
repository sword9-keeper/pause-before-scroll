(() => {
  if (globalThis.PauseExpiryPrompt) return;
  function element(tag, text, attributes = {}) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    return node;
  }

  globalThis.PauseExpiryPrompt = class {
    constructor({ resume, close }) {
      this.resume = resume;
      this.close = close;
      this.onPlay = event => {
        if (event.target instanceof HTMLMediaElement) event.target.pause();
      };
    }

    show(data) {
      this.data = data;
      if (this.host?.isConnected) return;
      if (!document.documentElement) return;
      this.host = element("div", "", { id: "pause-before-scroll-expiry" });
      const root = this.host.attachShadow({ mode: "open" });
      const style = element("style", `
        :host { all:initial; color-scheme:light; }
        * { box-sizing:border-box; letter-spacing:0; }
        dialog { width:460px; max-width:calc(100vw - 24px); max-height:calc(100dvh - 24px);
          overflow:auto; margin:auto; padding:28px; border:1px solid #b9cbbf; border-radius:8px;
          background:#fff; color:#203c2e; font:15px/1.6 system-ui,sans-serif; }
        dialog::backdrop { background:#18231bcc; }
        h1 { font-size:24px; line-height:1.4; font-weight:600; margin:0 0 16px; }
        h1,p,label,button { overflow-wrap:anywhere; }
        p { margin:0 0 20px; }
        .reason { color:#5b6961; }
        .actions { display:grid; gap:10px; }
        button { min-height:44px; border:1px solid #bccbc1; border-radius:5px; padding:9px 14px;
          color:#26513b; background:#fff; font:inherit; cursor:pointer; }
        button:hover { background:#edf4ef; }
        .primary { background:#276248; border-color:#276248; color:white; }
        .primary:hover { background:#1e513b; }
        .recovery { color:#426b91; border:0; margin-top:8px; }
        button:disabled { opacity:.6; cursor:wait; }
        button:focus-visible,input:focus-visible,select:focus-visible { outline:3px solid #477aa1; outline-offset:2px; }
        form { display:grid; gap:12px; }
        input,select { width:100%; min-height:44px; padding:8px 10px; border:1px solid #bbcbbf;
          border-radius:4px; background:white; color:#203c2e; font:inherit; }
        fieldset { display:flex; flex-wrap:wrap; gap:8px; margin:0; padding:0; border:0; }
        legend { margin-bottom:8px; }
        .duration { display:flex; align-items:center; gap:6px; font-size:14px; }
        .duration input { width:16px; min-height:16px; margin:0; accent-color:#276248; }
        .status { color:#9f332a; font-size:13px; margin:12px 0 0; min-height:0; }
        [hidden] { display:none!important; }
        @media(max-width:360px) { dialog { padding:20px; } h1 { font-size:22px; } }
      `);
      this.dialog = element("dialog", "", { "aria-labelledby": "expiry-title", "aria-describedby": "expiry-reason" });
      const title = element("h1", "约定的时间到了", { id: "expiry-title", tabindex: "-1" });
      const reason = element("p", data.reason ? `这次是为了：${data.reason}` : "这段浏览已经结束。", {
        id: "expiry-reason", class: "reason"
      });
      const actions = element("div", "", { class: "actions" });
      this.end = element("button", "结束并关闭", { type: "button", class: "primary" });
      const choose = element("button", "再安排一段时间", { type: "button" });
      const recover = element("button", "先保存内容 · 2 分钟", { type: "button", class: "recovery" });
      actions.append(this.end, choose, recover);
      const form = element("form", "", { hidden: "" });
      const purposeLabel = element("label", "这次要做什么", { for: "resume-reason" });
      const purpose = element("input", "", {
        id: "resume-reason", required: "", maxlength: "200", autocomplete: "off"
      });
      purpose.value = data.reason;
      const durations = element("fieldset");
      durations.append(element("legend", "计划时长"));
      for (const [value, label] of [["5", "5 分钟"], ["10", "10 分钟"], ["15", "15 分钟"], ["custom", "自定义"]]) {
        const option = element("label", "", { class: "duration" });
        const input = element("input", "", { type: "radio", name: "resume-duration", value, required: "" });
        option.append(input, document.createTextNode(label));
        durations.append(option);
      }
      const customLabel = element("label", "分钟", { for: "resume-minutes", hidden: "" });
      const custom = element("input", "", {
        id: "resume-minutes", type: "number", min: "0.1", max: "1440", step: "any", hidden: ""
      });
      durations.addEventListener("change", () => {
        const active = form.querySelector('[name="resume-duration"]:checked')?.value === "custom";
        custom.hidden = customLabel.hidden = !active;
        custom.required = active;
        if (active) custom.focus();
      });
      const submit = element("button", "开始这段时间", { type: "submit", class: "primary" });
      const back = element("button", "返回", { type: "button" });
      form.append(purposeLabel, purpose, durations, customLabel, custom, submit, back);
      this.status = element("p", "", { class: "status", role: "status" });
      this.dialog.append(title, reason, actions, form, this.status);
      root.append(style, this.dialog);
      document.documentElement.append(this.host);
      this.end.addEventListener("click", () => this.perform(() => this.close(this.data)));
      recover.addEventListener("click", () => this.perform(() => this.resume({ recordId: this.data.recordId, recovery: true })));
      choose.addEventListener("click", () => {
        actions.hidden = true;
        form.hidden = false;
        purpose.focus();
      });
      back.addEventListener("click", () => {
        form.hidden = true;
        actions.hidden = false;
        choose.focus();
      });
      form.addEventListener("submit", event => {
        event.preventDefault();
        const duration = form.querySelector('[name="resume-duration"]:checked')?.value;
        void this.perform(() => this.resume({
          recordId: this.data.recordId, minutes: duration === "custom" ? custom.value : duration,
          reason: purpose.value
        }));
      });
      this.dialog.addEventListener("cancel", event => {
        event.preventDefault();
        if (!form.hidden) back.click();
        else recover.focus();
      });
      document.addEventListener("play", this.onPlay, true);
      for (const media of document.querySelectorAll("video,audio")) media.pause();
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      this.dialog.showModal();
      title.focus();
    }

    async perform(action) {
      const buttons = this.host.shadowRoot.querySelectorAll("button");
      for (const button of buttons) button.disabled = true;
      this.status.textContent = "";
      try { await action(); }
      catch (error) { this.status.textContent = error.message || "操作失败，请重试。"; }
      finally { for (const button of buttons) button.disabled = false; }
    }

    hide() {
      document.removeEventListener("play", this.onPlay, true);
      this.dialog?.close();
      this.host?.remove();
      this.host = null;
    }
  };
})();
