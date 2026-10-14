import { REVIEW_OPTIONS, summarizeReviews } from "./reviews.js";

const $ = selector => document.querySelector(selector);
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export class ReviewEditor {
  constructor(request) {
    this.request = request;
    this.busy = false;
    this.configDirty = false;
    this.entryDirty = false;
    for (const [key, options] of Object.entries(REVIEW_OPTIONS)) {
      const select = $(`#review-${key}`);
      select.append(...Object.entries(options).map(([value, label]) => new Option(label, value)));
    }
    $("#self-review").addEventListener("toggle", () => {
      if ($("#self-review").open) void this.refresh();
    });
    window.addEventListener("focus", () => {
      if ($("#self-review").open) void this.refresh();
    });
    $("#review-config").addEventListener("input", () => { this.configDirty = true; });
    $("#review-form").addEventListener("input", event => {
      if (event.target.id !== "review-day") this.entryDirty = true;
    });
    $("#review-config").addEventListener("submit", event => {
      event.preventDefault();
      if (this.entryDirty && !confirm("保存自评设置会放弃当前尚未保存的回答，继续？")) return;
      void this.commit("reviewConfigure", {
        enabled: $("#review-enabled").checked, consent: $("#review-enabled").checked,
        definition: $("#review-definition").value
      }, "本机自评设置已保存");
    });
    $("#review-form").addEventListener("submit", event => {
      event.preventDefault();
      if (this.configDirty) { this.status("请先保存自评设置，或重新载入。"); return; }
      const value = $("#review-minutes").value;
      void this.commit("reviewSave", { report: {
        day: $("#review-day").value, unwantedMinutes: value === "" ? null : Number(value),
        ...Object.fromEntries(Object.keys(REVIEW_OPTIONS).map(key => [key, $(`#review-${key}`).value]))
      } }, "自评已保存在本机");
    });
    $("#review-day").addEventListener("change", () => {
      const selected = $("#review-day").value;
      if (this.entryDirty && !confirm("切换日期会放弃尚未保存的回答，继续？")) {
        $("#review-day").value = this.selectedDay;
        return;
      }
      this.fillEntry(selected);
    });
    $("#review-reload").addEventListener("click", () => {
      if ((this.configDirty || this.entryDirty) && !confirm("重新载入并放弃尚未保存的自评编辑？")) return;
      void this.refresh(true);
    });
    $("#review-remove").addEventListener("click", () => {
      if (!confirm("删除这一天的本机自评？浏览记录和导出的文件不会删除。")) return;
      void this.commit("reviewRemove", { day: this.selectedDay }, "当日自评已删除");
    });
    $("#review-erase").addEventListener("click", () => {
      if (!confirm("关闭自评并删除本机全部自评及定义？这不会删除浏览记录、其他设备数据或已经导出的文件。")) return;
      void this.commit("reviewErase", { confirmed: true }, "本机自评已关闭并删除");
    });
    $("#review-export").addEventListener("click", () => void this.export());
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.selfReview && this.state && !this.busy) void this.refresh();
    });
  }

  status(text) { $("#review-status").textContent = text; }
  setBusy(value) {
    this.busy = value;
    $("#review-config-fields").disabled = value || !this.state;
    $("#review-entry-fields").disabled = value || !this.state?.enabled;
    for (const id of ["review-reload", "review-erase", "review-export", "review-remove"]) {
      $(`#${id}`).disabled = value || !this.state;
    }
    $("#review-reload").disabled = value;
    if (!value && this.state) {
      $("#review-export").disabled = !this.state.reports.length;
      $("#review-erase").disabled = !this.state.reports.length && !this.state.definition && !this.state.enabled;
      $("#review-remove").disabled = !this.state.reports.some(report => report.day === this.selectedDay);
    }
  }

  async refresh(force = false) {
    if (this.busy) return;
    this.setBusy(true);
    try {
      const view = await this.request("reviewGet");
      if (!force && (this.configDirty || this.entryDirty)) {
        if (view.state.revision !== this.state?.revision) {
          this.status("自评已在另一页面更新；当前编辑保留，请重新载入后再保存。");
        } else if (view.today !== this.today) this.status("日期已变化，当前编辑保留；保存前请确认日期。");
      } else { this.fill(view); this.status(""); }
    } catch (error) { this.status(error.message); }
    finally { this.setBusy(false); }
  }

  async commit(type, extra, message) {
    if (this.busy || !this.state) return;
    this.setBusy(true);
    try {
      this.fill(await this.request(type, { revision: this.state.revision, ...extra }));
      this.status(message);
    } catch (error) { this.status(error.message); }
    finally { this.setBusy(false); }
  }

  fill(view) {
    const nextDay = this.today && this.today !== view.today && this.selectedDay === this.today;
    this.state = view.state;
    this.today = view.today;
    this.configDirty = false;
    this.entryDirty = false;
    $("#review-enabled").checked = this.state.enabled;
    $("#review-definition").value = this.state.definition;
    $("#review-availability").textContent = this.state.enabled ? "已开启 · 仅本机 · 不同步" : "未开启 · 不自动收集";
    $("#review-form").hidden = !this.state.enabled;
    $("#review-day").max = view.today;
    $("#review-day").min = this.state.reports[0]?.day < view.earliestNewDay ?
      this.state.reports[0].day : view.earliestNewDay;
    this.fillEntry(!nextDay && this.selectedDay && this.selectedDay <= view.today ? this.selectedDay : view.today);
    this.renderSummary();
    const rows = document.createDocumentFragment();
    for (const report of this.state.reports.slice(-14).reverse()) {
      const row = element("div", "", "review-row");
      const button = element("button", report.day, "text-button");
      button.type = "button";
      button.setAttribute("aria-label", `查看 ${report.day} 自评`);
      button.addEventListener("click", () => {
        if (this.entryDirty && !confirm("切换日期会放弃尚未保存的回答，继续？")) return;
        this.fillEntry(report.day);
        $("#review-day").focus();
      });
      row.append(button, element("span", REVIEW_OPTIONS.fit[report.fit]),
        element("span", report.unwantedMinutes === null ? "分钟未填" : `自估 ${report.unwantedMinutes} 分钟`));
      rows.append(row);
    }
    $("#review-history").replaceChildren(rows);
    $("#review-history-heading").hidden = !this.state.reports.length;
    this.setBusy(this.busy);
  }

  fillEntry(day) {
    this.selectedDay = day;
    this.entryDirty = false;
    const report = this.state.reports.find(item => item.day === day);
    $("#review-form").hidden = !this.state.enabled && !report;
    $("#review-day").value = day;
    $("#review-minutes").value = report?.unwantedMinutes ?? "";
    $("#review-criterion").textContent = report?.definition || this.state.definition;
    for (const key of Object.keys(REVIEW_OPTIONS)) $(`#review-${key}`).value = report?.[key] || (key === "fit" ? "" : "unsure");
    $("#review-save").textContent = report ? "更新当日自评" : "保存当日自评";
    $("#review-remove").disabled = !report || this.busy;
  }

  renderSummary() {
    const summary = summarizeReviews(this.state, this.today);
    const periods = document.createDocumentFragment();
    for (const [key, label] of [["previous", "前 7 天"], ["recent", "近 7 天"]]) {
      const data = summary[key];
      const section = element("div", "", "review-period");
      section.append(element("h3", `${label} · ${data.start} 至 ${data.end}`));
      const stats = element("dl");
      function count(key, positive, excluded = ["unsure"]) {
        const known = data.reportedDays - excluded.reduce((sum, option) => sum + data.counts[key][option], 0);
        return known ? `${data.counts[key][positive]} / ${known} 天` : "无明确回答";
      }
      for (const [title, value, detail] of [
        ["自估日均", data.meanMinutes === null ? "未计算" : `${Math.round(data.meanMinutes * 10) / 10} 分钟`],
        ["分钟已填", `${data.numericDays} / 7 天`],
        ["自评未填", `${data.missingDays} / 7 天`],
        ["符合自己打算", count("fit", "yes"), `不确定 ${data.counts.fit.unsure} 天`],
        ["转到别处刷", count("displacement", "yes"), `不确定 ${data.counts.displacement.unsure} 天`],
        ["明显妨碍正事", count("interference", "serious", ["unsure", "unused"]),
          `不确定 ${data.counts.interference.unsure} 天 · 未使用 ${data.counts.interference.unused} 天`]
      ]) {
        const pair = element("div");
        const amount = element("dd", value);
        if (detail) amount.append(element("small", detail, "review-unknown"));
        pair.append(element("dt", title), amount);
        stats.append(pair);
      }
      section.append(stats);
      periods.append(section);
    }
    $("#review-periods").replaceChildren(periods);
    $("#review-comparison").textContent = summary.status === "different-definitions" ? "自评口径不同，不作比较" :
      summary.status === "insufficient" ? "两期各需至少 5 天分钟自评；目前样本不足" : "个人自报，不作因果判断";
  }

  async export() {
    if (this.busy || !this.state?.reports.length) return;
    if (!confirm("导出本机自评和个人定义？文件可能包含隐私，仅在你选择分享时离开本机。")) return;
    this.setBusy(true);
    try {
      const data = await this.request("reviewExport");
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const link = element("a");
      link.href = url;
      link.download = `pause-self-review-${this.today}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.status("已导出保存的自评；未保存的编辑不在文件中");
    } catch (error) { this.status(error.message); }
    finally { this.setBusy(false); }
  }
}
