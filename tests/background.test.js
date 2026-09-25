import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../core.js";

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
  const local = structuredClone(initial.local || {});
  const session = structuredClone(initial.session || {});
  const tabs = new Map((initial.tabs || [{ id: 42, url: "about:blank", documentId: "initial" }])
    .map(tab => [tab.id, structuredClone(tab)]));
  const updates = [];
  const removed = [];
  let rejectUpdates = false;
  let document = 0;
  const area = data => ({
    async get(keys) {
      return structuredClone(Object.fromEntries(
        (Array.isArray(keys) ? keys : [keys]).map(key => [key, data[key]])));
    },
    async set(values) { Object.assign(data, structuredClone(values)); }
  });
  const webNavigation = Object.fromEntries([
    "onBeforeNavigate", "onCommitted", "onCompleted", "onHistoryStateUpdated",
    "onReferenceFragmentUpdated", "onErrorOccurred", "onTabReplaced"
  ].map(name => [name, event()]));
  const alarms = new Map();
  const chrome = {
    storage: { local: area(local), session: area(session) },
    runtime: {
      id: "test", getURL: path => `${base}${path}`,
      onInstalled: event(), onStartup: event(), onMessage: event(),
      async openOptionsPage() {}
    },
    action: { onClicked: event() },
    alarms: {
      onAlarm: event(),
      async create(name, value) { alarms.set(name, value); },
      async clear(name) { return alarms.delete(name); }
    },
    webNavigation,
    tabs: {
      onRemoved: event(),
      async query() { return structuredClone([...tabs.values()]); },
      async get(id) {
        if (!tabs.has(id)) throw new Error("No tab");
        const tab = structuredClone(tabs.get(id));
        if (tab.url.startsWith(base)) delete tab.url;
        return tab;
      },
      async update(id, { url }) {
        updates.push({ id, url, recordsAtUpdate: structuredClone(local.records) });
        if (rejectUpdates) throw new Error("Test navigation failure");
        if (!tabs.has(id)) throw new Error("No tab");
        const tab = tabs.get(id);
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
    local, session, tabs, updates, removed, chrome, sender, send, drain, navigate,
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
    local: { records: [{ id: "expired", outcome: "active", startedAt: 1000, elapsedMs: 0 }] },
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
