import { readableTime } from "./insights.js";

const $ = selector => document.querySelector(selector);
async function request(type, extra = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...extra });
  if (!result?.ok) throw new Error(result?.error || "插件暂不可用，请刷新重试。");
  return result.data;
}

function errorMessage(error) {
  $("#error").textContent = error.message;
}

async function initialize() {
  const { site, settings, today, recentReturn } = await request("inspect");
  $("#destination").textContent = `即将前往 · ${site.name}`;
  $("#quote").textContent = settings.quote;
  $(".attribution").hidden = settings.quote !== "什么都无法舍弃的人，什么都无法做到。";
  $("#visit-context").textContent = today.observedRecords ?
    `今天在这里：前台 ${readableTime(today.foregroundMs)} · 进入 ${today.entries} 次` :
    today.entries ? `今天已进入 ${today.entries} 次` : "这次打开，是为了什么？";
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
initialize().catch(errorMessage);
