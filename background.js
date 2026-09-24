import { DEFAULT_SETTINGS, siteFor, targetUrl, validateGrant, validateSettings, redirectRules, allowRule } from "./core.js";

let state = { grants: {}, pending: {} };
let settings;
let records = [];
let queue = Promise.resolve();

function run(work) {
  const task = queue.then(() => ready).then(work);
  queue = task.catch(error => console.error("[pause]", error));
  return task;
}

async function persist() {
  await chrome.storage.session.set({ state });
  await chrome.storage.local.set({ records, settings });
}

function recordById(id) {
  return records.find(record => record.id === id);
}

async function finish(tabId, outcome, close = false) {
  const grant = state.grants[tabId];
  if (!grant) return;
  // Revoke the network exemption before releasing the persisted grant.
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [allowRule(grant).id] });
  await chrome.alarms.clear(`expire:${tabId}`);
  const record = recordById(grant.recordId);
  if (record) {
    record.endedAt = Date.now();
    record.elapsedMs = Math.max(0, Math.min(record.endedAt, grant.expiresAt) - grant.startedAt);
    record.outcome = outcome;
  }
  delete state.grants[tabId];
  await persist();
  if (close) {
    // Never close an unrelated page the user has navigated to in the meantime.
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (siteFor(tab?.url)?.id === grant.siteId) {
      await chrome.tabs.remove(tabId).catch(() => {});
    }
  }
}

function abandon(tabId, outcome = "dismissed") {
  const pending = state.pending[tabId];
  if (!pending) return;
  const record = recordById(pending.recordId);
  if (record?.outcome === "pending") {
    record.outcome = outcome;
    record.endedAt = Date.now();
  }
  delete state.pending[tabId];
}

async function bootstrap() {
  const [local, session] = await Promise.all([
    chrome.storage.local.get(["settings", "records"]),
    chrome.storage.session.get("state")
  ]);
  settings = { ...DEFAULT_SETTINGS, ...local.settings };
  records = local.records || [];
  state = session.state || state;
  const dynamic = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: dynamic.map(rule => rule.id),
    addRules: redirectRules(chrome.runtime.getURL("pause.html"))
  });
  const sessionRules = await chrome.declarativeNetRequest.getSessionRules();
  const tabs = await chrome.tabs.query({});
  const liveIds = new Set(tabs.map(tab => tab.id));
  for (const grant of Object.values(state.grants)) {
    if (!liveIds.has(grant.tabId)) delete state.grants[grant.tabId];
  }
  for (const tabId of Object.keys(state.pending)) {
    if (!liveIds.has(Number(tabId))) abandon(tabId);
  }
  const activeIds = new Set([
    ...Object.values(state.grants).map(grant => grant.recordId),
    ...Object.values(state.pending).map(pending => pending.recordId)
  ]);
  for (const record of records) {
    if (["active", "pending"].includes(record.outcome) && !activeIds.has(record.id)) {
      record.outcome = "interrupted";
      record.endedAt = null;
      record.elapsedMs = null;
    }
  }
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: sessionRules.map(rule => rule.id),
    addRules: Object.values(state.grants).filter(grant => grant.expiresAt > Date.now()).map(allowRule)
  });
  for (const grant of Object.values(state.grants)) {
    if (grant.expiresAt <= Date.now()) await finish(grant.tabId, "expired", true);
    else await chrome.alarms.create(`expire:${grant.tabId}`, { when: grant.expiresAt });
  }
  await chrome.alarms.create("reconcile", { periodInMinutes: 0.5 });
  await persist();
}

const ready = bootstrap();

chrome.runtime.onInstalled.addListener(() => run(() => {}));
chrome.runtime.onStartup.addListener(() => run(() => {}));
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.alarms.onAlarm.addListener(() => run(async () => {
  for (const grant of Object.values(state.grants)) {
    if (grant.expiresAt <= Date.now()) await finish(grant.tabId, "expired", true);
  }
}));

chrome.tabs.onRemoved.addListener(tabId => run(async () => {
  await finish(tabId, "closed");
  abandon(tabId);
  await persist();
}));

async function onNavigation(details) {
  if (details.frameId !== 0) return;
  const { tabId, url } = details;
  const site = siteFor(url);
  const grant = state.grants[tabId];
  if (!site && !grant && !state.pending[tabId]) return;
  if (grant && grant.siteId !== site?.id) await finish(tabId, "left");
  if (!url.startsWith(chrome.runtime.getURL("pause.html"))) abandon(tabId);
  if (site && (!state.grants[tabId] || state.grants[tabId].expiresAt <= Date.now())) {
    if (state.grants[tabId]) {
      await finish(tabId, "expired", true);
    } else {
      await chrome.tabs.update(tabId, { url: `${chrome.runtime.getURL("pause.html")}#${url}` });
    }
  }
  await persist();
}

chrome.webNavigation.onCommitted.addListener(details => run(() => onNavigation(details)));
chrome.webNavigation.onHistoryStateUpdated.addListener(details => run(() => onNavigation(details)));
chrome.webNavigation.onReferenceFragmentUpdated.addListener(details => run(() => onNavigation(details)));

function requirePage(sender, filename) {
  if (sender.id !== chrome.runtime.id || sender.url?.split(/[?#]/)[0] !== chrome.runtime.getURL(filename)) {
    throw new Error("此操作只能在插件页面执行。");
  }
}

async function handle(message, sender) {
  if (message.type === "timer" || message.type === "expire") {
    const tabId = sender.tab?.id;
    const site = siteFor(sender.url);
    if (!site || sender.frameId !== 0) throw new Error("无效的计时来源。");
    const grant = state.grants[tabId];
    if (grant && grant.siteId === site.id && grant.expiresAt <= Date.now()) {
      await finish(tabId, "expired", true);
      return null;
    }
    if (!grant || grant.siteId !== site.id) {
      await chrome.tabs.update(tabId, { url: `${chrome.runtime.getURL("pause.html")}#${sender.url}` });
      return null;
    }
    return { expiresAt: grant.expiresAt, warningSeconds: settings.warningSeconds };
  }
  if (["inspect", "continue", "leave"].includes(message.type)) {
    requirePage(sender, "pause.html");
    const tabId = sender.tab?.id;
    if (!Number.isInteger(tabId)) throw new Error("请在浏览器标签页中打开。");
    const target = targetUrl(sender.url.slice(sender.url.indexOf("#") + 1));
    const site = siteFor(target);
    if (message.type === "inspect") {
      if (state.grants[tabId]) await finish(tabId, "left");
      if (state.pending[tabId]?.target !== target) {
        abandon(tabId);
        const record = {
          id: crypto.randomUUID(), siteId: site.id, siteName: site.name,
          attemptedAt: Date.now(), startedAt: null, endedAt: null,
          plannedMs: 0, elapsedMs: 0, reason: "", outcome: "pending"
        };
        records.push(record);
        state.pending[tabId] = { target, recordId: record.id };
        await persist();
      }
      return { site, settings };
    }
    const pending = state.pending[tabId];
    if (!pending || pending.target !== target) throw new Error("页面状态已更新，请刷新后重试。");
    if (message.type === "leave") {
      abandon(tabId, "declined");
      await persist();
      await chrome.tabs.update(tabId, { url: settings.exitUrl });
      return null;
    }
    const { duration, purpose } = validateGrant(message.minutes, message.reason);
    const now = Date.now();
    const grant = { tabId, siteId: site.id, recordId: pending.recordId, startedAt: now, expiresAt: now + duration * 60000 };
    Object.assign(recordById(pending.recordId), {
      startedAt: now, plannedMs: duration * 60000, reason: purpose, outcome: "active"
    });
    state.grants[tabId] = grant;
    delete state.pending[tabId];
    await persist();
    try {
      await chrome.declarativeNetRequest.updateSessionRules({ addRules: [allowRule(grant)] });
      await chrome.alarms.create(`expire:${tabId}`, { when: grant.expiresAt });
      await chrome.tabs.update(tabId, { url: target });
    } catch (error) {
      await finish(tabId, "error");
      throw error;
    }
    return null;
  }
  requirePage(sender, "journal.html");
  if (message.type === "journal") return { settings, records };
  if (message.type === "settings") {
    settings = validateSettings(message.settings);
    await persist();
    return settings;
  }
  if (message.type === "clear") {
    const keep = new Set([
      ...Object.values(state.grants).map(grant => grant.recordId),
      ...Object.values(state.pending).map(pending => pending.recordId)
    ]);
    records = records.filter(record => keep.has(record.id));
    await persist();
    return { settings, records };
  }
  throw new Error("未知操作。");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  run(() => handle(message, sender)).then(
    data => sendResponse({ ok: true, data }),
    error => sendResponse({ ok: false, error: error.message })
  );
  return true;
});
