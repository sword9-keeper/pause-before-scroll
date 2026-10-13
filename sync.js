import { SITES, validateSettings } from "./core.js";
import { parseXml } from "./vendor/parse-xml.js";

export const MAX_SYNC_BYTES = 4 * 1024 * 1024;
export const DEFAULT_SYNC_CONFIG = {
  enabled: false, url: "", username: "", password: "", syncRecords: true
};
const encoder = new TextEncoder();
const finishedOutcomes = new Set([
  "declined", "dismissed", "expired", "closed", "left", "interrupted", "error", "navigation_error"
]);

export function validateSyncConfig(input) {
  const config = {
    enabled: input.enabled === true,
    url: String(input.url || "").trim(),
    username: String(input.username || "").trim(),
    password: String(input.password || ""),
    syncRecords: input.syncRecords !== false
  };
  if (!config.url && !config.enabled) return config;
  let url;
  try { url = new URL(config.url); } catch { throw new Error("请输入完整的 HTTPS WebDAV 目录地址。"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("WebDAV 必须使用 HTTPS，地址中不能包含账号、查询参数或片段。");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  config.url = url.href;
  if (config.username.includes(":") || /[\r\n]/.test(config.username) ||
      config.username.length > 256 || config.password.length > 1024) {
    throw new Error("WebDAV 用户名或密码格式无效。");
  }
  if (config.enabled && (!config.username || !config.password)) {
    throw new Error("请填写 WebDAV 用户名和密码。");
  }
  return config;
}

export function permissionOrigin(url) {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

function validId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
}

export function compareRevision(a, b) {
  return a.at - b.at || (a.device < b.device ? -1 : a.device > b.device ? 1 : 0);
}

export function nextRevision(previous, device) {
  return { at: Math.max(Date.now(), previous.at + 1), device };
}

function validateRecord(value) {
  const site = SITES.find(item => item.id === value?.siteId);
  const timestamp = number => Number.isSafeInteger(number) && number >= 0 && number <= 8640000000000000;
  const nullableTime = number => number === null || timestamp(number);
  if (!value || !validId(value.id) || !site || !finishedOutcomes.has(value.outcome) ||
      !timestamp(value.attemptedAt) || !nullableTime(value.startedAt) || !nullableTime(value.endedAt) ||
      !Number.isFinite(value.plannedMs) || value.plannedMs < 0 || value.plannedMs > 86400000 ||
      !(value.elapsedMs === null || (Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0 && value.elapsedMs <= 86400000)) ||
      typeof value.reason !== "string" || value.reason.length > 200) {
    throw new Error("同步文件含有无效的记录，本地数据未被替换。");
  }
  return {
    id: value.id, siteId: site.id, siteName: site.name,
    attemptedAt: value.attemptedAt, startedAt: value.startedAt, endedAt: value.endedAt,
    plannedMs: value.plannedMs, elapsedMs: value.elapsedMs, reason: value.reason, outcome: value.outcome
  };
}

export function validateDocument(value) {
  if (!value || value.schemaVersion !== 1 || value.app !== "back-to-flow" ||
      !value.settings || !Number.isSafeInteger(value.settings.revision?.at) ||
      value.settings.revision.at < 0 || value.settings.revision.at > 8640000000000000 ||
      !validId(value.settings.revision.device) ||
      !Array.isArray(value.records) || value.records.length > 20000 ||
      !Array.isArray(value.deletedIds) || value.deletedIds.length > 40000 ||
      !value.deletedIds.every(validId)) {
    throw new Error("同步文件格式或版本不兼容，本地和远端文件均未被覆盖。");
  }
  return {
    app: "back-to-flow", schemaVersion: 1,
    settings: {
      revision: { at: value.settings.revision.at, device: value.settings.revision.device },
      value: validateSettings(value.settings.value)
    },
    records: value.records.map(validateRecord),
    deletedIds: [...new Set(value.deletedIds)].sort()
  };
}

export function mergeDocuments(local, remote, syncRecords = true) {
  const settings = !remote || compareRevision(local.settings.revision, remote.settings.revision) > 0 ?
    local.settings : remote.settings;
  const deletedIds = [...new Set([
    ...(remote?.deletedIds || []), ...(syncRecords ? local.deletedIds : [])
  ])].sort();
  const deleted = new Set(deletedIds);
  const records = new Map();
  for (const record of [...(remote?.records || []), ...(syncRecords ? local.records : [])]) {
    if (deleted.has(record.id)) continue;
    const previous = records.get(record.id);
    // Finished records are immutable. A deterministic tie-break also handles restored backups.
    if (!previous || JSON.stringify(record) > JSON.stringify(previous)) records.set(record.id, record);
  }
  return {
    app: "back-to-flow", schemaVersion: 1, settings,
    records: [...records.values()].sort((a, b) => a.attemptedAt - b.attemptedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    deletedIds
  };
}

export function serializeDocument(value) {
  const text = JSON.stringify(validateDocument(value));
  if (encoder.encode(text).byteLength > MAX_SYNC_BYTES) {
    throw new Error("同步数据超过 4 MB。请先导出备份并清理历史记录。");
  }
  return text;
}

function httpError(status) {
  if (status === 401 || status === 403) return new Error(`WebDAV 认证或写入权限不足（HTTP ${status}）。`);
  if (status >= 300 && status < 400) return new Error("WebDAV 地址发生重定向，请填写最终的 HTTPS 目录地址。");
  if (status === 409) return new Error("WebDAV 的上级目录不存在，请检查目录地址。");
  if (status === 507) return new Error("WebDAV 存储空间不足。");
  return new Error(`WebDAV 请求失败（HTTP ${status}）。`);
}

async function readLimited(response) {
  if (Number(response.headers.get("content-length")) > MAX_SYNC_BYTES) {
    throw new Error("远端同步文件超过 4 MB，已停止读取。");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("WebDAV 返回了空响应。");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_SYNC_BYTES) throw new Error("远端同步文件超过 4 MB，已停止读取。");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function isDavElement(node, name) {
  if (node.type !== "element") return false;
  const parts = node.name.split(":");
  if (parts.at(-1) !== name) return false;
  const declaration = parts.length === 2 ? `xmlns:${parts[0]}` : "xmlns";
  for (let current = node; current; current = current.parent) {
    if (Object.hasOwn(current.attributes || {}, declaration)) return current.attributes[declaration] === "DAV:";
  }
  return false;
}

export function deviceFiles(xml, directory) {
  let parsed;
  try { parsed = parseXml(xml); }
  catch { throw new Error("WebDAV 返回的目录不是有效 XML，已停止同步。"); }
  const root = parsed.children.find(node => node.type === "element");
  if (!root || !isDavElement(root, "multistatus")) throw new Error("服务器没有返回 WebDAV 目录列表。");
  const files = new Set();
  for (const response of root.children.filter(node => isDavElement(node, "response"))) {
    const href = response.children.find(node => isDavElement(node, "href"));
    if (!href) continue;
    const text = href.children.filter(node => node.type === "text" || node.type === "cdata").map(node => node.text).join("");
    let url;
    try { url = new URL(text, directory); } catch { continue; }
    if (!url.href.startsWith(directory) || url.search || url.hash || url.username || url.password) continue;
    const filename = url.href.slice(directory.length);
    if (/^device-[a-zA-Z0-9_-]{1,100}\.json$/.test(filename)) files.add(url.href);
  }
  if (files.size > 32) throw new Error("同步目录超过 32 个设备文件，请先备份并整理旧设备文件。");
  return [...files].sort();
}

export async function syncWebDAV(config, local, { signal, deviceId, fetcher = fetch } = {}) {
  config = validateSyncConfig(config);
  if (!config.enabled) throw new Error("请先启用并保存 WebDAV 同步。");
  if (!validId(deviceId)) throw new Error("本机同步标识无效。");
  const bytes = encoder.encode(`${config.username}:${config.password}`);
  const authorization = `Basic ${btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""))}`;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timeout = setTimeout(abort, 25000);
  const request = (url, method, headers = {}, body) => fetcher(url, {
    method, headers: { Authorization: authorization, ...headers }, body,
    signal: controller.signal, redirect: "error", credentials: "omit", cache: "no-store",
    referrerPolicy: "no-referrer"
  });
  try {
    // Only the configured final directory may be created; never walk or modify its parents.
    const collection = await request(config.url, "MKCOL");
    if (![201, 405].includes(collection.status)) throw httpError(collection.status);
    const directory = new URL("devices-v1/", config.url).href;
    const devices = await request(directory, "MKCOL");
    if (![201, 405].includes(devices.status)) throw httpError(devices.status);
    const listing = await request(directory, "PROPFIND", {
      Depth: "1", "Content-Type": "application/xml; charset=utf-8"
    }, '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>');
    if (listing.status !== 207) throw httpError(listing.status);
    const ownUrl = new URL(`device-${deviceId}.json`, directory).href;
    const files = deviceFiles(await readLimited(listing), directory);
    if (files.length === 32 && !files.includes(ownUrl)) {
      throw new Error("同步目录已有 32 个设备文件，请先备份并整理旧设备文件。");
    }
    let remote = null;
    let previousOwn = null;
    for (const url of files) {
      const response = await request(url, "GET");
      if (response.status === 200) {
        let parsed;
        try { parsed = JSON.parse(await readLimited(response)); }
        catch (error) {
          if (error instanceof SyntaxError || error instanceof TypeError) {
            throw new Error("远端不是有效的 JSON 同步文件，未覆盖任何数据。");
          }
          throw error;
        }
        const document = validateDocument(parsed);
        if (url === ownUrl) previousOwn = serializeDocument(document);
        remote = mergeDocuments(document, remote);
        serializeDocument(remote);
      } else if (response.status !== 404) throw httpError(response.status);
    }
    const merged = mergeDocuments(local, remote, config.syncRecords);
    const body = serializeDocument(merged);
    // Each installation owns exactly one file; concurrent devices never overwrite each other.
    if (body !== previousOwn) {
      const result = await request(ownUrl, "PUT", { "Content-Type": "application/json; charset=utf-8" }, body);
      if (![200, 201, 204].includes(result.status)) throw httpError(result.status);
    }
    return merged;
  } catch (error) {
    if (signal?.aborted) throw new Error("同步已取消。");
    if (controller.signal.aborted) throw new Error("同步超时，请检查网络或 WebDAV 服务；本地数据已保留。");
    if (error instanceof TypeError) throw new Error("无法连接 WebDAV。请检查地址、网络、HTTPS 证书及站点访问授权。");
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}
