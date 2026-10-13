import { formatDuration } from "./core.js";
import { permissionOrigin, validateSyncConfig } from "./sync.js";

const $ = selector => document.querySelector(selector);
$("#version").textContent = `v${chrome.runtime.getManifest().version}`;
let records = [];
let settingsDirty = false;
let syncDirty = false;
let savedSync;
const outcomes = {
  pending: "尚未选择", active: "进行中", declined: "选择离开",
  dismissed: "关闭确认页 / 离开", expired: "时间到", closed: "主动关页",
  left: "离开网站", interrupted: "浏览器 / 插件中断", error: "放行失败",
  navigation_error: "确认页跳转失败"
};

async function request(type, extra = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...extra });
  if (!response?.ok) throw new Error(response?.error || "无法连接插件。");
  return response.data;
}

function localDate(time) {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function elapsed(record) {
  return record.outcome === "active" ?
    Math.max(0, Math.min(Date.now() - record.startedAt, record.plannedMs)) : record.elapsedMs;
}

function render() {
  const filtered = records.filter(record =>
    (!$("#date-filter").value || localDate(record.attemptedAt) === $("#date-filter").value) &&
    (!$("#site-filter").value || record.siteId === $("#site-filter").value));
  $("#attempt-count").textContent = filtered.length;
  $("#visit-count").textContent = filtered.filter(record => record.startedAt !== null).length;
  $("#decline-count").textContent = filtered.filter(record => record.outcome === "declined").length;
  $("#total-time").textContent = formatDuration(filtered.reduce((total, record) => total + (elapsed(record) || 0), 0));
  const rows = document.createDocumentFragment();
  for (const record of [...filtered].reverse()) {
    const row = document.createElement("tr");
    const cells = [
      new Date(record.attemptedAt).toLocaleString("zh-CN", { hour12: false }),
      record.siteName, record.reason || "—",
      record.plannedMs ? formatDuration(record.plannedMs) : "—",
      record.elapsedMs === null ? "未知" : record.startedAt ? formatDuration(elapsed(record)) : "—",
      outcomes[record.outcome] || record.outcome
    ];
    for (const text of cells) {
      const cell = document.createElement("td");
      cell.textContent = text;
      row.append(cell);
    }
    rows.append(row);
  }
  $("#record-rows").replaceChildren(rows);
  $("#empty").hidden = filtered.length !== 0;
  $("#record-count").textContent = `${filtered.length} 条记录`;
}

function showError(error) { $("#status").textContent = error.message; }

for (const name of ["records", "settings", "sync"]) {
  $(`#${name}-tab`).addEventListener("click", () => {
    for (const other of ["records", "settings", "sync"]) {
      $(`#${other}-panel`).hidden = other !== name;
      $(`#${other}-tab`).classList.toggle("active", other === name);
      $(`#${other}-tab`).setAttribute("aria-pressed", String(other === name));
    }
    $("#status").textContent = "";
  });
}
$("#date-filter").value = localDate(Date.now());
$("#date-filter").addEventListener("change", render);
$("#site-filter").addEventListener("change", render);
$("#all-dates").addEventListener("click", () => { $("#date-filter").value = ""; render(); });
$("#settings-form").addEventListener("input", () => { settingsDirty = true; });
$("#settings-form").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    await request("settings", { settings: {
      exitUrl: $("#exit-url").value, quote: $("#quote-input").value,
      reasons: $("#reasons-input").value.split(/\r?\n/), warningSeconds: Number($("#warning-input").value),
      enabledSites: [...document.querySelectorAll('[name="enabled-site"]:checked')].map(input => input.value)
    } });
    settingsDirty = false;
    $("#status").textContent = "已保存";
  } catch (error) { showError(error); }
});
$("#export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), records }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `pause-records-${localDate(Date.now())}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$("#clear").addEventListener("click", async () => {
  if (!confirm("清除所有已结束的记录？开启记录同步后，删除也会同步到其他设备。此操作无法撤销，进行中的记录会保留。")) return;
  try { records = (await request("clear")).records; render(); }
  catch (error) { showError(error); }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.records) {
    records = changes.records.newValue || [];
    render();
  }
  if (area === "local" && changes.settings) {
    if (!settingsDirty) fillSettings(changes.settings.newValue);
    else $("#status").textContent = "设置已有更新；当前未保存的编辑仍保留。";
  }
  if (area === "local" && (changes.syncMeta || changes.syncConfig)) {
    request("syncStatus").then(data => renderSync(data)).catch(showError);
  }
});
setInterval(render, 1000);

function fillSettings(settings) {
  $("#exit-url").value = settings.exitUrl;
  $("#quote-input").value = settings.quote;
  $("#reasons-input").value = settings.reasons.join("\n");
  $("#warning-input").value = settings.warningSeconds;
  for (const input of document.querySelectorAll('[name="enabled-site"]')) {
    input.checked = settings.enabledSites.includes(input.value);
  }
}

function renderSync(data, fill = false) {
  savedSync = data;
  const { config, status } = data;
  if (fill) {
    $("#sync-enabled").checked = config.enabled;
    $("#sync-url").value = config.url;
    $("#sync-username").value = config.username;
    $("#sync-password").value = "";
    $("#sync-records").checked = config.syncRecords;
    syncDirty = false;
  }
  $("#sync-password").placeholder = config.passwordSaved ? "已保存；留空保持不变" : "";
  $("#data-mode").textContent = config.enabled ? "WebDAV 同步已启用" : "仅保存在本地";
  $("#sync-state").textContent = status.busy ? "正在同步" : !config.enabled ? "未启用" :
    status.lastError ? "同步失败" : status.lastSuccessAt ? "已同步" : "等待首次同步";
  $("#sync-last-success").textContent = status.lastSuccessAt ? new Date(status.lastSuccessAt).toLocaleString("zh-CN", { hour12: false }) : "尚未同步";
  $("#sync-error").textContent = status.lastError || "";
  $("#sync-now").disabled = !config.enabled || status.busy || syncDirty;
  $("#sync-now").textContent = status.busy ? "正在同步…" : "立即同步";
  $("#sync-forget").disabled = !config.url;
  $("#restore-settings").hidden = !status.hasSettingsBackup;
}

$("#sync-form").addEventListener("input", () => {
  syncDirty = true;
  $("#sync-now").disabled = true;
});
$("#sync-form").addEventListener("submit", async event => {
  event.preventDefault();
  $("#sync-save").disabled = true;
  try {
    const input = {
      enabled: $("#sync-enabled").checked, url: $("#sync-url").value.trim(),
      username: $("#sync-username").value.trim(), password: $("#sync-password").value,
      syncRecords: $("#sync-records").checked
    };
    // Validate before the permission prompt without exposing the stored password to this page.
    const sameAccount = input.url === savedSync?.config.url && input.username === savedSync?.config.username;
    const config = validateSyncConfig({ ...input, password: input.password || (sameAccount && savedSync?.config.passwordSaved ? "saved" : "") });
    if (config.enabled && !await chrome.permissions.request({ origins: [permissionOrigin(config.url)] })) {
      throw new Error("未获得 WebDAV 站点访问权限，连接未保存。");
    }
    renderSync(await request("syncSave", { config: { ...input, url: config.url } }), true);
    $("#status").textContent = "连接已保存";
  } catch (error) { showError(error); }
  finally { $("#sync-save").disabled = false; }
});
$("#sync-now").addEventListener("click", async () => {
  $("#sync-now").disabled = true;
  $("#status").textContent = "";
  try {
    renderSync(await request("syncNow"));
    $("#status").textContent = "同步完成";
  } catch (error) {
    showError(error);
    await request("syncStatus").then(data => renderSync(data)).catch(showError);
  }
});
$("#sync-forget").addEventListener("click", async () => {
  if (!confirm("移除本机的 WebDAV 地址和密码？本地记录及服务器文件不会删除。")) return;
  try {
    renderSync(await request("syncForget"), true);
    $("#status").textContent = "本机连接已移除";
  } catch (error) { showError(error); }
});
$("#restore-settings").addEventListener("click", async () => {
  if (!confirm("恢复上次被远端设置替换前的本机设置？下一次同步会将恢复后的设置发往其他设备。")) return;
  try {
    fillSettings(await request("restoreSettings"));
    settingsDirty = false;
    $("#status").textContent = "已恢复设置";
  } catch (error) { showError(error); }
});
Promise.all([request("journal"), request("syncStatus")]).then(([data, sync]) => {
  records = data.records;
  fillSettings(data.settings);
  renderSync(sync, true);
  render();
}).catch(showError);
