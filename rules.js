import { parse } from "./vendor/tldts.js";

export const SITES = [
  { id: "douyin", name: "抖音", domain: "douyin.com" },
  { id: "xiaohongshu", name: "小红书", domain: "xiaohongshu.com" },
  { id: "bilibili", name: "哔哩哔哩", domain: "bilibili.com" }
];

export function normalizeDomain(input) {
  const raw = String(input || "").trim();
  let url;
  try { url = new URL(raw.includes("://") ? raw : `https://${raw}`); }
  catch { throw new Error("请输入有效域名，例如 youtube.com。"); }
  const domain = url.hostname.replace(/\.$/, "").toLowerCase();
  const parsed = parse(domain, { allowPrivateDomains: true });
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port ||
      url.pathname !== "/" || url.search || url.hash || !parsed.domain || parsed.isIp ||
      domain.length > 253 || !domain.split(".").every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))) {
    throw new Error("这里只填写完整域名，不包含路径、端口、通配符或公共后缀。");
  }
  return domain;
}

export function configuredSites(settings) {
  return [
    ...SITES.map(site => ({ ...site, includeSubdomains: true, enabled: settings.enabledSites.includes(site.id) })),
    ...(settings.customSites || [])
  ];
}

export function matchesHost(host, site) {
  return host === site.domain || site.includeSubdomains && host.endsWith(`.${site.domain}`);
}

export function siteOrigin(site) {
  return `*://${site.includeSubdomains ? "*." : ""}${site.domain}/*`;
}

export function configuredSite(raw, settings) {
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return configuredSites(settings).find(site => matchesHost(url.hostname, site)) || null;
  } catch { return null; }
}

export function isException(raw, exceptions = []) {
  let url;
  try { url = new URL(raw); } catch { return false; }
  if (/%2f|%5c/i.test(url.pathname)) return false;
  url.searchParams.sort();
  return exceptions.some(rule => {
    const allowed = new URL(rule.url);
    if (url.origin !== allowed.origin) return false;
    if (rule.mode === "page") return url.pathname === allowed.pathname &&
      url.search === allowed.search && url.hash === allowed.hash;
    const base = allowed.pathname.replace(/\/$/, "");
    return url.pathname === base || url.pathname.startsWith(`${base}/`);
  });
}

export function normalizeRules(input) {
  const custom = input.customSites ?? [];
  if (!Array.isArray(custom) || custom.length > 30) throw new Error("自定义网站最多 30 个。");
  const customSites = custom.map(value => {
    const domain = normalizeDomain(value?.domain);
    const name = String(value.name || domain).trim();
    if (!name || name.length > 60 || /[\x00-\x1f]/.test(name) ||
        value.enabled !== undefined && typeof value.enabled !== "boolean" ||
        value.includeSubdomains !== undefined && typeof value.includeSubdomains !== "boolean") {
      throw new Error("网站名称或开关无效，名称最多 60 个字符。");
    }
    return {
      id: `custom:${domain}`, domain, name,
      enabled: value.enabled !== false, includeSubdomains: value.includeSubdomains !== false
    };
  });
  const all = configuredSites({ ...input, customSites });
  for (const [index, site] of all.entries()) {
    if (all.slice(0, index).some(other => matchesHost(site.domain, other) || matchesHost(other.domain, site))) {
      throw new Error(`网站 ${site.domain} 与现有域名规则重叠，请编辑原规则或添加例外。`);
    }
  }
  const values = input.exceptions ?? [];
  if (!Array.isArray(values) || values.length > 100) throw new Error("例外最多 100 条。");
  const exceptions = [];
  for (const value of values) {
    let url;
    try { url = new URL(value.url); } catch { throw new Error("例外需要完整的 HTTP 或 HTTPS 网址。"); }
    if (!["page", "path"].includes(value.mode) || !configuredSite(url.href, { ...input, customSites }) ||
        url.href.length > 2048 || /%2f|%5c/i.test(url.pathname)) {
      throw new Error("例外必须属于已配置的网站，且不能包含编码的路径分隔符。");
    }
    if (value.mode === "path") {
      if (url.pathname === "/") throw new Error("整站放行请关闭网站开关；路径例外不能是根目录。");
      url.search = "";
      url.hash = "";
      url.pathname = url.pathname.replace(/\/$/, "");
    } else url.searchParams.sort();
    const rule = { mode: value.mode, url: url.href };
    if (!exceptions.some(item => item.mode === rule.mode && item.url === rule.url)) exceptions.push(rule);
  }
  return { customSites, exceptions };
}

export function recordSite(value) {
  const builtin = SITES.find(site => site.id === value?.siteId);
  if (builtin) return builtin;
  if (typeof value?.siteId !== "string" || !value.siteId.startsWith("custom:")) return null;
  try {
    const domain = normalizeDomain(value.siteId.slice(7));
    if (value.siteId !== `custom:${domain}` || typeof value.siteName !== "string" ||
        !value.siteName.trim() || value.siteName.length > 60) return null;
    return { id: value.siteId, domain, name: value.siteName };
  } catch { return null; }
}
