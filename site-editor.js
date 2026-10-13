import { validateSettings } from "./core.js";
import { SITES, configuredSites, normalizeDomain, siteOrigin, matchesHost } from "./rules.js";

const $ = selector => document.querySelector(selector);
function node(tag, text, className) {
  const result = document.createElement(tag);
  if (text) result.textContent = text;
  if (className) result.className = className;
  return result;
}

export class SiteEditor {
  constructor(request, onSaved) {
    this.request = request;
    this.onSaved = onSaved;
    this.dirty = false;
    $("#site-rules-form").addEventListener("input", () => { this.dirty = true; });
    $("#site-rules-form").addEventListener("submit", event => {
      event.preventDefault();
      void this.save();
    });
    $("#site-add").addEventListener("click", () => this.edit(() => this.addSite()));
    $("#exception-add").addEventListener("click", () => this.edit(() => this.addException()));
    for (const [field, button] of [["#site-domain", "#site-add"], ["#exception-url", "#exception-add"]]) {
      $(field).addEventListener("keydown", event => {
        if (event.key === "Enter") { event.preventDefault(); $(button).click(); }
      });
    }
    $("#setup-skip").addEventListener("click", () => void this.save(true));
    for (const event of [chrome.permissions.onAdded, chrome.permissions.onRemoved]) {
      event.addListener(() => {
        void this.request("siteStatus").then(status => this.showAccess(status)).catch(error => this.error(error));
      });
    }
  }

  error(error) { $("#status").textContent = error.message; }
  edit(work) {
    try { work(); this.dirty = true; $("#status").textContent = "尚未保存"; }
    catch (error) { this.error(error); }
  }

  fill(settings, status) {
    this.settings = settings;
    if (this.dirty) {
      $("#status").textContent = "网站配置已有更新；当前未保存的编辑仍保留。";
      if (status) this.showAccess(status);
      return;
    }
    this.customSites = structuredClone(settings.customSites);
    this.exceptions = structuredClone(settings.exceptions);
    this.renderSites(settings.enabledSites);
    this.renderExceptions();
    for (const input of document.querySelectorAll('[name="sites-expiry-action"]')) input.checked = input.value === settings.expiryAction;
    if (status) this.showAccess(status);
  }

  read(validate = true) {
    const customSites = [];
    const enabledSites = [];
    for (const row of document.querySelectorAll("#site-rules .rule-row")) {
      const enabled = row.querySelector('[data-field="enabled"]').checked;
      const builtin = SITES.find(site => site.id === row.dataset.siteId);
      if (builtin) {
        if (enabled) enabledSites.push(builtin.id);
      } else {
        customSites.push({
          domain: row.dataset.domain, enabled, name: row.querySelector('[data-field="name"]').value,
          includeSubdomains: row.querySelector('[data-field="subdomains"]').checked
        });
      }
    }
    const value = {
      ...this.settings, enabledSites, customSites, exceptions: this.exceptions,
      expiryAction: document.querySelector('[name="sites-expiry-action"]:checked')?.value || this.settings.expiryAction
    };
    return validate ? validateSettings(value) : value;
  }

  renderSites(enabledSites) {
    const rows = document.createDocumentFragment();
    for (const site of configuredSites({ enabledSites, customSites: this.customSites })) {
      const row = node("div", "", "rule-row");
      row.dataset.siteId = site.id;
      row.dataset.domain = site.domain;
      const heading = node("div", "", "rule-heading");
      const label = node("label", "", "check-label");
      const enabled = node("input");
      enabled.type = "checkbox";
      enabled.checked = site.enabled;
      enabled.dataset.field = "enabled";
      enabled.setAttribute("aria-label", `启用 ${site.domain}`);
      if (!site.id.startsWith("custom:")) {
        enabled.name = "enabled-site";
        enabled.value = site.id;
      }
      label.append(enabled, node("span", site.name));
      heading.append(label);
      row.append(heading, node("span", site.domain, "rule-domain"));
      if (site.id.startsWith("custom:")) {
        const name = node("input");
        name.dataset.field = "name";
        name.value = site.name;
        name.maxLength = 60;
        name.setAttribute("aria-label", `${site.domain} 名称`);
        const scopeLabel = node("label", "", "check-label");
        const subdomains = node("input");
        subdomains.type = "checkbox";
        subdomains.dataset.field = "subdomains";
        subdomains.checked = site.includeSubdomains;
        scopeLabel.append(subdomains, document.createTextNode("含子域名"));
        row.append(name, scopeLabel);
      } else row.append(node("span", "含子域名", "rule-scope"));
      const status = node("span", "", "rule-permission");
      const actions = node("div", "", "rule-row-actions");
      const grant = node("button", "授权", "text-button");
      grant.type = "button";
      grant.dataset.action = "grant";
      grant.addEventListener("click", async () => {
        try {
          if (!await chrome.permissions.request({ origins: [siteOrigin(site)] })) throw new Error("未获得网站访问授权。");
          await this.request("refreshSites");
          this.showAccess(await this.request("siteStatus"));
        } catch (error) { this.error(error); }
      });
      const revoke = node("button", "移除本机授权", "text-button");
      revoke.type = "button";
      revoke.dataset.action = "revoke";
      revoke.addEventListener("click", async () => {
        if (!confirm(`移除本机对 ${site.domain} 的访问授权？其他设备不受影响。`)) return;
        try { this.showAccess(await this.request("revokeSite", { siteId: site.id })); }
        catch (error) { this.error(error); }
      });
      actions.append(grant, revoke);
      if (site.id.startsWith("custom:")) {
        const remove = node("button", "删除", "text-button danger");
        remove.type = "button";
        remove.addEventListener("click", () => this.edit(() => {
          const existing = this.read(false);
          const removed = this.exceptions.filter(rule => matchesHost(new URL(rule.url).hostname, site));
          if (removed.length && !confirm(`删除此网站及其 ${removed.length} 条例外？历史记录保留。`)) return;
          this.customSites = existing.customSites.filter(item => item.domain !== site.domain);
          this.customSites = validateSettings({ ...existing, customSites: this.customSites,
            exceptions: this.exceptions.filter(rule => !removed.includes(rule)) }).customSites;
          this.exceptions = this.exceptions.filter(rule => !removed.includes(rule));
          this.renderSites(existing.enabledSites);
          this.renderExceptions();
          this.showAccess(this.status);
        }));
        actions.append(remove);
      }
      row.append(status, actions);
      rows.append(row);
    }
    $("#site-rules").replaceChildren(rows);
  }

  renderExceptions() {
    const rows = document.createDocumentFragment();
    for (const [index, rule] of this.exceptions.entries()) {
      const row = node("div", "", "exception-row");
      const info = node("div");
      info.append(node("span", rule.mode === "page" ? "精确页面" : "路径及子路径", "range-label"), node("p", rule.url));
      const remove = node("button", "删除", "text-button danger");
      remove.type = "button";
      remove.setAttribute("aria-label", `删除例外 ${rule.url}`);
      remove.addEventListener("click", () => this.edit(() => {
        this.exceptions.splice(index, 1);
        this.renderExceptions();
      }));
      row.append(info, remove);
      rows.append(row);
    }
    $("#site-exceptions").replaceChildren(rows);
  }

  addSite() {
    const current = this.read();
    const domain = normalizeDomain($("#site-domain").value);
    const next = validateSettings({
      ...current, customSites: [...current.customSites, { domain, name: domain, enabled: true, includeSubdomains: true }]
    });
    this.customSites = next.customSites;
    this.renderSites(next.enabledSites);
    this.showAccess(this.status);
    $("#site-domain").value = "";
  }

  addException() {
    const current = this.read();
    this.exceptions = validateSettings({
      ...current, exceptions: [...this.exceptions, { mode: $("#exception-mode").value, url: $("#exception-url").value }]
    }).exceptions;
    this.renderExceptions();
    $("#exception-url").value = "";
  }

  showAccess(status) {
    if (!status) return;
    this.status = status;
    const pending = status.sites.filter(site => site.enabled && !site.granted).length;
    const active = status.sites.filter(site => site.enabled && site.granted).length;
    $("#sites-heading").textContent = status.setupComplete ? "网站与例外" : "选择你想停一下的网站";
    $("#site-save").textContent = status.setupComplete ? "保存网站" : "保存并开始";
    $("#setup-skip").hidden = status.setupComplete;
    $("#site-access-state").textContent = status.error || `已启用 ${active} 个${pending ? ` · 本机待授权 ${pending} 个` : ""}`;
    for (const row of document.querySelectorAll("#site-rules .rule-row")) {
      const site = status.sites.find(item => item.id === row.dataset.siteId);
      row.querySelector(".rule-permission").textContent = !site ? "尚未保存" :
        !site.enabled ? "未启用" : status.error ? "未生效" : site.granted ? "已授权" : "本机待授权";
      row.querySelector('[data-action="grant"]').hidden = !site?.enabled || site.granted;
      row.querySelector('[data-action="revoke"]').hidden = !site?.granted;
    }
    const trial = status.sites.find(site => site.enabled && site.granted);
    $("#site-trial").hidden = !trial || Boolean(status.error);
    if (trial) {
      $("#site-trial").href = `https://${trial.domain}/`;
      $("#site-trial").textContent = `打开 ${trial.name}`;
    }
  }

  async save(skip = false) {
    $("#site-save").disabled = true;
    try {
      if (!skip) {
        if ($("#site-domain").value.trim()) this.addSite();
        if ($("#exception-url").value.trim()) this.addException();
      }
      const rules = skip ? { ...this.read(), enabledSites: [], customSites: this.read().customSites.map(site => ({ ...site, enabled: false })) } : this.read();
      const origins = configuredSites(rules).filter(site => site.enabled).map(siteOrigin);
      if (origins.length && !await chrome.permissions.request({ origins })) {
        throw new Error("未获得网站访问授权，配置未保存；你的编辑仍保留。");
      }
      const result = await this.request("siteSettings", { rules });
      this.dirty = false;
      this.fill(result.settings, result.siteStatus);
      this.onSaved(result.settings);
      $("#status").textContent = result.siteStatus.error || "网站配置已保存";
    } catch (error) { this.error(error); }
    finally { $("#site-save").disabled = false; }
  }
}
