import { dayKey } from "./insights.js";

export const REVIEW_LIMIT = 2000;
export const REVIEW_OPTIONS = {
  fit: { yes: "符合自己的打算", partly: "有些偏离", no: "大多偏离", unsure: "想不起来" },
  protection: { yes: "全天使用", partly: "部分时间使用", no: "没有使用", unsure: "不确定" },
  displacement: { no: "没有", yes: "有", unsure: "不确定" },
  interference: { none: "没有妨碍", some: "有些妨碍", serious: "明显妨碍", unused: "没有使用", unsure: "不确定" }
};

export function emptyReviews() {
  return { schemaVersion: 1, revision: 0, enabled: false, definition: "", consentedAt: null, reports: [] };
}

export function offsetDay(day, offset) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function validDay(day) {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const date = new Date(`${day}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
}

function timestamp(value) { return Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000; }
function definitionText(value, required = true) {
  if (typeof value !== "string" || value.trim().length > 200 || /[\x00-\x1f]/.test(value) ||
      required && !value.trim()) throw new Error("请写下你认为的非计划浏览，最多 200 个字符。");
  return value.trim();
}

function answers(value) {
  if (!(value.unwantedMinutes === null || Number.isInteger(value.unwantedMinutes) &&
      value.unwantedMinutes >= 0 && value.unwantedMinutes <= 1440)) {
    throw new Error("自估分钟请留空，或填写 0 到 1440 的整数。");
  }
  const result = { unwantedMinutes: value.unwantedMinutes };
  for (const [key, choices] of Object.entries(REVIEW_OPTIONS)) {
    if (typeof value[key] !== "string" || !Object.hasOwn(choices, value[key])) throw new Error("请确认每日自评的选项。");
    result[key] = value[key];
  }
  return result;
}

export function validateReviews(input) {
  const value = input ?? emptyReviews();
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      typeof value.enabled !== "boolean" || !Array.isArray(value.reports) || value.reports.length > REVIEW_LIMIT ||
      !(value.consentedAt === null || timestamp(value.consentedAt)) ||
      (value.enabled || value.reports.length > 0) && value.consentedAt === null) {
    throw new Error("本机自评格式不兼容；原数据保留，网站功能不受影响。");
  }
  const definition = definitionText(value.definition, value.enabled);
  const dates = new Set();
  const reports = value.reports.map(report => {
    if (!report || !validDay(report.day) || dates.has(report.day) ||
        !timestamp(report.createdAt) || !timestamp(report.updatedAt) || report.updatedAt < report.createdAt ||
        !validDay(report.submittedDay) || !validDay(report.updatedDay) ||
        !Number.isInteger(report.utcOffsetMinutes) || Math.abs(report.utcOffsetMinutes) > 840) {
      throw new Error("本机自评日期或提交信息无效；原数据未被覆盖。");
    }
    dates.add(report.day);
    return {
      day: report.day, definition: definitionText(report.definition), ...answers(report),
      createdAt: report.createdAt, updatedAt: report.updatedAt,
      submittedDay: report.submittedDay, updatedDay: report.updatedDay, utcOffsetMinutes: report.utcOffsetMinutes
    };
  }).sort((a, b) => a.day.localeCompare(b.day));
  return { schemaVersion: 1, revision: value.revision, enabled: value.enabled, definition, consentedAt: value.consentedAt, reports };
}

export function updateReviews(input, action, now = Date.now()) {
  const state = validateReviews(input);
  if (action.revision !== state.revision) throw new Error("自评已在另一页面更新，请重新载入后再保存。");
  if (!timestamp(now) || state.revision === Number.MAX_SAFE_INTEGER) throw new Error("无法保存自评版本。");
  const next = { ...state, revision: state.revision + 1 };
  const today = dayKey(now);
  if (action.type === "reviewConfigure") {
    if (typeof action.enabled !== "boolean" || action.enabled && action.consent !== true) {
      throw new Error("开启自评需要明确同意。");
    }
    next.definition = definitionText(action.definition, action.enabled);
    next.enabled = action.enabled;
    if (next.enabled) next.consentedAt ??= now;
  } else if (action.type === "reviewSave") {
    if (!state.enabled) throw new Error("本机自评尚未开启，未保存任何新回答。");
    const report = action.report;
    const previous = state.reports.find(item => item.day === report?.day);
    if (!validDay(report?.day) || report.day > today || !previous && report.day < offsetDay(today, -1)) {
      throw new Error("新自评只填写今天或昨天；已有自评仍可修改。");
    }
    if (!previous && state.reports.length >= REVIEW_LIMIT) {
      throw new Error("已达到 2000 天自评上限，请先导出并整理，不会自动删除。");
    }
    const saved = {
      day: report.day, definition: previous?.definition || state.definition, ...answers(report),
      createdAt: previous?.createdAt ?? now, updatedAt: Math.max(now, previous?.updatedAt ?? 0),
      submittedDay: previous?.submittedDay ?? today, updatedDay: today,
      utcOffsetMinutes: previous?.utcOffsetMinutes ?? -new Date(now).getTimezoneOffset()
    };
    next.reports = [...state.reports.filter(item => item.day !== saved.day), saved];
  } else if (action.type === "reviewRemove") {
    if (!validDay(action.day)) throw new Error("请选择有效的自评日期。");
    next.reports = state.reports.filter(item => item.day !== action.day);
  } else if (action.type === "reviewErase") {
    if (action.confirmed !== true) throw new Error("删除自评需要确认。");
    return { ...emptyReviews(), revision: next.revision };
  } else throw new Error("未知的自评操作。");
  return validateReviews(next);
}

export function reviewView(input, now = Date.now()) {
  return { state: validateReviews(input), today: dayKey(now), earliestNewDay: offsetDay(dayKey(now), -1) };
}

export function summarizeReviews(input, today = dayKey(Date.now())) {
  const state = validateReviews(input);
  if (!validDay(today)) throw new Error("无效的统计日期。");
  const previousStart = offsetDay(today, -14);
  const recentStart = offsetDay(today, -7);
  function period(start, end) {
    const reports = state.reports.filter(report => report.day >= start && report.day <= end);
    const numeric = reports.filter(report => report.unwantedMinutes !== null);
    const definitions = [...new Set(reports.map(report => report.definition))];
    const counts = {};
    for (const [key, options] of Object.entries(REVIEW_OPTIONS)) {
      counts[key] = Object.fromEntries(Object.keys(options).map(option =>
        [option, reports.filter(report => report[key] === option).length]));
    }
    return {
      start, end, reportedDays: reports.length, missingDays: 7 - reports.length,
      numericDays: numeric.length, definitions, counts,
      meanMinutes: numeric.length && definitions.length === 1 ?
        numeric.reduce((sum, report) => sum + report.unwantedMinutes, 0) / numeric.length : null,
      laterEditedDays: reports.filter(report => report.updatedDay > offsetDay(report.day, 1)).length
    };
  }
  const previous = period(previousStart, offsetDay(recentStart, -1));
  const recent = period(recentStart, offsetDay(today, -1));
  const definitions = new Set([...previous.definitions, ...recent.definitions]);
  const status = definitions.size > 1 ? "different-definitions" :
    previous.numericDays < 5 || recent.numericDays < 5 ? "insufficient" : "descriptive-only";
  return { previous, recent, status };
}

export function exportReviews(input, now = Date.now()) {
  const state = validateReviews(input);
  return {
    app: "back-to-flow", kind: "daily-self-review", schemaVersion: 1, exportedAt: now, exportedDay: dayKey(now),
    measurement: "self-reported, not measured browsing time",
    scope: "this browser profile; no automatic WebDAV sync",
    dateBasis: "participant local calendar day; today excluded from summaries",
    enabled: state.enabled, definition: state.definition, consentedAt: state.consentedAt,
    reports: state.reports, summary: summarizeReviews(state, dayKey(now))
  };
}
