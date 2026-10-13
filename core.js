export const SITES = [
  { id: "douyin", name: "抖音", domain: "douyin.com" },
  { id: "xiaohongshu", name: "小红书", domain: "xiaohongshu.com" },
  { id: "bilibili", name: "哔哩哔哩", domain: "bilibili.com" }
];

export const DEFAULT_SETTINGS = {
  exitUrl: "https://www.google.com/",
  quote: "什么都无法舍弃的人，什么都无法做到。",
  reasons: ["查找资料", "看指定内容", "休息一下"],
  warningSeconds: 60,
  enabledSites: SITES.map(site => site.id)
};

export function siteFor(raw, enabledSites = DEFAULT_SETTINGS.enabledSites) {
  try {
    const url = new URL(raw);
    if (!["https:", "http:"].includes(url.protocol)) return null;
    return SITES.find(site => enabledSites.includes(site.id) && (url.hostname === site.domain ||
      url.hostname.endsWith(`.${site.domain}`))) || null;
  } catch {
    return null;
  }
}

export function targetUrl(raw) {
  const url = new URL(raw);
  if (!siteFor(raw) || url.username || url.password) throw new Error("不是有效的受限网站地址。");
  return url.href;
}

export function validateSettings(input) {
  const enabledSites = input.enabledSites ?? DEFAULT_SETTINGS.enabledSites;
  if (!Array.isArray(enabledSites) || enabledSites.some(id => !SITES.some(site => site.id === id))) {
    throw new Error("网站规则无效。");
  }
  const url = new URL(input.exitUrl);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || siteFor(url.href)) {
    throw new Error("离开网址必须是非受限网站的 HTTP 或 HTTPS 地址。");
  }
  const quote = String(input.quote || "").trim();
  const reasons = [...new Set((input.reasons || []).map(value => String(value).trim()).filter(Boolean))];
  if (!quote || quote.length > 300) throw new Error("台词请填写 1 至 300 个字符。");
  if (reasons.length > 20 || reasons.some(reason => reason.length > 100)) {
    throw new Error("用途最多 20 项，每项最多 100 个字符。");
  }
  const warningSeconds = Number(input.warningSeconds);
  if (!Number.isInteger(warningSeconds) || warningSeconds < 1 || warningSeconds > 300) {
    throw new Error("提前提醒时间应为 1 至 300 秒。");
  }
  return { exitUrl: url.href, quote, reasons, warningSeconds, enabledSites: SITES.map(site => site.id).filter(id => enabledSites.includes(id)) };
}

export function validateGrant(minutes, reason) {
  const duration = Number(minutes);
  const purpose = String(reason || "").trim();
  if (!Number.isFinite(duration) || duration < 0.1 || duration > 1440) {
    throw new Error("时长应为 0.1 至 1440 分钟。");
  }
  if (!purpose || purpose.length > 200) throw new Error("请填写用途，最多 200 个字符。");
  return { duration, purpose };
}

export function pauseTarget(raw, pausePage) {
  if (typeof raw !== "string" || !raw.startsWith(`${pausePage}#`)) return null;
  try {
    return targetUrl(raw.slice(pausePage.length + 1));
  } catch {
    return null;
  }
}

export function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
