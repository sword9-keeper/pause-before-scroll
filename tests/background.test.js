import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../core.js";
import { createDav } from "./dav-fixture.mjs";

let instance = 0;
const base = "chrome-extension://test/";

function event() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    emit(...args) { for (const listener of listeners) listener(...args); },
    listeners
  };
}

async function harness(initial = {}) {
  const local = structuredClone({ ...(initial.fresh ? {} : { settings: DEFAULT_SETTINGS, setupComplete: true }), ...initial.local });
  const session = structuredClone(initial.session || {});
  const tabs = new Map((initial.tabs || [{ id: 42, url: "about:blank", documentId: "initial" }])
    .map(tab => [tab.id, { active: true, windowId: 1, ...structuredClone(tab) }]));
  const windows = new Map([[1, { id: 1, focused: true, state: "normal" }]]);
  const updates = [];
  const removed = [];
  const notifications = [];
  const created = [];
  const granted = new Set(initial.origins || [
    "*://*.douyin.com/*", "*://*.xiaohongshu.com/*", "*://*.bilibili.com/*", "https://dav.example.test/*"
  ]);
  const scripts = new Map();
  let rejectUpdates = false;
  let document = 0;
  const area = data => ({
    async get(keys) {
      return structuredClone(Object.fromEntries(
        (Array.isArray(keys) ? keys : [keys]).map(key => [key, data[key]])));
    },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async setAccessLevel() {}
  });
  const webNavigation = Object.fromEntries([
    "onBeforeNavigate", "onCommitted", "onCompleted", "onHistoryStateUpdated",
    "onReferenceFragmentUpdated", "onErrorOccurred", "onTabReplaced", "onCreatedNavigationTarget"
  ].map(name => [name, event()]));
  const alarms = new Map();
  const chrome = {
    storage: { local: area(local), session: area(session) },
    permissions: {
      onAdded: event(), onRemoved: event(),
      async contains({ origins }) { return origins.every(origin => granted.has(origin)); },
      async remove({ origins }) {
        for (const origin of origins) granted.delete(origin);
        this.onRemoved.emit({ origins });
        return true;
      }
    },
    scripting: {
      async getRegisteredContentScripts() { return structuredClone([...scripts.values()]); },
      async registerContentScripts(entries) { for (const entry of entries) scripts.set(entry.id, structuredClone(entry)); },
      async updateContentScripts(entries) { for (const entry of entries) Object.assign(scripts.get(entry.id), structuredClone(entry)); },
      async unregisterContentScripts({ ids }) { for (const id of ids) scripts.delete(id); }
    },
    runtime: {
      id: "test", getURL: path => `${base}${path}`,
      onInstalled: event(), onStartup: event(), onMessage: event(),
      async openOptionsPage() {}
    },
    action: { onClicked: event() },
    alarms: {
      onAlarm: event(),
      async get(name) { return alarms.get(name); },
      async create(name, value) { alarms.set(name, value); },
      async clear(name) { return alarms.delete(name); }
    },
    webNavigation,
    windows: {
      onFocusChanged: event(),
      async get(id) {
        if (!windows.has(id)) throw new Error("No window");
        return structuredClone(windows.get(id));
      }
    },
    tabs: {
      onCreated: event(),
      onRemoved: event(),
      onActivated: event(),
      async create({ url }) { created.push({ url }); return { id: 500, url }; },
      async query() { return structuredClone([...tabs.values()]); },
      async get(id) {
        if (!tabs.has(id)) throw new Error("No tab");
        const tab = structuredClone(tabs.get(id));
        if (tab.url.startsWith(base)) delete tab.url;
        return tab;
      },
      async sendMessage(id, message, options) { notifications.push({ id, message, options }); },
      async update(id, { url, muted }) {
        if (muted !== undefined) {
          if (!tabs.has(id)) throw new Error("No tab");
          tabs.get(id).mutedInfo = { muted, reason: "extension", extensionId: "test" };
          return structuredClone(tabs.get(id));
        }
        updates.push({ id, url, recordsAtUpdate: structuredClone(local.records) });
        if (rejectUpdates) throw new Error("Test navigation failure");
        if (!tabs.has(id)) throw new Error("No tab");
        const tab = tabs.get(id);
        if (initial.sameDocumentGateUpdates && tab.url.startsWith(base) &&
            tab.url.split("#")[0] === url.split("#")[0]) {
          tab.url = url;
          webNavigation.onReferenceFragmentUpdated.emit({ tabId: id, frameId: 0, url, documentId: tab.documentId });
          return structuredClone(tab);
        }
        tab.url = url;
        tab.documentId = `document-${++document}`;
        webNavigation.onCommitted.emit({ tabId: id, frameId: 0, url, documentId: tab.documentId });
        return structuredClone(tab);
      },
      async remove(id) {
        removed.push(id);
        tabs.delete(id);
        chrome.tabs.onRemoved.emit(id);
      }
    }
  };
  globalThis.chrome = chrome;
  await import(`../background.js?test=${++instance}`);
  function sender(id = 42) {
    const tab = tabs.get(id);
    return {
      id: "test", tab: structuredClone(tab), url: tab.url,
      frameId: 0, documentId: tab.documentId, documentLifecycle: "active"
    };
  }
  function send(message, from = { id: "test", frameId: 0, url: `${base}journal.html` }) {
    return new Promise(resolve => chrome.runtime.onMessage.emit(message, from, resolve));
  }
  async function drain() {
    await send({ type: "journal" });
    await send({ type: "journal" });
  }
  async function navigate(url) {
    const tab = tabs.get(42);
    tab.url = url;
    tab.documentId = `document-${++document}`;
    webNavigation.onBeforeNavigate.emit({ tabId: 42, frameId: 0, url });
    webNavigation.onCommitted.emit({ tabId: 42, frameId: 0, url, documentId: tab.documentId });
    await drain();
  }
  await drain();
  return {
    local, session, tabs, windows, updates, removed, notifications, created, granted, scripts, chrome, sender, send, drain, navigate,
    failUpdates(value) { rejectUpdates = value; }
  };
}

test("the attempt is persisted before a failed confirmation navigation, and retry reuses it", async t => {
  const warning = t.mock.method(console, "warn", () => {});
  const h = await harness();
  h.failUpdates(true);
  await h.navigate("https://www.douyin.com/");
  assert.equal(h.updates[0].recordsAtUpdate[0].outcome, "pending");
  assert.equal(h.local.records.length, 1);
  assert.equal(h.local.records[0].outcome, "navigation_error");
  h.failUpdates(false);
  h.chrome.webNavigation.onCompleted.emit({ tabId: 42, frameId: 0, url: "https://www.douyin.com/" });
  await h.drain();
  assert.equal(h.local.records.length, 1);
  assert.equal(h.local.records[0].outcome, "pending");
  assert.ok(h.tabs.get(42).url.startsWith(`${base}pause.html#`));
  assert.equal(warning.mock.callCount(), 1);
});

test("a confirmation document load error is visible in the existing record", async () => {
  const h = await harness();
  await h.navigate("https://www.douyin.com/");
  h.chrome.webNavigation.onErrorOccurred.emit({
    tabId: 42, frameId: 0, url: h.tabs.get(42).url, error: "net::ERR_BLOCKED_BY_CLIENT"
  });
  await h.drain();
  assert.equal(h.local.records.length, 1);
  assert.equal(h.local.records[0].outcome, "navigation_error");
});

test("a newer destination invalidates an older queued block", async () => {
  const h = await harness();
  h.chrome.webNavigation.onBeforeNavigate.emit({ tabId: 42, frameId: 0, url: "https://www.douyin.com/" });
  h.chrome.webNavigation.onBeforeNavigate.emit({ tabId: 42, frameId: 0, url: "https://www.google.com/" });
  await h.drain();
  assert.equal(h.updates.length, 0);
  assert.equal(h.local.records.length, 0);
});

test("completion of an old document cannot supersede a newer navigation", async () => {
  const h = await harness();
  h.chrome.webNavigation.onBeforeNavigate.emit({ tabId: 42, frameId: 0, url: "https://www.google.com/" });
  h.chrome.webNavigation.onCompleted.emit({
    tabId: 42, frameId: 0, url: "https://www.douyin.com/", documentId: "old"
  });
  h.chrome.webNavigation.onHistoryStateUpdated.emit({
    tabId: 42, frameId: 0, url: "https://www.douyin.com/video/1", documentId: "old"
  });
  await h.drain();
  assert.equal(h.updates.length, 0);
  assert.equal(h.local.records.length, 0);
});

test("subframes and prerendered documents do not redirect the active tab", async () => {
  const h = await harness();
  h.chrome.webNavigation.onCommitted.emit({ tabId: 42, frameId: 1, url: "https://www.douyin.com/" });
  h.chrome.webNavigation.onCommitted.emit({
    tabId: 42, frameId: 0, url: "https://www.douyin.com/", documentLifecycle: "prerender"
  });
  await h.drain();
  assert.equal(h.updates.length, 0);
  assert.equal(h.local.records.length, 0);
});

test("confirmation can initialize with redacted tabs.get URLs and never duplicates the attempt", async () => {
  const h = await harness();
  await h.navigate("https://www.douyin.com/");
  assert.equal((await h.chrome.tabs.get(42)).url, undefined);
  const result = await h.send({ type: "inspect" }, h.sender());
  assert.equal(result.ok, true);
  assert.equal(result.data.site.id, "douyin");
  assert.equal(h.local.records.length, 1);
});

test("same-site navigation preserves the original deadline and rejects stale-document messages", async () => {
  const h = await harness();
  await h.navigate("https://www.douyin.com/");
  assert.equal((await h.send({ type: "continue", minutes: 5, reason: "test" }, h.sender())).ok, true);
  await h.drain();
  const stale = h.sender();
  const deadline = h.session.state.grants[42].expiresAt;
  await h.navigate("https://www.douyin.com/");
  const result = await h.send({ type: "timer" }, stale);
  assert.equal(result.data, null);
  assert.equal(h.session.state.grants[42].expiresAt, deadline);
  assert.equal(h.local.records.length, 1);
});

test("a delayed content message cannot pull the user back from another site", async () => {
  const h = await harness();
  await h.navigate("https://www.douyin.com/");
  await h.send({ type: "continue", minutes: 5, reason: "test" }, h.sender());
  await h.drain();
  const stale = h.sender();
  await h.navigate("https://www.google.com/");
  const count = h.updates.length;
  assert.equal((await h.send({ type: "timer" }, stale)).data, null);
  assert.equal(h.updates.length, count);
  assert.equal(h.tabs.get(42).url, "https://www.google.com/");
  assert.equal(h.local.records[0].outcome, "left");
});

test("expiry never closes a tab whose newer navigation is leaving the restricted site", async t => {
  let now = 100000;
  t.mock.method(Date, "now", () => now);
  const h = await harness();
  await h.navigate("https://www.douyin.com/");
  await h.send({ type: "continue", minutes: 0.1, reason: "test" }, h.sender());
  await h.drain();
  now += 7000;
  h.chrome.alarms.onAlarm.emit({ name: "expire:42" });
  h.chrome.webNavigation.onBeforeNavigate.emit({ tabId: 42, frameId: 0, url: "https://www.google.com/" });
  await h.drain();
  assert.equal(h.removed.length, 0);
  assert.equal(h.local.records[0].outcome, "expired");
  assert.equal(h.local.records[0].elapsedMs, 6000);
});

test("loss of browser-session state preserves history without inventing elapsed time", async () => {
  const h = await harness({ local: {
    settings: DEFAULT_SETTINGS,
    records: [{ id: "old", outcome: "active", startedAt: 1000, elapsedMs: 0 }]
  } });
  assert.equal(h.local.records[0].outcome, "interrupted");
  assert.equal(h.local.records[0].elapsedMs, null);
});

test("partially persisted session state cannot retain a grant without its record", async () => {
  const h = await harness({ session: { state: {
    grants: { 42: { tabId: 42, siteId: "douyin", recordId: "missing", startedAt: 1000, expiresAt: Date.now() + 60000 } },
    pending: { 42: { target: "https://www.douyin.com/", recordId: "also-missing" } }
  } } });
  assert.deepEqual(h.session.state.grants, {});
  assert.deepEqual(h.session.state.pending, {});
  assert.equal(h.local.records.length, 0);
});

test("startup expiry closes the old tab without creating a phantom new attempt", async t => {
  t.mock.method(Date, "now", () => 8000);
  const h = await harness({
    tabs: [{ id: 42, url: "https://www.douyin.com/", documentId: "old" }],
    local: { settings: { ...DEFAULT_SETTINGS, expiryAction: "close" },
      records: [{ id: "expired", outcome: "active", startedAt: 1000, elapsedMs: 0 }] },
    session: { state: {
      grants: { 42: { tabId: 42, siteId: "douyin", recordId: "expired", startedAt: 1000, expiresAt: 7000 } },
      pending: {}
    } }
  });
  assert.deepEqual(h.removed, [42]);
  assert.equal(h.local.records.length, 1);
  assert.equal(h.local.records[0].outcome, "expired");
  assert.deepEqual(h.session.state.pending, {});
});

test("a content-script fallback records the attempt before opening confirmation", async () => {
  const h = await harness();
  h.tabs.get(42).url = "https://www.bilibili.com/video/test";
  assert.equal((await h.send({ type: "timer" }, h.sender())).ok, true);
  await h.drain();
  assert.equal(h.local.records.length, 1);
  assert.equal(h.updates[0].recordsAtUpdate[0].siteId, "bilibili");
});

test("a replaced tab ends the old grant and checks the replacement independently", async () => {
  const h = await harness();
  await h.navigate("https://www.douyin.com/");
  await h.send({ type: "continue", minutes: 5, reason: "test" }, h.sender());
  await h.drain();
  h.tabs.delete(42);
  h.tabs.set(43, { id: 43, url: "https://www.bilibili.com/", documentId: "replacement" });
  h.chrome.webNavigation.onTabReplaced.emit({ tabId: 43, replacedTabId: 42 });
  await h.drain();
  await h.drain();
  assert.equal(h.local.records[0].outcome, "left");
  assert.equal(h.local.records[1].siteId, "bilibili");
  assert.deepEqual(h.session.state.grants, {});
  assert.ok(h.tabs.get(43).url.startsWith(`${base}pause.html#`));
});

test("related tabs share one record and deadline; closing the parent leaves the child active", async () => {
  const h = await harness();
  await h.navigate("https://www.douyin.com/");
  await h.send({ type: "continue", minutes: 5, reason: "research" }, h.sender());
  await h.drain();
  const deadline = h.session.state.grants[42].expiresAt;
  h.tabs.set(43, { id: 43, openerTabId: 42, url: "https://www.douyin.com/video/1" });
  h.chrome.webNavigation.onCreatedNavigationTarget.emit({ tabId: 43, sourceTabId: 42, url: h.tabs.get(43).url });
  h.chrome.webNavigation.onBeforeNavigate.emit({ tabId: 43, frameId: 0, url: h.tabs.get(43).url });
  await h.drain();
  assert.equal(h.session.state.grants[43].expiresAt, deadline);
  assert.equal(h.local.records.length, 1);
  await h.chrome.tabs.remove(42);
  await h.drain();
  assert.equal(h.local.records[0].outcome, "active");
  await h.chrome.tabs.remove(43);
  await h.drain();
  assert.equal(h.local.records[0].outcome, "closed");
});

test("late target creation repairs a pending child without duplicating the visit", async () => {
  const h = await harness();
  await h.navigate("https://www.douyin.com/");
  await h.send({ type: "continue", minutes: 5, reason: "research" }, h.sender());
  await h.drain();
  h.tabs.set(43, { id: 43, url: "https://www.douyin.com/video/1" });
  h.chrome.webNavigation.onBeforeNavigate.emit({ tabId: 43, frameId: 0, url: h.tabs.get(43).url });
  await h.drain();
  assert.equal(h.local.records.length, 2);
  h.chrome.webNavigation.onCreatedNavigationTarget.emit({
    tabId: 43, sourceTabId: 42, url: "https://www.douyin.com/video/1"
  });
  await h.drain();
  assert.equal(h.tabs.get(43).url, "https://www.douyin.com/video/1");
  assert.equal(h.local.records.length, 1);
  assert.equal(h.session.state.grants[43].recordId, h.session.state.grants[42].recordId);
});

test("cross-site children and expired parents do not grant access", async t => {
  let now = 100000;
  t.mock.method(Date, "now", () => now);
  const h = await harness();
  await h.navigate("https://www.douyin.com/");
  await h.send({ type: "continue", minutes: 0.1, reason: "research" }, h.sender());
  await h.drain();
  for (const [id, url] of [[43, "https://www.bilibili.com/"], [44, "https://www.douyin.com/"]]) {
    if (id === 44) now += 7000;
    h.tabs.set(id, { id, openerTabId: 42, url });
    h.chrome.webNavigation.onCreatedNavigationTarget.emit({ tabId: id, sourceTabId: 42, url });
    h.chrome.webNavigation.onBeforeNavigate.emit({ tabId: id, frameId: 0, url });
    await h.drain();
    assert.equal(h.session.state.grants[id], undefined);
    assert.ok(h.tabs.get(id).url.startsWith(`${base}pause.html#`));
  }
});

test("expiry closes all related tabs with a single elapsed-time record", async t => {
  let now = 100000;
  t.mock.method(Date, "now", () => now);
  const h = await harness({ local: { settings: { ...DEFAULT_SETTINGS, expiryAction: "close" } } });
  await h.navigate("https://www.douyin.com/");
  await h.send({ type: "continue", minutes: 0.1, reason: "research" }, h.sender());
  await h.drain();
  h.tabs.set(43, { id: 43, openerTabId: 42, url: "https://www.douyin.com/video/1" });
  h.chrome.webNavigation.onCreatedNavigationTarget.emit({ tabId: 43, sourceTabId: 42, url: h.tabs.get(43).url });
  await h.drain();
  now += 7000;
  h.chrome.alarms.onAlarm.emit({ name: "expire:42" });
  await h.drain();
  assert.deepEqual(h.removed, [42, 43]);
  assert.equal(h.local.records.length, 1);
  assert.equal(h.local.records[0].elapsedMs, 6000);
  assert.equal(h.local.records[0].outcome, "expired");
});

test("worker recovery keeps the shared record active when only the child survives", async () => {
  const grant = { siteId: "douyin", recordId: "shared", startedAt: Date.now() - 1000, expiresAt: Date.now() + 60000 };
  const h = await harness({
    tabs: [{ id: 43, url: "https://www.douyin.com/video/child" }],
    local: { records: [{ id: "shared", outcome: "active", startedAt: grant.startedAt }] },
    session: { state: { grants: { 42: { ...grant, tabId: 42 }, 43: { ...grant, tabId: 43 } }, pending: {} } }
  });
  assert.equal(h.local.records.length, 1);
  assert.equal(h.local.records[0].outcome, "active");
  assert.equal(h.session.state.grants[43].expiresAt, grant.expiresAt);
  assert.equal(h.session.state.grants[42], undefined);
});

test("same-document SPA messages can save layout, but invalid preferences are rejected", async t => {
  t.mock.method(console, "error", () => {});
  const h = await harness();
  await h.navigate("https://www.douyin.com/");
  await h.send({ type: "continue", minutes: 5, reason: "research" }, h.sender());
  await h.drain();
  const original = h.sender();
  h.tabs.get(42).url = "https://www.douyin.com/video/spa";
  h.chrome.webNavigation.onHistoryStateUpdated.emit({
    tabId: 42, frameId: 0, url: h.tabs.get(42).url, documentId: original.documentId
  });
  await h.drain();
  const layout = { x: 0.2, y: 0.8, collapsed: true };
  assert.equal((await h.send({ type: "timerLayout", layout }, original)).ok, true);
  assert.deepEqual(h.local.timerLayout, layout);
  assert.equal((await h.send({ type: "timerLayout", layout: { x: NaN } }, original)).ok, false);
  assert.deepEqual(h.local.timerLayout, layout);
});

test("a blank child loses inheritance after visiting an unrelated site", async () => {
  const h = await harness();
  await h.navigate("https://www.douyin.com/");
  await h.send({ type: "continue", minutes: 5, reason: "research" }, h.sender());
  await h.drain();
  h.tabs.set(43, { id: 43, url: "about:blank" });
  h.chrome.webNavigation.onCreatedNavigationTarget.emit({ tabId: 43, sourceTabId: 42, url: "about:blank" });
  await h.drain();
  assert.ok(h.session.state.sources[43]);
  for (const url of ["https://www.google.com/", "https://www.douyin.com/"]) {
    h.tabs.get(43).url = url;
    h.chrome.webNavigation.onBeforeNavigate.emit({ tabId: 43, frameId: 0, url });
    await h.drain();
  }
  assert.equal(h.session.state.grants[43], undefined);
  assert.ok(h.tabs.get(43).url.startsWith(`${base}pause.html#`));
});

const syncConfig = {
  enabled: true, url: "https://dav.example.test/back-to-flow/",
  username: "test", password: "test-only-secret", syncRecords: true
};

test("sync credentials are hidden from the journal and rejected from content messages", async t => {
  t.mock.method(console, "error", () => {});
  const h = await harness();
  assert.equal((await h.send({ type: "syncSave", config: syncConfig })).ok, true);
  assert.equal(h.local.syncConfig.password, syncConfig.password);
  const view = await h.send({ type: "syncStatus" });
  assert.equal(view.data.config.passwordSaved, true);
  assert.ok(!JSON.stringify(view).includes(syncConfig.password));
  assert.ok(!JSON.stringify(await h.send({ type: "journal" })).includes(syncConfig.password));
  h.tabs.get(42).url = "https://www.douyin.com/";
  assert.equal((await h.send({ type: "syncStatus" }, h.sender())).ok, false);
  assert.equal((await h.send({ type: "syncNow" }, h.sender())).ok, false);
  assert.equal((await h.send({ type: "syncSave", config: { ...syncConfig, password: "" } })).ok, true);
  assert.equal(h.local.syncConfig.password, syncConfig.password);
  await h.send({ type: "syncForget" });
  assert.equal(h.local.syncConfig.password, "");
});

test("sync applies settings and finished records without publishing active grants", async t => {
  const dav = createDav();
  t.mock.method(globalThis, "fetch", dav.fetcher);
  const h = await harness();
  await h.navigate("https://www.douyin.com/");
  await h.send({ type: "continue", minutes: 5, reason: "local active" }, h.sender());
  await h.drain();
  await h.send({ type: "syncSave", config: syncConfig });
  const finished = { id: "remote-record", siteId: "bilibili", siteName: "哔哩哔哩", attemptedAt: 1000, startedAt: null, endedAt: 2000, plannedMs: 0, elapsedMs: 0, reason: "", outcome: "declined" };
  dav.files.set(`${syncConfig.url}devices-v2/device-remote.json`, JSON.stringify({
    app: "back-to-flow", schemaVersion: 2,
    settings: { revision: { at: Date.now(), device: "remote" }, value: { ...DEFAULT_SETTINGS, quote: "Synced setting" } },
    records: [finished], deletedIds: []
  }));
  assert.equal((await h.send({ type: "syncNow" })).ok, true);
  assert.equal(h.local.settings.quote, "Synced setting");
  assert.equal(h.local.records.length, 2);
  assert.equal(h.session.state.grants[42].recordId, h.local.records.find(record => record.outcome === "active").id);
  const uploaded = JSON.parse([...dav.files.entries()].find(([url]) => !url.endsWith("device-remote.json"))[1]);
  assert.deepEqual(uploaded.records, [finished]);
  assert.ok(!JSON.stringify(uploaded).includes(syncConfig.password));
  await h.send({ type: "clear" });
  assert.deepEqual(h.local.syncMeta.deletedIds, ["remote-record"]);
  assert.equal(h.local.records[0].outcome, "active");
  await h.send({ type: "syncNow" });
  assert.equal(h.local.records.length, 1);
  const revision = h.local.syncMeta.settingsRevision.at;
  assert.equal((await h.send({ type: "restoreSettings" })).ok, true);
  assert.equal(h.local.settings.quote, DEFAULT_SETTINGS.quote);
  assert.ok(h.local.syncMeta.settingsRevision.at > revision);
});

test("an in-flight network request does not block expiry or overwrite later local edits", async t => {
  const dav = createDav();
  let release;
  let started;
  const firstRequest = new Promise(resolve => { started = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  let first = true;
  t.mock.method(globalThis, "fetch", async (...args) => {
    if (first) { first = false; started(); await barrier; }
    return dav.fetcher(...args);
  });
  let now = 100000;
  t.mock.method(Date, "now", () => now);
  const h = await harness({ local: { settings: { ...DEFAULT_SETTINGS, expiryAction: "close" } } });
  await h.navigate("https://www.douyin.com/");
  await h.send({ type: "continue", minutes: 0.1, reason: "expiry" }, h.sender());
  await h.drain();
  await h.send({ type: "syncSave", config: syncConfig });
  const pendingSync = h.send({ type: "syncNow" });
  await firstRequest;
  now += 7000;
  h.chrome.alarms.onAlarm.emit({ name: "expire:42" });
  await h.drain();
  assert.deepEqual(h.removed, [42]);
  await h.send({ type: "settings", settings: { ...DEFAULT_SETTINGS, quote: "Edited during fetch" } });
  release();
  assert.equal((await pendingSync).ok, true);
  assert.equal(h.local.settings.quote, "Edited during fetch");
  assert.equal(h.local.records[0].outcome, "expired");
});

test("site toggles are persisted and disabling a site releases existing grants", async () => {
  const h = await harness();
  await h.navigate("https://www.douyin.com/");
  await h.send({ type: "continue", minutes: 5, reason: "test" }, h.sender());
  await h.drain();
  await h.send({ type: "settings", settings: { ...DEFAULT_SETTINGS, enabledSites: ["bilibili"] } });
  assert.deepEqual(h.session.state.grants, {});
  assert.equal(h.local.records[0].outcome, "left");
  assert.deepEqual((await h.send({ type: "timer" }, h.sender())).data, { inactive: true });
  await h.navigate("https://www.douyin.com/video/next");
  assert.equal(h.local.records.length, 1);
  await h.navigate("https://www.bilibili.com/");
  assert.equal(h.local.records.length, 2);
  await h.send({ type: "settings", settings: { ...DEFAULT_SETTINGS, enabledSites: [] } });
  await h.drain();
  assert.equal(h.tabs.get(42).url, "https://www.bilibili.com/");
  assert.deepEqual(h.session.state.pending, {});
});

test("record opt-out keeps local records and clear markers away from WebDAV", async t => {
  const dav = createDav();
  t.mock.method(globalThis, "fetch", dav.fetcher);
  const h = await harness();
  await h.navigate("https://www.douyin.com/");
  await h.send({ type: "leave" }, h.sender());
  await h.drain();
  await h.send({ type: "syncSave", config: { ...syncConfig, syncRecords: false } });
  assert.equal((await h.send({ type: "syncNow" })).ok, true);
  assert.equal(h.local.records.length, 1);
  assert.equal(JSON.parse([...dav.files.values()][0]).records.length, 0);
  await h.send({ type: "clear" });
  await h.send({ type: "syncNow" });
  assert.equal(JSON.parse([...dav.files.values()][0]).deletedIds.length, 0);
});

test("changing connection while syncing cancels old results without applying remote settings", async t => {
  const dav = createDav();
  let release;
  let started;
  const firstRequest = new Promise(resolve => { started = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  t.mock.method(globalThis, "fetch", async (...args) => {
    started();
    await barrier;
    return dav.fetcher(...args);
  });
  const h = await harness();
  await h.send({ type: "syncSave", config: syncConfig });
  const syncing = h.send({ type: "syncNow" });
  await firstRequest;
  await h.send({ type: "syncForget" });
  release();
  assert.equal((await syncing).ok, false);
  assert.equal(h.local.syncConfig.enabled, false);
  assert.equal(h.local.syncMeta.lastError, "");
  assert.equal(dav.files.size, 0);
});

test("missing optional host permission prevents sync without issuing a request", async t => {
  t.mock.method(console, "error", () => {});
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("Must not fetch"); });
  const h = await harness();
  await h.send({ type: "syncSave", config: syncConfig });
  h.chrome.permissions.contains = async () => false;
  const response = await h.send({ type: "syncNow" });
  assert.equal(response.ok, false);
  assert.match(response.error, /权限/);
  assert.equal(fetch.mock.callCount(), 0);
});

test("legacy settings are seeded above fresh defaults and sync remains opt-in", async () => {
  const h = await harness({ local: { settings: { ...DEFAULT_SETTINGS, enabledSites: undefined, quote: "Legacy quote" } } });
  assert.equal(h.local.syncMeta.settingsRevision.at, 1);
  assert.equal(h.local.settings.quote, "Legacy quote");
  assert.deepEqual(h.local.settings.enabledSites, DEFAULT_SETTINGS.enabledSites);
  assert.equal((await h.send({ type: "syncStatus" })).data.config.enabled, false);
});

test("foreground observations stop on background activation, window blur and long heartbeat gaps", async t => {
  let now = 100000;
  t.mock.method(Date, "now", () => now);
  const h = await harness();
  await h.navigate("https://www.douyin.com/");
  await h.send({ type: "continue", minutes: 60, reason: "reading" }, h.sender());
  await h.drain();
  const sample = () => h.send({ type: "timer", foreground: true }, h.sender());
  await sample();
  now += 5000;
  await sample();
  assert.equal(h.session.state.attention.snapshot.foregroundMs, 5000);
  now += 2000;
  h.tabs.get(42).active = false;
  h.chrome.tabs.onActivated.emit({ tabId: 99, windowId: 1 });
  await h.drain();
  assert.equal(h.local.records[0].foregroundMs, 7000);
  now += 600000;
  await sample();
  assert.equal(h.local.records[0].foregroundMs, 7000);
  h.tabs.get(42).active = true;
  await sample();
  now += 3000;
  h.windows.get(1).focused = false;
  h.chrome.windows.onFocusChanged.emit(-1);
  await h.drain();
  now += 10000;
  await sample();
  assert.equal(h.local.records[0].foregroundMs, 10000);
  h.windows.get(1).focused = true;
  await sample();
  now += 600000;
  await sample();
  assert.equal(h.local.records[0].foregroundMs, 10000);
  now += 5000;
  await sample();
  assert.equal(h.session.state.attention.snapshot.foregroundMs, 15000);
});

test("a hidden document cannot claim foreground time and background siblings do not double count", async t => {
  let now = 100000;
  t.mock.method(Date, "now", () => now);
  const h = await harness();
  await h.navigate("https://www.douyin.com/");
  await h.send({ type: "continue", minutes: 5, reason: "test" }, h.sender());
  await h.drain();
  await h.send({ type: "timer", foreground: true }, h.sender());
  h.tabs.set(43, { id: 43, active: false, windowId: 1, url: "https://www.douyin.com/child" });
  h.chrome.webNavigation.onCreatedNavigationTarget.emit({ tabId: 43, sourceTabId: 42, url: h.tabs.get(43).url });
  await h.drain();
  now += 5000;
  await h.send({ type: "timer", foreground: true }, h.sender(43));
  await h.send({ type: "timer", foreground: true }, h.sender());
  assert.equal(h.session.state.attention.snapshot.foregroundMs, 5000);
  now += 1000;
  await h.send({ type: "timer", foreground: false }, h.sender());
  now += 5000;
  await h.send({ type: "timer", foreground: false }, h.sender());
  assert.equal(h.local.records[0].foregroundMs, 6000);
});

test("ending a linked visit requires confirmation and never closes an independently granted tab", async () => {
  const h = await harness();
  await h.navigate("https://www.douyin.com/");
  await h.send({ type: "continue", minutes: 5, reason: "test" }, h.sender());
  await h.drain();
  h.tabs.set(43, { id: 43, windowId: 1, url: "https://www.douyin.com/child" });
  h.chrome.webNavigation.onCreatedNavigationTarget.emit({ tabId: 43, sourceTabId: 42, url: h.tabs.get(43).url });
  await h.drain();
  const response = await h.send({ type: "endVisit" }, h.sender());
  assert.equal(response.data.confirmationRequired, true);
  assert.equal(response.data.tabCount, 2);
  assert.equal(h.removed.length, 0);
  h.tabs.set(44, { id: 44, windowId: 1, url: "https://www.google.com/" });
  const finished = await h.send({ type: "endVisit", confirmedTabs: 2 }, h.sender());
  assert.equal(finished.data.ended, true);
  await h.drain();
  assert.deepEqual(h.removed, [42, 43]);
  assert.ok(h.tabs.has(44));
  assert.equal(h.local.records[0].finishIntent, "done");
  assert.equal(h.local.records[0].outcome, "left");
});

test("stale end-visit messages cannot close a tab that has navigated elsewhere", async () => {
  const h = await harness();
  await h.navigate("https://www.douyin.com/");
  await h.send({ type: "continue", minutes: 5, reason: "test" }, h.sender());
  await h.drain();
  const stale = h.sender();
  h.chrome.webNavigation.onBeforeNavigate.emit({ tabId: 42, frameId: 0, url: "https://www.google.com/" });
  await h.send({ type: "endVisit" }, stale);
  await h.drain();
  assert.equal(h.removed.length, 0);
  assert.equal(h.local.records[0].finishIntent, undefined);
});

test("worker recovery restores the latest foreground checkpoint from session memory", async () => {
  const startedAt = Date.now() - 10000;
  const key = new Date(startedAt).toLocaleDateString("en-CA");
  const h = await harness({
    tabs: [{ id: 42, url: "https://www.douyin.com/" }],
    local: { records: [{
      id: "observed", siteId: "douyin", siteName: "抖音", attemptedAt: startedAt, startedAt,
      endedAt: null, plannedMs: 60000, elapsedMs: 0, reason: "test", outcome: "active",
      activityVersion: 1, foregroundMs: 0, foregroundByDay: {}
    }] },
    session: { state: {
      grants: { 42: { tabId: 42, siteId: "douyin", recordId: "observed", startedAt, expiresAt: startedAt + 60000 } },
      pending: {},
      attention: { tabId: 42, recordId: "observed", at: startedAt + 5000, snapshot: {
        foregroundMs: 5000, foregroundByDay: { [key]: 5000 }
      } }
    } }
  });
  assert.equal(h.local.records[0].foregroundMs, 5000);
  assert.equal(h.local.records[0].foregroundByDay[key], 5000);
});

test("default expiry retains the document, ends the record once, and pauses the linked group", async t => {
  let now = 100000;
  t.mock.method(Date, "now", () => now);
  const h = await harness();
  await h.navigate("https://www.douyin.com/");
  await h.send({ type: "continue", minutes: 0.1, reason: "unfinished draft" }, h.sender());
  await h.drain();
  const documentId = h.sender().documentId;
  h.tabs.set(43, { id: 43, windowId: 1, url: "https://www.douyin.com/child", mutedInfo: { muted: true, reason: "user" } });
  h.chrome.webNavigation.onCreatedNavigationTarget.emit({ tabId: 43, sourceTabId: 42, url: h.tabs.get(43).url });
  await h.drain();
  const updateCount = h.updates.length;
  now += 7000;
  h.chrome.alarms.onAlarm.emit({ name: "expire:42" });
  await h.drain();
  assert.equal(h.updates.length, updateCount);
  assert.equal(h.sender().documentId, documentId);
  assert.deepEqual(h.removed, []);
  assert.deepEqual(h.session.state.grants, {});
  assert.equal(h.local.records.length, 1);
  assert.equal(h.local.records[0].outcome, "expired");
  assert.equal(h.local.records[0].elapsedMs, 6000);
  assert.deepEqual(Object.keys(h.session.state.paused), ["42", "43"]);
  assert.equal(h.tabs.get(42).mutedInfo.muted, true);
  assert.equal(h.tabs.get(43).mutedInfo.reason, "user");
  assert.equal(h.notifications.length, 2);
  assert.equal((await h.send({ type: "timer", foreground: true }, h.sender())).data.paused, true);
  assert.equal(h.local.records.length, 1);
  assert.equal(h.session.state.attention, undefined);
});

test("saving content resumes only the chosen tab for two measured minutes without navigation", async t => {
  let now = 100000;
  t.mock.method(Date, "now", () => now);
  const h = await harness();
  await h.navigate("https://www.douyin.com/");
  await h.send({ type: "continue", minutes: 0.1, reason: "draft" }, h.sender());
  await h.drain();
  h.tabs.set(43, { id: 43, url: "https://www.douyin.com/child" });
  h.chrome.webNavigation.onCreatedNavigationTarget.emit({ tabId: 43, sourceTabId: 42, url: h.tabs.get(43).url });
  await h.drain();
  now += 7000;
  h.chrome.alarms.onAlarm.emit({ name: "expire:42" });
  await h.drain();
  const recordId = h.session.state.paused[42].recordId;
  const updateCount = h.updates.length;
  const response = await h.send({ type: "resumeVisit", recordId, recovery: true }, h.sender());
  assert.equal(response.ok, true);
  assert.equal(response.data.expiresAt, now + 120000);
  assert.equal(response.data.expiryAction, "pause");
  assert.equal(h.updates.length, updateCount);
  assert.equal(h.session.state.paused[42], undefined);
  assert.ok(h.session.state.paused[43]);
  assert.deepEqual(Object.keys(h.session.state.grants), ["42"]);
  assert.equal(h.tabs.get(42).mutedInfo.muted, false);
  assert.equal(h.local.records.length, 2);
  assert.equal(h.local.records[1].reason, "保存当前页面内容");
  assert.equal(h.local.records[1].plannedMs, 120000);
  await h.send({ type: "timer", foreground: true }, h.sender());
  now += 5000;
  await h.send({ type: "timer", foreground: true }, h.sender());
  assert.equal(h.session.state.attention.snapshot.foregroundMs, 5000);
});

test("paused records can be cleared; explicit resumption still validates purpose and retains original user mute", async t => {
  let now = 100000;
  t.mock.method(Date, "now", () => now);
  t.mock.method(console, "error", () => {});
  const h = await harness();
  await h.navigate("https://www.douyin.com/");
  await h.send({ type: "continue", minutes: 0.1, reason: "test" }, h.sender());
  await h.drain();
  h.tabs.get(42).mutedInfo = { muted: true, reason: "user" };
  now += 7000;
  await h.send({ type: "expire" }, h.sender());
  const recordId = h.session.state.paused[42].recordId;
  await h.send({ type: "clear" });
  assert.equal(h.local.records.length, 0);
  assert.equal((await h.send({ type: "resumeVisit", recordId, minutes: 5, reason: "" }, h.sender())).ok, false);
  assert.equal((await h.send({ type: "resumeVisit", recordId: "old", minutes: 5, reason: "new" }, h.sender())).ok, false);
  assert.equal(h.local.records.length, 0);
  const resumed = await h.send({ type: "resumeVisit", recordId, minutes: 5, reason: "new" }, h.sender());
  assert.equal(resumed.ok, true);
  assert.deepEqual(h.tabs.get(42).mutedInfo, { muted: true, reason: "user" });
  assert.equal(h.local.records.length, 1);
});

test("stale paused-page commands cannot resume or close a new destination", async t => {
  let now = 100000;
  t.mock.method(Date, "now", () => now);
  const h = await harness();
  await h.navigate("https://www.douyin.com/");
  await h.send({ type: "continue", minutes: 0.1, reason: "test" }, h.sender());
  await h.drain();
  now += 7000;
  await h.send({ type: "expire" }, h.sender());
  const stale = h.sender();
  const recordId = h.session.state.paused[42].recordId;
  h.chrome.webNavigation.onBeforeNavigate.emit({ tabId: 42, frameId: 0, url: "https://www.google.com/" });
  await h.send({ type: "resumeVisit", recordId, recovery: true }, stale);
  await h.send({ type: "endVisit", recordId }, stale);
  await h.drain();
  assert.equal(h.local.records.length, 1);
  assert.deepEqual(h.session.state.grants, {});
  assert.deepEqual(h.session.state.paused, {});
  assert.deepEqual(h.removed, []);
  assert.equal(h.tabs.get(42).mutedInfo.muted, false);
});

test("closing an expired group requires confirmation and does not count as an early stop", async t => {
  let now = 100000;
  t.mock.method(Date, "now", () => now);
  const h = await harness();
  await h.navigate("https://www.douyin.com/");
  await h.send({ type: "continue", minutes: 0.1, reason: "test" }, h.sender());
  await h.drain();
  h.tabs.set(43, { id: 43, url: "https://www.douyin.com/child" });
  h.chrome.webNavigation.onCreatedNavigationTarget.emit({ tabId: 43, sourceTabId: 42, url: h.tabs.get(43).url });
  await h.drain();
  h.tabs.set(44, { id: 44, url: "https://www.google.com/" });
  now += 7000;
  await h.send({ type: "expire" }, h.sender());
  const recordId = h.session.state.paused[42].recordId;
  const confirmation = await h.send({ type: "endVisit", recordId }, h.sender());
  assert.equal(confirmation.data.tabCount, 2);
  assert.deepEqual(h.removed, []);
  await h.send({ type: "endVisit", recordId, confirmedTabs: 2 }, h.sender());
  assert.deepEqual(h.removed, [42, 43]);
  assert.ok(h.tabs.has(44));
  assert.equal(h.local.records[0].outcome, "expired");
  assert.equal(h.local.records[0].finishIntent, undefined);
});

test("worker recovery preserves a paused page and does not create a fresh attempt", async () => {
  const paused = { siteId: "douyin", recordId: "expired", reason: "draft", plannedMs: 6000, documentId: "same", mutedByUs: true };
  const h = await harness({
    tabs: [{ id: 42, url: "https://www.douyin.com/", documentId: "same", mutedInfo: { muted: true, reason: "extension", extensionId: "test" } }],
    local: { records: [{ id: "expired", outcome: "expired", startedAt: 1000, elapsedMs: 6000 }] },
    session: { state: { grants: {}, pending: {}, paused: { 42: paused } } }
  });
  assert.equal(h.updates.length, 0);
  assert.equal(h.local.records.length, 1);
  assert.equal((await h.send({ type: "timer" }, h.sender())).data.paused, true);
  await h.send({ type: "settings", settings: { ...DEFAULT_SETTINGS, enabledSites: [] } });
  assert.deepEqual(h.session.state.paused, {});
  assert.equal(h.tabs.get(42).mutedInfo.muted, false);
  assert.deepEqual((await h.send({ type: "timer" }, h.sender())).data, { inactive: true });
});

test("expiry preferences are latched at the start and cannot silently change an active visit", async t => {
  let now = 100000;
  t.mock.method(Date, "now", () => now);
  const h = await harness();
  await h.navigate("https://www.douyin.com/");
  await h.send({ type: "continue", minutes: 0.1, reason: "test" }, h.sender());
  await h.drain();
  await h.send({ type: "settings", settings: { ...DEFAULT_SETTINGS, expiryAction: "close" } });
  assert.equal((await h.send({ type: "timer" }, h.sender())).data.expiryAction, "pause");
  now += 7000;
  await h.send({ type: "expire" }, h.sender());
  assert.deepEqual(h.removed, []);
  assert.ok(h.session.state.paused[42]);
  const pausedId = h.session.state.paused[42].recordId;
  await h.send({ type: "resumeVisit", recordId: pausedId, minutes: 0.1, reason: "new interval" }, h.sender());
  now += 7000;
  await h.send({ type: "expire" }, h.sender());
  assert.deepEqual(h.removed, [42]);
});

test("lost session state releases only orphan muting owned by this extension", async () => {
  const h = await harness({ tabs: [
    { id: 42, url: "https://www.google.com/", mutedInfo: { muted: true, reason: "extension", extensionId: "test" } },
    { id: 43, url: "https://www.google.com/", mutedInfo: { muted: true, reason: "user" } },
    { id: 44, url: "https://www.google.com/", mutedInfo: { muted: true, reason: "extension", extensionId: "another" } }
  ] });
  assert.equal(h.tabs.get(42).mutedInfo.muted, false);
  assert.equal(h.tabs.get(43).mutedInfo.muted, true);
  assert.equal(h.tabs.get(44).mutedInfo.muted, true);
});

test("closing a paused group leaves a sibling with a newer same-site navigation intact", async t => {
  let now = 100000;
  t.mock.method(Date, "now", () => now);
  const h = await harness();
  await h.navigate("https://www.douyin.com/");
  await h.send({ type: "continue", minutes: 0.1, reason: "test" }, h.sender());
  await h.drain();
  h.tabs.set(43, { id: 43, url: "https://www.douyin.com/child" });
  h.chrome.webNavigation.onCreatedNavigationTarget.emit({ tabId: 43, sourceTabId: 42, url: h.tabs.get(43).url });
  await h.drain();
  now += 7000;
  await h.send({ type: "expire" }, h.sender());
  const recordId = h.session.state.paused[42].recordId;
  const closing = h.send({ type: "endVisit", recordId, confirmedTabs: 2 }, h.sender());
  h.chrome.webNavigation.onBeforeNavigate.emit({ tabId: 43, frameId: 0, url: "https://www.douyin.com/new-destination" });
  await closing;
  await h.drain();
  assert.deepEqual(h.removed, [42]);
  assert.ok(h.tabs.has(43));
});

test("fractional custom minutes produce integer-millisecond records before and after pause", async t => {
  let now = 100000;
  t.mock.method(Date, "now", () => now);
  const h = await harness();
  await h.navigate("https://www.douyin.com/");
  await h.send({ type: "continue", minutes: 0.123456, reason: "test" }, h.sender());
  await h.drain();
  assert.equal(h.local.records[0].plannedMs, 7407);
  await h.send({ type: "timer", foreground: true }, h.sender());
  now += 8000;
  await h.send({ type: "expire" }, h.sender());
  assert.equal(h.local.records[0].foregroundMs, 7407);
  const recordId = h.session.state.paused[42].recordId;
  await h.send({ type: "resumeVisit", recordId, minutes: 0.123456, reason: "again" }, h.sender());
  assert.equal(h.local.records[1].plannedMs, 7407);
});

test("fresh installation opens setup once and does not intervene before site selection", async () => {
  const h = await harness({ fresh: true, origins: [] });
  assert.deepEqual(h.local.settings.enabledSites, []);
  assert.equal(h.local.setupComplete, false);
  assert.equal(h.scripts.size, 0);
  h.chrome.runtime.onInstalled.emit({ reason: "install" });
  await h.drain();
  assert.deepEqual(h.created, [{ url: `${base}journal.html#sites` }]);
  await h.navigate("https://www.douyin.com/");
  assert.equal(h.local.records.length, 0);
  assert.equal(h.updates.length, 0);
  await h.send({ type: "siteSettings", rules: { ...DEFAULT_SETTINGS, enabledSites: [] } });
  assert.equal(h.local.setupComplete, true);
  h.chrome.runtime.onInstalled.emit({ reason: "update" });
  await h.drain();
  assert.equal(h.created.length, 1);
});

test("synced custom rules wait for this device's permission and register only their scoped host", async () => {
  const rules = { ...DEFAULT_SETTINGS, enabledSites: [], customSites: [
    { domain: "video.example.test", name: "Videos", enabled: true, includeSubdomains: false }
  ] };
  const h = await harness({ local: { settings: rules }, origins: [] });
  assert.equal((await h.send({ type: "siteStatus" })).data.sites.at(-1).granted, false);
  await h.navigate("https://video.example.test/");
  assert.equal(h.updates.length, 0);
  h.granted.add("*://video.example.test/*");
  h.chrome.permissions.onAdded.emit({});
  await h.drain();
  assert.deepEqual(h.scripts.get("flow-sites").matches, ["*://video.example.test/*"]);
  await h.navigate("https://video.example.test/watch");
  assert.ok(h.tabs.get(42).url.startsWith(`${base}pause.html#`));
  await h.send({ type: "continue", minutes: 5, reason: "custom" }, h.sender());
  await h.drain();
  assert.equal(h.local.records[0].siteId, "custom:video.example.test");
  const updates = h.updates.length;
  h.granted.delete("*://video.example.test/*");
  h.chrome.permissions.onRemoved.emit({});
  await h.drain();
  assert.deepEqual(h.session.state.grants, {});
  assert.equal(h.local.records[0].outcome, "left");
  assert.equal(h.updates.length, updates);
  assert.equal(h.removed.length, 0);
  assert.equal(h.scripts.size, 0);
});

test("SPA transitions into and out of exceptions use the live URL, never the injection URL", async () => {
  const h = await harness({ local: { settings: { ...DEFAULT_SETTINGS, exceptions: [
    { mode: "path", url: "https://www.douyin.com/learning" }
  ] } } });
  await h.navigate("https://www.douyin.com/");
  await h.send({ type: "continue", minutes: 5, reason: "learn" }, h.sender());
  await h.drain();
  const original = h.sender();
  h.tabs.get(42).url = "https://www.douyin.com/learning/video";
  h.chrome.webNavigation.onHistoryStateUpdated.emit({
    tabId: 42, frameId: 0, url: h.tabs.get(42).url, documentId: original.documentId
  });
  await h.drain();
  const updates = h.updates.length;
  assert.deepEqual((await h.send({ type: "timer" }, original)).data, { inactive: true });
  assert.equal(h.updates.length, updates);
  assert.equal(h.local.records[0].outcome, "left");
  h.tabs.get(42).url = "https://www.douyin.com/shorts";
  h.chrome.webNavigation.onHistoryStateUpdated.emit({
    tabId: 42, frameId: 0, url: h.tabs.get(42).url, documentId: original.documentId
  });
  await h.drain();
  assert.equal(h.tabs.get(42).url, `${base}pause.html#https://www.douyin.com/shorts`);
  assert.equal(h.local.records.length, 2);
});

test("adding an exception releases an active visit without closing or reloading its document", async () => {
  const h = await harness();
  await h.navigate("https://www.bilibili.com/list/ml123?bvid=one");
  await h.send({ type: "continue", minutes: 5, reason: "learn" }, h.sender());
  await h.drain();
  const document = h.sender().documentId;
  const updates = h.updates.length;
  await h.send({ type: "siteSettings", rules: { ...DEFAULT_SETTINGS,
    exceptions: [{ mode: "path", url: "https://www.bilibili.com/list/ml123" }] } });
  assert.equal(h.updates.length, updates);
  assert.equal(h.sender().documentId, document);
  assert.deepEqual(h.session.state.grants, {});
  assert.equal(h.removed.length, 0);
});

test("registration failure is visible and never leaves untimed automatic blocking enabled", async () => {
  const h = await harness();
  h.chrome.scripting.updateContentScripts = async () => { throw new Error("Test registration failure"); };
  const response = await h.send({ type: "siteSettings", rules: { ...DEFAULT_SETTINGS, enabledSites: ["douyin"] } });
  assert.match(response.data.siteStatus.error, /注册失败/);
  await h.navigate("https://www.douyin.com/");
  assert.equal(h.local.records.length, 0);
});

test("upgrading sync adopts modern rule settings even when the saved legacy revision is newer", async t => {
  const dav = createDav();
  t.mock.method(globalThis, "fetch", dav.fetcher);
  const h = await harness({ local: {
    settings: { ...DEFAULT_SETTINGS, quote: "old device edit" },
    syncMeta: { deviceId: "old", settingsRevision: { at: 1000, device: "old" } }, syncConfig
  } });
  const modern = { ...DEFAULT_SETTINGS, quote: "modern",
    customSites: [{ domain: "video.example.test", name: "Videos", enabled: true, includeSubdomains: true }] };
  dav.files.set(`${syncConfig.url}devices-v2/device-modern.json`, JSON.stringify({
    app: "back-to-flow", schemaVersion: 2, settings: { revision: { at: 10, device: "modern" }, value: modern },
    records: [], deletedIds: []
  }));
  assert.equal((await h.send({ type: "syncNow" })).ok, true);
  assert.equal(h.local.settings.customSites[0].domain, "video.example.test");
  assert.equal(h.local.settings.quote, "modern");
  assert.equal(h.local.syncMeta.settingsBackup.value.quote, "old device edit");
  assert.equal(h.local.syncMeta.legacySettings, false);
  assert.equal((await h.send({ type: "siteStatus" })).data.sites.at(-1).granted, false);
});

test("self-review requires trusted UI consent, persists separately, and is absent from DAV and journal exports", async t => {
  t.mock.method(console, "error", () => {});
  const dav = createDav();
  t.mock.method(globalThis, "fetch", dav.fetcher);
  const h = await harness({ local: { syncConfig } });
  await h.navigate("https://www.douyin.com/");
  await h.send({ type: "continue", minutes: 5, reason: "test" }, h.sender());
  await h.drain();
  assert.equal(h.local.selfReview, undefined);
  assert.equal((await h.send({ type: "reviewGet" }, h.sender())).ok, false);
  const configured = await h.send({ type: "reviewConfigure", revision: 0, enabled: true, consent: true, definition: "Private personal criterion" });
  assert.equal(configured.ok, true);
  const saved = await h.send({ type: "reviewSave", revision: configured.data.state.revision, report: {
    day: configured.data.today, unwantedMinutes: null, fit: "partly", protection: "yes", displacement: "unsure", interference: "some"
  } });
  assert.equal(saved.ok, true);
  assert.equal(h.local.selfReview.reports.length, 1);
  assert.equal((await h.send({ type: "journal" })).data.selfReview, undefined);
  assert.equal((await h.send({ type: "syncNow" })).ok, true);
  assert.ok([...dav.files.values()].every(text => !text.includes("Private personal criterion") && !text.includes("selfReview")));
  assert.equal((await h.send({ type: "reviewGet" })).data.state.reports.length, 1);
  await h.send({ type: "clear" });
  assert.equal(h.local.selfReview.reports.length, 1);
  await h.send({ type: "reviewErase", revision: saved.data.state.revision, confirmed: true });
  assert.equal(h.local.selfReview.reports.length, 0);
  assert.equal(h.local.records.length, 1);
  assert.equal(h.local.records[0].outcome, "active");
  assert.ok(h.session.state.grants[42]);
});

test("a damaged optional self-review store cannot disable site interception or lose its original data", async t => {
  t.mock.method(console, "error", () => {});
  const damaged = { schemaVersion: 999, privateData: "preserve" };
  const h = await harness({ local: { selfReview: damaged } });
  assert.equal((await h.send({ type: "reviewGet" })).ok, false);
  await h.navigate("https://www.douyin.com/");
  assert.ok(h.tabs.get(42).url.startsWith(`${base}pause.html#`));
  assert.deepEqual(h.local.selfReview, damaged);
});

test("a retargeted gate gets only a read-only reload hint; stale decisions and an intervening exit remain rejected", async t => {
  t.mock.method(console, "error", () => {});
  const h = await harness({ sameDocumentGateUpdates: true });
  await h.navigate("https://www.douyin.com/");
  const original = h.sender();
  const next = "https://www.bilibili.com/video/new#section";
  h.chrome.webNavigation.onBeforeNavigate.emit({ tabId: 42, frameId: 0, url: next });
  await h.drain();
  const pageUrl = `${base}pause.html#${next}`;
  assert.equal(h.tabs.get(42).url, pageUrl);
  assert.equal(h.sender().documentId, original.documentId);
  const records = structuredClone(h.local.records);
  assert.deepEqual((await h.send({ type: "inspect", pageUrl }, original)).data, { reload: true });
  assert.equal((await h.send({ type: "continue", pageUrl, minutes: 5, reason: "stale" }, original)).ok, false);
  assert.equal((await h.send({ type: "leave", pageUrl }, original)).ok, false);
  assert.deepEqual(h.local.records, records);
  assert.deepEqual(h.session.state.grants, {});
  h.chrome.webNavigation.onBeforeNavigate.emit({ tabId: 42, frameId: 0, url: "https://www.google.com/" });
  assert.equal((await h.send({ type: "inspect", pageUrl }, original)).ok, false);
  await h.drain();
  assert.equal(h.tabs.get(42).url, pageUrl);
});
