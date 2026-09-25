import { formatDuration } from "./core.js";

const $ = selector => document.querySelector(selector);
$("#version").textContent = `v${chrome.runtime.getManifest().version}`;
let records = [];
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

for (const name of ["records", "settings"]) {
  $(`#${name}-tab`).addEventListener("click", () => {
    for (const other of ["records", "settings"]) {
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
$("#settings-form").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    await request("settings", { settings: {
      exitUrl: $("#exit-url").value, quote: $("#quote-input").value,
      reasons: $("#reasons-input").value.split(/\r?\n/), warningSeconds: Number($("#warning-input").value)
    } });
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
  if (!confirm("清除所有已结束的记录？此操作无法撤销，进行中的记录会保留。")) return;
  try { records = (await request("clear")).records; render(); }
  catch (error) { showError(error); }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.records) {
    records = changes.records.newValue || [];
    render();
  }
});
setInterval(render, 1000);
request("journal").then(data => {
  records = data.records;
  $("#exit-url").value = data.settings.exitUrl;
  $("#quote-input").value = data.settings.quote;
  $("#reasons-input").value = data.settings.reasons.join("\n");
  $("#warning-input").value = data.settings.warningSeconds;
  render();
}).catch(showError);
