import { DEFAULT_SETTINGS, siteFor, targetUrl, pauseTarget, validateGrant, validateSettings } from "./core.js";

const pausePage = chrome.runtime.getURL("pause.html");
let state = { grants: {}, pending: {} };
let settings;
let records = [];
let queue = Promise.resolve();
const navigations = new Map();

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
  await chrome.storage.local.set({ records, settings });
}

function recordById(id) {
  return records.find(record => record.id === id);
}

async function finish(tabId, outcome, close = false) {
  const grant = state.grants[tabId];
  if (!grant) return;
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
    const intent = navigations.get(tabId);
    if (intent && siteFor(intent.url)?.id !== grant.siteId) return;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (siteFor(tab?.pendingUrl || tab?.url)?.id === grant.siteId) {
      await chrome.tabs.remove(tabId).catch(() => {});
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
  const [local, session] = await Promise.all([
    chrome.storage.local.get(["settings", "records"]),
    chrome.storage.session.get("state")
  ]);
  settings = { ...DEFAULT_SETTINGS, ...local.settings };
  records = local.records || [];
  state = session.state || state;
  const tabs = await chrome.tabs.query({});
  const liveIds = new Set(tabs.map(tab => tab.id));
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
chrome.alarms.onAlarm.addListener(() => schedule(async () => {
  for (const grant of Object.values(state.grants)) {
    if (grant.expiresAt <= Date.now()) await finish(grant.tabId, "expired", true);
  }
}));
chrome.tabs.onRemoved.addListener(tabId => {
  navigations.delete(tabId);
  schedule(async () => {
    await finish(tabId, "closed");
    if (abandon(tabId)) await persist();
  });
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
  if (intent && intent.url !== sender.url) return false;
  if (intent?.phase === "before") return false;
  if (intent?.documentId && sender.documentId && intent.documentId !== sender.documentId) return false;
  const currentUrl = tab.pendingUrl || tab.url;
  if (currentUrl) return currentUrl === sender.url;
  // Without "tabs", Chrome omits extension-page URLs here. The authenticated
  // sender and the navigation document ID still identify our own top-level page.
  return Boolean(pauseTarget(sender.url, pausePage) && sender.tab.url === sender.url);
}

async function handle(message, sender) {
  if (message.type === "timer" || message.type === "expire") {
    const tabId = sender.tab?.id;
    const site = siteFor(sender.url);
    if (!site || sender.frameId !== 0) throw new Error("无效的计时来源。");
    if (!await isCurrentDocument(sender)) return null;
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
    return { expiresAt: grant.expiresAt, warningSeconds: settings.warningSeconds };
  }
  if (["inspect", "continue", "leave"].includes(message.type)) {
    requirePage(sender, "pause.html");
    const tabId = sender.tab?.id;
    if (!await isCurrentDocument(sender)) throw new Error("页面已经切换，请刷新后重试。");
    const target = pauseTarget(sender.url, pausePage);
    if (!target) throw new Error("不是有效的受限网站地址。");
    const site = siteFor(target);
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
