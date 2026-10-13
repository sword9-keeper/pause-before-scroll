import { DEFAULT_SETTINGS, siteFor as matchSite, targetUrl, pauseTarget, validateGrant, validateSettings } from "./core.js";
import { DEFAULT_SYNC_CONFIG, validateSyncConfig, permissionOrigin, nextRevision, compareRevision, mergeDocuments, syncWebDAV } from "./sync.js";
import installDefaults from "./install-defaults.js";

const pausePage = chrome.runtime.getURL("pause.html");
let state = { grants: {}, pending: {} };
let settings;
let records = [];
let timerLayout = { x: 1, y: 0, collapsed: false };
let queue = Promise.resolve();
const navigations = new Map();
let syncConfig = { ...DEFAULT_SYNC_CONFIG };
let syncMeta;
let syncFlight;
let syncController;
let syncGeneration = 0;

function siteFor(raw) {
  return matchSite(raw, settings?.enabledSites);
}

function run(work) {
  const task = queue.then(() => ready).then(work);
  queue = task.catch(error => console.error("[pause]", error));
  return task;
}

function schedule(work) {
  void run(work).catch(() => {});
}

async function persist() {
  await chrome.storage.session.set({ state });
  await chrome.storage.local.set({ records, settings, syncMeta });
}

function protectedRecordIds() {
  return new Set([
    ...Object.values(state.grants).map(grant => grant.recordId),
    ...Object.values(state.pending).map(pending => pending.recordId)
  ]);
}

function syncDocument() {
  const protectedIds = protectedRecordIds();
  return {
    app: "back-to-flow", schemaVersion: 1,
    settings: { revision: syncMeta.settingsRevision, value: settings },
    records: records.filter(record => !protectedIds.has(record.id) && !["active", "pending"].includes(record.outcome)),
    deletedIds: syncMeta.deletedIds
  };
}

function syncView() {
  const { password, ...config } = syncConfig;
  return {
    config: { ...config, passwordSaved: Boolean(password) },
    status: {
      busy: syncMeta.busy, lastSuccessAt: syncMeta.lastSuccessAt,
      lastError: syncMeta.lastError, hasSettingsBackup: Boolean(syncMeta.settingsBackup)
    }
  };
}

async function syncAlarm(reset = false) {
  if (reset || !syncConfig.enabled) await chrome.alarms.clear("webdav-sync");
  if (syncConfig.enabled && !await chrome.alarms.get("webdav-sync")) {
    await chrome.alarms.create("webdav-sync", { delayInMinutes: 0.5, periodInMinutes: 5 });
  }
}

async function releaseDisabledSites() {
  for (const grant of Object.values(state.grants)) {
    if (!settings.enabledSites.includes(grant.siteId)) await finish(grant.tabId, "left");
  }
  for (const [id, pending] of Object.entries(state.pending)) {
    if (siteFor(pending.target)) continue;
    const tabId = Number(id);
    abandon(tabId);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const current = navigations.get(tabId)?.url || tab?.pendingUrl || tab?.url;
    if (current === `${pausePage}#${pending.target}`) {
      await chrome.tabs.update(tabId, { url: pending.target }).catch(() => {});
    }
  }
}

function startSync() {
  if (syncFlight) return syncFlight;
  // Fetch stays outside the navigation queue so an unavailable server cannot delay expiry.
  syncFlight = (async () => {
    let generation;
    try {
      const snapshot = await run(async () => {
        if (!syncConfig.enabled) throw new Error("请先启用并保存 WebDAV 同步。");
        if (!await chrome.permissions.contains({ origins: [permissionOrigin(syncConfig.url)] })) {
          throw new Error("WebDAV 站点访问权限已取消，请重新保存连接并授权。");
        }
        generation = syncGeneration;
        syncController = new AbortController();
        syncMeta.busy = true;
        syncMeta.lastError = "";
        await persist();
        return structuredClone({ config: syncConfig, document: syncDocument(), deviceId: syncMeta.deviceId });
      });
      const merged = await syncWebDAV(snapshot.config, snapshot.document, { signal: syncController.signal, deviceId: snapshot.deviceId });
      return await run(async () => {
        if (generation !== syncGeneration) throw new Error("连接配置已更改，本次同步结果未应用。");
        const current = syncDocument();
        const result = mergeDocuments(current, merged, true);
        if (compareRevision(result.settings.revision, syncMeta.settingsRevision) > 0) {
          if (JSON.stringify(settings) !== JSON.stringify(result.settings.value)) {
            syncMeta.settingsBackup = { value: structuredClone(settings), savedAt: Date.now() };
          }
          settings = result.settings.value;
          syncMeta.settingsRevision = result.settings.revision;
        }
        if (snapshot.config.syncRecords) {
          const protectedIds = protectedRecordIds();
          records = [
            ...result.records.filter(record => !protectedIds.has(record.id)),
            ...records.filter(record => protectedIds.has(record.id))
          ].sort((a, b) => a.attemptedAt - b.attemptedAt);
          syncMeta.deletedIds = result.deletedIds;
        }
        syncMeta.busy = false;
        syncMeta.lastSuccessAt = Date.now();
        syncMeta.lastError = "";
        await releaseDisabledSites();
        await persist();
        return syncView();
      });
    } catch (error) {
      await run(async () => {
        if (generation !== undefined && generation !== syncGeneration) return;
        syncMeta.busy = false;
        syncMeta.lastError = error.message;
        await persist();
      });
      throw error;
    } finally {
      syncFlight = null;
      syncController = null;
    }
  })();
  return syncFlight;
}

function recordById(id) {
  return records.find(record => record.id === id);
}

async function finish(tabId, outcome, close = false) {
  const grant = state.grants[tabId];
  if (!grant) return;
  await chrome.alarms.clear(`expire:${tabId}`);
  const record = recordById(grant.recordId);
  const siblings = Object.values(state.grants).filter(item => item.tabId !== tabId && item.recordId === grant.recordId);
  if (record && siblings.length === 0) {
    record.endedAt = Date.now();
    record.elapsedMs = Math.max(0, Math.min(record.endedAt, grant.expiresAt) - grant.startedAt);
    record.outcome = outcome;
  }
  delete state.grants[tabId];
  await persist();
  if (close) {
    const intent = navigations.get(tabId);
    if (intent && siteFor(intent.url)?.id !== grant.siteId) return;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (siteFor(tab?.pendingUrl || tab?.url)?.id === grant.siteId) {
      await chrome.tabs.remove(tabId).catch(() => {});
    }
  }
}

async function inherit(tabId, url) {
  const source = state.sources[tabId];
  const site = siteFor(url);
  if (!source || !site) return false;
  delete state.sources[tabId];
  if (source.siteId !== site.id || source.expiresAt <= Date.now() ||
      recordById(source.recordId)?.outcome !== "active") {
    await persist();
    return false;
  }
  const pending = state.pending[tabId];
  if (pending) {
    records = records.filter(record => record.id !== pending.recordId);
    delete state.pending[tabId];
  }
  state.grants[tabId] = { ...source, tabId };
  await persist();
  await chrome.alarms.create(`expire:${tabId}`, { when: source.expiresAt });
  return true;
}

async function captureSource(tabId, sourceTabId, url) {
  if (state.grants[tabId]) return;
  const source = state.grants[sourceTabId];
  if (!source || source.expiresAt <= Date.now()) return;
  state.sources[tabId] = { ...source };
  await persist();
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) {
    delete state.sources[tabId];
    await persist();
    return;
  }
  const navigation = navigations.get(tabId);
  const current = navigation?.url || tab.pendingUrl || tab.url;
  const target = pauseTarget(current, pausePage) || current || url;
  if (target && await inherit(tabId, target)) {
    if (pauseTarget(current, pausePage) && navigations.get(tabId) === navigation) {
      await chrome.tabs.update(tabId, { url: target });
    }
  }
}

function abandon(tabId, outcome = "dismissed") {
  const pending = state.pending[tabId];
  if (!pending) return false;
  const record = recordById(pending.recordId);
  if (record?.outcome === "pending") {
    record.outcome = outcome;
    record.endedAt = Date.now();
  }
  delete state.pending[tabId];
  return true;
}

async function ensurePending(tabId, target) {
  const pending = state.pending[tabId];
  if (pending?.target === target) return pending;
  abandon(tabId);
  const site = siteFor(target);
  const record = {
    id: crypto.randomUUID(), siteId: site.id, siteName: site.name,
    attemptedAt: Date.now(), startedAt: null, endedAt: null,
    plannedMs: 0, elapsedMs: 0, reason: "", outcome: "pending"
  };
  records.push(record);
  state.pending[tabId] = { target, recordId: record.id };
  // Keep the attempt even if the confirmation page never loads.
  await persist();
  return state.pending[tabId];
}

function isCurrent(tabId, navigation) {
  return !navigation || navigations.get(tabId) === navigation;
}

async function showPause(tabId, rawTarget, navigation) {
  if (!isCurrent(tabId, navigation)) return;
  const target = targetUrl(rawTarget);
  const pending = await ensurePending(tabId, target);
  const destination = `${pausePage}#${target}`;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) {
    abandon(tabId);
    await persist();
    return;
  }
  if (!isCurrent(tabId, navigation)) return;
  if ((tab.pendingUrl || tab.url) === destination) return;
  try {
    await chrome.tabs.update(tabId, { url: destination });
    const record = recordById(pending.recordId);
    if (record?.outcome === "navigation_error") {
      record.outcome = "pending";
      record.endedAt = null;
      await persist();
    }
  } catch (error) {
    const record = recordById(pending.recordId);
    if (record) {
      record.outcome = "navigation_error";
      record.endedAt = Date.now();
      await persist();
    }
    console.warn("[pause] Confirmation navigation failed:", error.message);
    // Commit/completion events may retry a temporarily unavailable tab.
  }
}

async function checkNavigation(details, navigation) {
  const { tabId, url } = details;
  if (!isCurrent(tabId, navigation)) return;
  const site = siteFor(url);
  const target = pauseTarget(url, pausePage);
  if (target && !siteFor(target)) {
    await finish(tabId, "left");
    abandon(tabId);
    await persist();
    if (isCurrent(tabId, navigation)) await chrome.tabs.update(tabId, { url: target }).catch(() => {});
    return;
  }
  if (state.sources[tabId] && !site && !target && !["about:blank", "chrome://newtab/"].includes(url)) {
    delete state.sources[tabId];
    await persist();
  }
  if (!state.grants[tabId] && site) await inherit(tabId, url);
  const grant = state.grants[tabId];
  if (!site && !target && !grant && !state.pending[tabId]) return;
  if (grant) {
    if (grant.siteId === site?.id) {
      if (grant.expiresAt <= Date.now()) await finish(tabId, "expired", true);
      return;
    }
    await finish(tabId, "left");
  }
  if (!isCurrent(tabId, navigation)) return;
  if (site) {
    await showPause(tabId, url, navigation);
  } else if (target) {
    await ensurePending(tabId, target);
  } else if (abandon(tabId)) {
    await persist();
  }
}

function observeNavigation(details, phase) {
  if (details.frameId !== 0 || (details.documentLifecycle && details.documentLifecycle !== "active")) return;
  const previous = navigations.get(details.tabId);
  if (phase === "completed" && previous && (previous.phase === "before" || previous.url !== details.url)) return;
  if (["history", "fragment", "completed"].includes(phase) && previous) {
    if (previous.phase === "before") return;
    if (previous.documentId && details.documentId && previous.documentId !== details.documentId) return;
  }
  // Newer navigations invalidate queued work for the old destination.
  const navigation = { url: details.url, documentId: details.documentId, phase };
  navigations.set(details.tabId, navigation);
  schedule(() => checkNavigation(details, navigation));
}

async function bootstrap() {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  const [local, session] = await Promise.all([
    chrome.storage.local.get(["settings", "records", "timerLayout", "syncConfig", "syncMeta"]),
    chrome.storage.session.get("state")
  ]);
  settings = {
    ...DEFAULT_SETTINGS, ...local.settings,
    enabledSites: local.settings?.enabledSites ?? DEFAULT_SETTINGS.enabledSites
  };
  const deviceId = local.syncMeta?.deviceId || crypto.randomUUID();
  syncMeta = {
    deviceId, settingsRevision: { at: local.settings ? 1 : 0, device: deviceId }, deletedIds: [],
    lastSuccessAt: null, lastError: "", settingsBackup: null,
    ...local.syncMeta, busy: false
  };
  syncConfig = { ...DEFAULT_SYNC_CONFIG, ...(local.syncConfig || installDefaults) };
  if (!local.syncConfig && installDefaults) {
    syncConfig = validateSyncConfig(syncConfig);
    await chrome.storage.local.set({ syncConfig });
  }
  records = local.records || [];
  timerLayout = local.timerLayout || timerLayout;
  state = session.state || state;
  state.sources ||= {};
  const tabs = await chrome.tabs.query({});
  const liveIds = new Set(tabs.map(tab => tab.id));
  for (const id of Object.keys(state.sources)) {
    if (!liveIds.has(Number(id))) delete state.sources[id];
  }
  for (const grant of Object.values(state.grants)) {
    if (!liveIds.has(grant.tabId) || !recordById(grant.recordId)) delete state.grants[grant.tabId];
  }
  for (const tabId of Object.keys(state.pending)) {
    if (!liveIds.has(Number(tabId)) || !recordById(state.pending[tabId].recordId)) abandon(tabId);
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
  for (const grant of Object.values(state.grants)) {
    if (grant.expiresAt <= Date.now()) await finish(grant.tabId, "expired", true);
    else await chrome.alarms.create(`expire:${grant.tabId}`, { when: grant.expiresAt });
  }
  await chrome.alarms.create("reconcile", { periodInMinutes: 0.5 });
  await syncAlarm();
  await persist();
  for (const tab of tabs) {
    const current = await chrome.tabs.get(tab.id).catch(() => null);
    if (!current) continue;
    const navigation = navigations.get(tab.id);
    const url = navigation?.url || current.pendingUrl || current.url;
    if (url) await checkNavigation({ tabId: tab.id, url }, navigation);
    else if (state.grants[tab.id]) await finish(tab.id, "left");
  }
}

const ready = bootstrap();

chrome.runtime.onInstalled.addListener(() => schedule(() => {}));
chrome.runtime.onStartup.addListener(() => schedule(() => {}));
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "webdav-sync") {
    void ready.then(() => startSync()).catch(() => {});
    return;
  }
  schedule(async () => {
    for (const grant of Object.values(state.grants)) {
      if (grant.expiresAt <= Date.now()) await finish(grant.tabId, "expired", true);
    }
  });
});
chrome.tabs.onRemoved.addListener(tabId => {
  navigations.delete(tabId);
  schedule(async () => {
    const hadSource = Boolean(state.sources[tabId]);
    delete state.sources[tabId];
    await finish(tabId, "closed");
    const abandoned = abandon(tabId);
    if (abandoned || hadSource) await persist();
  });
});
chrome.webNavigation.onCreatedNavigationTarget.addListener(details => {
  schedule(() => captureSource(details.tabId, details.sourceTabId, details.url));
});

chrome.webNavigation.onBeforeNavigate.addListener(details => observeNavigation(details, "before"));
chrome.webNavigation.onCommitted.addListener(details => observeNavigation(details, "committed"));
chrome.webNavigation.onCompleted.addListener(details => observeNavigation(details, "completed"));
chrome.webNavigation.onHistoryStateUpdated.addListener(details => observeNavigation(details, "history"));
chrome.webNavigation.onReferenceFragmentUpdated.addListener(details => observeNavigation(details, "fragment"));
chrome.webNavigation.onErrorOccurred.addListener(details => {
  if (details.frameId !== 0) return;
  const navigation = navigations.get(details.tabId);
  if (navigation?.url === details.url && siteFor(details.url)) {
    schedule(() => checkNavigation(details, navigation));
  } else {
    const target = pauseTarget(details.url, pausePage);
    if (target && details.error !== "net::ERR_ABORTED") schedule(async () => {
      const pending = state.pending[details.tabId];
      const latest = navigations.get(details.tabId);
      if (pending?.target !== target || (latest && ![target, details.url].includes(latest.url))) return;
      const record = recordById(pending.recordId);
      if (record?.outcome === "pending") {
        record.outcome = "navigation_error";
        record.endedAt = Date.now();
        await persist();
      }
    });
  }
});
chrome.webNavigation.onTabReplaced.addListener(({ tabId, replacedTabId }) => {
  navigations.delete(replacedTabId);
  schedule(async () => {
    await finish(replacedTabId, "left");
    if (abandon(replacedTabId)) await persist();
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const url = tab?.pendingUrl || tab?.url;
    if (url) observeNavigation({ tabId, frameId: 0, url }, "committed");
  });
});

function requirePage(sender, filename) {
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 ||
      sender.url?.split(/[?#]/)[0] !== chrome.runtime.getURL(filename)) {
    throw new Error("此操作只能在插件页面执行。");
  }
}

async function isCurrentDocument(sender) {
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId) || sender.frameId !== 0) return false;
  if (sender.documentLifecycle && sender.documentLifecycle !== "active") return false;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return false;
  const intent = navigations.get(tabId);
  if (intent?.phase === "before") return false;
  if (intent?.documentId && sender.documentId && intent.documentId !== sender.documentId) return false;
  const currentUrl = tab.pendingUrl || tab.url;
  // A content script's sender URL can precede pushState; the document ID
  // still identifies the live document without trusting an old page.
  if (siteFor(sender.url) && intent?.documentId && intent.documentId === sender.documentId &&
      siteFor(intent.url)?.id === siteFor(sender.url).id && currentUrl === intent.url) return true;
  if (intent && intent.url !== sender.url) return false;
  if (currentUrl) return currentUrl === sender.url;
  // Without "tabs", Chrome omits extension-page URLs here. The authenticated
  // sender and the navigation document ID still identify our own top-level page.
  return Boolean(pauseTarget(sender.url, pausePage) && sender.tab.url === sender.url);
}

async function handle(message, sender) {
  if (["timer", "expire", "timerLayout"].includes(message.type)) {
    const tabId = sender.tab?.id;
    const site = siteFor(sender.url);
    if (!matchSite(sender.url) || sender.frameId !== 0) throw new Error("无效的计时来源。");
    if (!site) return null;
    if (!await isCurrentDocument(sender)) return null;
    if (!state.grants[tabId]) await inherit(tabId, sender.url);
    const grant = state.grants[tabId];
    if (grant && grant.siteId === site.id && grant.expiresAt <= Date.now()) {
      await finish(tabId, "expired", true);
      return null;
    }
    if (!grant || grant.siteId !== site.id) {
      if (grant) await finish(tabId, "left");
      await showPause(tabId, sender.url, navigations.get(tabId));
      return null;
    }
    if (message.type === "timerLayout") {
      const layout = message.layout;
      if (!layout || !Number.isFinite(layout.x) || !Number.isFinite(layout.y) ||
          typeof layout.collapsed !== "boolean") throw new Error("无效的浮窗位置。");
      timerLayout = { x: Math.max(0, Math.min(1, layout.x)), y: Math.max(0, Math.min(1, layout.y)), collapsed: layout.collapsed };
      await chrome.storage.local.set({ timerLayout });
    }
    return { expiresAt: grant.expiresAt, warningSeconds: settings.warningSeconds, timerLayout };
  }
  if (["inspect", "continue", "leave"].includes(message.type)) {
    requirePage(sender, "pause.html");
    const tabId = sender.tab?.id;
    if (!await isCurrentDocument(sender)) throw new Error("页面已经切换，请刷新后重试。");
    const target = pauseTarget(sender.url, pausePage);
    if (!target) throw new Error("不是有效的受限网站地址。");
    const site = siteFor(target);
    if (!site) throw new Error("该网站限制已关闭，请重新打开网站。");
    if (message.type === "inspect") {
      if (state.grants[tabId]) await finish(tabId, "left");
      const pending = await ensurePending(tabId, target);
      const record = recordById(pending.recordId);
      if (record?.outcome === "navigation_error") {
        record.outcome = "pending";
        record.endedAt = null;
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
  if (message.type === "syncStatus") return syncView();
  if (message.type === "syncSave") {
    const input = { ...message.config };
    // A blank password means keep the saved one only for the same endpoint and account.
    if (!input.password && input.url === syncConfig.url && input.username === syncConfig.username) {
      input.password = syncConfig.password;
    }
    const next = validateSyncConfig(input);
    if (next.enabled && !await chrome.permissions.contains({ origins: [permissionOrigin(next.url)] })) {
      throw new Error("请授权访问 WebDAV 服务器后重试。");
    }
    syncController?.abort();
    syncGeneration++;
    const changedEndpoint = next.url !== syncConfig.url || next.username !== syncConfig.username;
    syncConfig = next;
    syncMeta.busy = false;
    syncMeta.lastError = "";
    if (changedEndpoint) syncMeta.lastSuccessAt = null;
    await chrome.storage.local.set({ syncConfig });
    await syncAlarm(true);
    await persist();
    return syncView();
  }
  if (message.type === "syncForget") {
    syncController?.abort();
    syncGeneration++;
    syncConfig = { ...DEFAULT_SYNC_CONFIG };
    syncMeta.busy = false;
    syncMeta.lastSuccessAt = null;
    syncMeta.lastError = "";
    await chrome.storage.local.set({ syncConfig });
    await syncAlarm(true);
    await persist();
    return syncView();
  }
  if (message.type === "restoreSettings") {
    if (!syncMeta.settingsBackup) throw new Error("没有可恢复的设置。");
    settings = validateSettings(syncMeta.settingsBackup.value);
    syncMeta.settingsBackup = null;
    syncMeta.settingsRevision = nextRevision(syncMeta.settingsRevision, syncMeta.deviceId);
    await releaseDisabledSites();
    await persist();
    return settings;
  }
  if (message.type === "settings") {
    settings = validateSettings(message.settings);
    syncMeta.settingsRevision = nextRevision(syncMeta.settingsRevision, syncMeta.deviceId);
    await releaseDisabledSites();
    await persist();
    return settings;
  }
  if (message.type === "clear") {
    const keep = protectedRecordIds();
    syncMeta.deletedIds = [...new Set([...syncMeta.deletedIds, ...records.filter(record => !keep.has(record.id)).map(record => record.id)])];
    records = records.filter(record => keep.has(record.id));
    await persist();
    return { settings, records };
  }
  throw new Error("未知操作。");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const task = message?.type === "syncNow" ?
    ready.then(() => { requirePage(sender, "journal.html"); return startSync(); }) :
    run(() => handle(message, sender));
  task.then(
    data => sendResponse({ ok: true, data }),
    error => sendResponse({ ok: false, error: error.message })
  );
  return true;
});
