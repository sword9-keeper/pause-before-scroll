import { readableTime } from "./insights.js";

const $ = selector => document.querySelector(selector);
let initialization = 0;
async function request(type, extra = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...extra });
  if (!result?.ok) throw new Error(result?.error || "插件暂不可用，请刷新重试。");
  return result.data;
}

function errorMessage(error) {
  $("#error").textContent = error.message;
}

async function initialize() {
  const generation = ++initialization;
  const pageUrl = location.href;
  $("#choose").disabled = true;
  $("#leave").disabled = true;
  $("#continue").disabled = true;
  const data = await request("inspect", { pageUrl }).catch(error => {
    if (generation === initialization && pageUrl === location.href) errorMessage(error);
    return null;
  });
  if (!data || generation !== initialization || pageUrl !== location.href) return;
  if (data.reload) { location.reload(); return; }
  const { site, settings, today, recentReturn } = data;
  $("#error").textContent = "";
  $("#visit-form").reset();
  $("#visit-form").hidden = true;
  $("#choose").setAttribute("aria-expanded", "false");
  $("#custom-wrap").hidden = true;
  $("#custom-reason").hidden = true;
  $("#custom-reason-label").hidden = true;
  $("#custom-reason").required = false;
  $("#reason").replaceChildren();
  $("#destination").textContent = `即将前往 · ${site.name}`;
  $("#quote").textContent = settings.quote;
  $(".attribution").hidden = settings.quote !== "什么都无法舍弃的人，什么都无法做到。";
  $("#visit-context").textContent = today.observedRecords ?
    `今天在这里：前台 ${readableTime(today.foregroundMs)} · 开始 ${today.entries} 次` :
    today.entries ? `今天已开始浏览 ${today.entries} 次` : "这次打开，是为了什么？";
  $("#return-context").hidden = !recentReturn;
  for (const reason of settings.reasons) $("#reason").add(new Option(reason, reason));
  $("#reason").add(new Option("自己写一句", "__custom__"));
  $("#reason").selectedIndex = -1;
  const placeholder = new Option("选择这次的用途", "", true, true);
  placeholder.disabled = true;
  $("#reason").prepend(placeholder);
  $("#reason").required = true;
  $("#leave").disabled = false;
  $("#choose").disabled = false;
  $("#continue").disabled = false;
}

$("#choose").addEventListener("click", () => {
  const opening = $("#visit-form").hidden;
  $("#visit-form").hidden = !opening;
  $("#choose").setAttribute("aria-expanded", String(opening));
  if (opening) $("#reason").focus();
});
$("#leave").addEventListener("click", async () => {
  $("#leave").disabled = true;
  try { await request("leave"); }
  catch (error) { errorMessage(error); $("#leave").disabled = false; }
});
document.querySelectorAll('[name="duration"]').forEach(input => input.addEventListener("change", () => {
  $("#custom-wrap").hidden = input.value !== "custom";
}));
$("#reason").addEventListener("change", () => {
  const custom = $("#reason").value === "__custom__";
  $("#custom-reason").hidden = !custom;
  $("#custom-reason-label").hidden = !custom;
  $("#custom-reason").required = custom;
  if (custom) $("#custom-reason").focus();
});
$("#visit-form").addEventListener("submit", async event => {
  event.preventDefault();
  $("#error").textContent = "";
  $("#continue").disabled = true;
  const duration = $('[name="duration"]:checked').value;
  try {
    await request("continue", {
      minutes: duration === "custom" ? $("#custom-minutes").value : duration,
      reason: $("#reason").value === "__custom__" ? $("#custom-reason").value : $("#reason").value
    });
  } catch (error) {
    errorMessage(error);
    $("#continue").disabled = false;
  }
});
// Chrome may reuse this document when redirecting a second site into the gate.
// Recheck even on first initialization, since this event can precede script loading.
window.addEventListener("hashchange", () => {
  void initialize().catch(errorMessage);
});
initialize().catch(errorMessage);
