import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, validateSettings } from "../core.js";
import {
  MAX_SYNC_BYTES, validateSyncConfig, permissionOrigin, validateDocument,
  mergeDocuments, nextRevision, serializeDocument, deviceFiles, syncWebDAV
} from "../sync.js";
import { createDav } from "./dav-fixture.mjs";

const config = {
  enabled: true, url: "https://dav.example.test/back-to-flow/", username: "tester",
  password: "test-only-password", syncRecords: true
};
const record = id => ({
  id, siteId: "douyin", siteName: "抖音", attemptedAt: 1000, startedAt: 1000,
  endedAt: 2000, plannedMs: 60000, elapsedMs: 1000, reason: "test", outcome: "closed"
});
const doc = (device, records = [], at = 0, deletedIds = []) => ({
  app: "back-to-flow", schemaVersion: 2,
  settings: { revision: { device, at }, value: structuredClone(DEFAULT_SETTINGS) },
  records, deletedIds
});
const options = (dav, deviceId) => ({ fetcher: dav.fetcher, deviceId });

test("WebDAV config requires HTTPS, normalizes a directory, and scopes host permission", () => {
  assert.equal(validateSyncConfig({ ...config, url: "https://dav.example.test:8443/dav" }).url, "https://dav.example.test:8443/dav/");
  assert.equal(permissionOrigin("https://dav.example.test:8443/dav/"), "https://dav.example.test/*");
  for (const url of ["http://dav.example.test/", "https://user:secret@dav.example.test/", "https://dav.example.test/?key=secret", "https://dav.example.test/#token", "bad"]) {
    assert.throws(() => validateSyncConfig({ ...config, url }));
  }
  assert.throws(() => validateSyncConfig({ ...config, username: "bad:name" }));
  assert.throws(() => validateSyncConfig({ ...config, password: "" }));
  assert.equal(validateSyncConfig({ enabled: false }).enabled, false);
});

test("record merge is deterministic, deduplicated, deletion-wins, and excludes unrelated properties", () => {
  const a = doc("a", [record("one"), record("two")], 1);
  const b = doc("b", [record("one")], 2, ["two"]);
  b.settings.value.quote = "Remote quote";
  const merged = mergeDocuments(a, b);
  assert.deepEqual(merged, mergeDocuments(b, a));
  assert.equal(merged.records.length, 1);
  assert.equal(merged.settings.value.quote, "Remote quote");
  const text = serializeDocument({ ...merged, password: config.password, records: [{ ...record("one"), url: "private-url", cookie: "private-cookie" }] });
  assert.ok(!text.includes("password") && !text.includes("private-url") && !text.includes("private-cookie"));
  assert.equal(nextRevision({ at: Date.now() + 60000 }, "a").device, "a");
  assert.ok(nextRevision({ at: Date.now() + 60000 }, "a").at > Date.now() + 50000);
});

test("record opt-out preserves remote history but sends no local history or deletion markers", () => {
  const merged = mergeDocuments(doc("a", [record("private")], 2, ["remote"]), doc("b", [record("remote")], 1), false);
  assert.deepEqual(merged.records.map(item => item.id), ["remote"]);
  assert.deepEqual(merged.deletedIds, []);
});

test("schema validation rejects incompatible or active records and limits the size", () => {
  for (const value of [
    { ...doc("a"), schemaVersion: 99 },
    doc("a", [{ ...record("one"), outcome: "active" }]),
    doc("a", [{ ...record("one"), reason: "x".repeat(201) }]),
    doc("a", [{ ...record("one"), attemptedAt: -1 }]),
    doc("a", [], 0, ["../bad"])
  ]) assert.throws(() => validateDocument(value));
  const huge = doc("a", Array.from({ length: 15000 }, (_, index) => ({ ...record(`r-${index}`), reason: "字".repeat(200) })));
  assert.throws(() => serializeDocument(huge), /4 MB/);
});

test("DAV XML parser accepts namespaces and refuses foreign or nested credential destinations", () => {
  const directory = `${config.url}devices-v2/`;
  const xml = `<multistatus xmlns="DAV:">
    <response><href>${directory}device-a.json</href></response>
    <response><href>device-b.json</href></response>
    <response><href>https://evil.test/device-c.json</href></response>
    <response><href>${directory}nested/device-c.json</href></response>
    <response><href>${directory}%2e%2e/device-c.json</href></response>
    <response><href>${directory}device-c.json?token=1</href></response>
  </multistatus>`;
  assert.deepEqual(deviceFiles(xml, directory), [`${directory}device-a.json`, `${directory}device-b.json`]);
  assert.throws(() => deviceFiles("<html/>", directory));
  assert.throws(() => deviceFiles("<d:multistatus>", directory));
  assert.throws(() => deviceFiles('<multistatus xmlns="not-DAV:"/>', directory));
});

test("simultaneous devices converge without ETags or overwriting another device file", async () => {
  const dav = createDav();
  const a = doc("a", [record("one")], 1);
  const b = doc("b", [record("two")], 2);
  b.settings.value.quote = "Device B";
  await Promise.all([
    syncWebDAV(config, a, options(dav, "a")), syncWebDAV(config, b, options(dav, "b"))
  ]);
  assert.equal(dav.files.size, 2);
  const [mergedA, mergedB] = await Promise.all([
    syncWebDAV(config, a, options(dav, "a")), syncWebDAV(config, b, options(dav, "b"))
  ]);
  assert.deepEqual(mergedA, mergedB);
  assert.deepEqual(mergedA.records.map(item => item.id), ["one", "two"]);
  assert.equal(mergedA.settings.value.quote, "Device B");
  const deletedA = { ...mergedA, records: [], deletedIds: ["one", "two"] };
  await syncWebDAV(config, deletedA, options(dav, "a"));
  const afterOfflineReturn = await syncWebDAV(config, b, options(dav, "b"));
  assert.deepEqual(afterOfflineReturn.records, []);
  assert.equal(dav.requests.some(request => request.headers?.Authorization?.includes(config.password)), false);
  const puts = dav.requests.filter(request => request.method === "PUT").length;
  await syncWebDAV(config, afterOfflineReturn, options(dav, "b"));
  assert.equal(dav.requests.filter(request => request.method === "PUT").length, puts);
});

test("authentication, corrupt remote files, and offline failures never replace remote data", async () => {
  const dav = createDav();
  const own = `${config.url}devices-v2/device-a.json`;
  dav.setFailure(401);
  await assert.rejects(syncWebDAV(config, doc("a"), options(dav, "a")), /认证/);
  dav.setFailure(null);
  dav.files.set(own, "<html>sign in</html>");
  await assert.rejects(syncWebDAV(config, doc("a"), options(dav, "a")), /JSON/);
  assert.equal(dav.files.get(own), "<html>sign in</html>");
  dav.setOffline(true);
  await assert.rejects(syncWebDAV(config, doc("a"), options(dav, "a")), /无法连接/);
  assert.equal(dav.requests.filter(request => request.method === "PUT").length, 0);
});

test("network requests never follow redirects, use ambient cookies, or exceed the read limit", async () => {
  const dav = createDav();
  const checked = async (url, init) => {
    assert.equal(init.redirect, "error");
    assert.equal(init.credentials, "omit");
    assert.equal(init.cache, "no-store");
    return dav.fetcher(url, init);
  };
  await syncWebDAV(config, doc("a"), { fetcher: checked, deviceId: "a" });
  dav.files.set(`${config.url}devices-v2/device-b.json`, "x".repeat(MAX_SYNC_BYTES + 1));
  await assert.rejects(syncWebDAV(config, doc("a"), options(dav, "a")), /4 MB/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(syncWebDAV(config, doc("a"), { ...options(dav, "a"), signal: controller.signal }), /取消/);
});

test("the device limit does not create an unreadable thirty-third snapshot", async () => {
  const dav = createDav();
  for (let index = 0; index < 32; index++) {
    dav.files.set(`${config.url}devices-v2/device-${index}.json`, serializeDocument(doc(String(index))));
  }
  await assert.rejects(syncWebDAV(config, doc("new"), options(dav, "new")), /32/);
  assert.equal(dav.files.size, 32);
  assert.equal(dav.requests.filter(request => request.method === "PUT").length, 0);
});

test("foreground observations round-trip and survive old-client snapshots that omit new fields", () => {
  const measured = {
    ...record("one"), activityVersion: 1, foregroundMs: 1000,
    foregroundByDay: { "2026-10-13": 1000 }, finishIntent: "done"
  };
  const modern = validateDocument(doc("a", [measured], 2));
  assert.deepEqual(modern.records[0], measured);
  const legacy = doc("b", [record("one")], 1);
  assert.deepEqual(mergeDocuments(modern, legacy).records[0], measured);
  assert.deepEqual(mergeDocuments(legacy, modern).records[0], measured);
  for (const broken of [
    { ...measured, foregroundMs: 1001 },
    { ...measured, foregroundByDay: { "2026-02-31": 1000 } },
    { ...measured, foregroundByDay: { "2026-10-13": -1000 }, foregroundMs: -1000 },
    { ...measured, foregroundMs: 60001, foregroundByDay: { "2026-10-13": 60001 } }
  ]) assert.throws(() => validateDocument(doc("a", [broken])));
});

test("new protocol imports legacy history without modifying any legacy device file", async () => {
  const dav = createDav();
  const legacy = { ...doc("old", [record("legacy")], 5), schemaVersion: 1 };
  delete legacy.settings.value.customSites;
  delete legacy.settings.value.exceptions;
  const url = `${config.url}devices-v1/device-old.json`;
  const original = JSON.stringify(legacy);
  dav.files.set(url, original);
  const result = await syncWebDAV(config, doc("new"), options(dav, "new"));
  assert.equal(result.schemaVersion, 2);
  assert.deepEqual(result.records.map(item => item.id), ["legacy"]);
  assert.equal(dav.files.get(url), original);
  assert.ok(dav.files.has(`${config.url}devices-v2/device-new.json`));
  assert.ok(dav.requests.filter(item => item.method === "PUT").every(item => item.url.includes("/devices-v2/")));
});

test("an upgrading device cannot strip modern rules even when its old settings revision is newer", async () => {
  const dav = createDav();
  const modern = doc("modern", [record("existing")], 10);
  modern.settings.value = validateSettings({ ...DEFAULT_SETTINGS, customSites: [{ domain: "video.example.com", name: "Videos" }],
    exceptions: [{ mode: "path", url: "https://video.example.com/learning" }] });
  dav.files.set(`${config.url}devices-v2/device-modern.json`, serializeDocument(modern));
  const old = { ...doc("old", [record("old")], 1000), schemaVersion: 1 };
  dav.files.set(`${config.url}devices-v1/device-old.json`, JSON.stringify(old));
  const result = await syncWebDAV(config, { ...old, schemaVersion: 2 }, { ...options(dav, "old"), legacySettings: true });
  assert.deepEqual(result.settings, modern.settings);
  assert.deepEqual(result.records.map(item => item.id), ["existing", "old"]);
  const current = JSON.parse(dav.files.get(`${config.url}devices-v2/device-old.json`));
  assert.deepEqual(current.settings.value.customSites, modern.settings.value.customSites);
});

test("custom history survives rule removal and legacy corruption never produces a partial migration", async () => {
  const customRecord = { ...record("custom"), siteId: "custom:video.example.com", siteName: "Past name" };
  assert.deepEqual(validateDocument(doc("a", [customRecord])).records[0], customRecord);
  assert.throws(() => validateDocument(doc("a", [{ ...customRecord, siteId: "custom:co.uk" }])));
  const dav = createDav();
  dav.files.set(`${config.url}devices-v1/device-old.json`, "broken");
  await assert.rejects(syncWebDAV(config, doc("new"), options(dav, "new")), /JSON/);
  assert.equal(dav.requests.filter(item => item.method === "PUT").length, 0);
});
