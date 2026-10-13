import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { siteFor, targetUrl, pauseTarget, validateSettings, validateGrant, DEFAULT_SETTINGS } from "../core.js";

test("matches only supported domains and their real subdomains", () => {
  assert.equal(siteFor("https://www.douyin.com/").id, "douyin");
  assert.equal(siteFor("https://xiaohongshu.com/explore/a").id, "xiaohongshu");
  assert.equal(siteFor("https://www.bilibili.com/list/ml3197110280?oid=116067095609579&bvid=BV19Scpz3ED5").id, "bilibili");
  for (const url of ["https://notbilibili.com/", "https://bilibili.com.evil.test/", "https://google.com/?q=douyin.com", "file:///douyin.com", "bad"]) {
    assert.equal(siteFor(url), null);
  }
});

test("rejects untrusted destinations and credential URLs", () => {
  assert.throws(() => targetUrl("javascript:alert(1)"));
  assert.throws(() => targetUrl("https://me:secret@bilibili.com/"));
  const target = "https://www.bilibili.com/list/ml3197110280?oid=116067095609579&bvid=BV19Scpz3ED5";
  assert.equal(targetUrl(target), target);
});

test("settings prevent redirect loops and invalid inputs", () => {
  assert.deepEqual(validateSettings(DEFAULT_SETTINGS), DEFAULT_SETTINGS);
  for (const exitUrl of ["https://www.douyin.com/", "javascript:alert(1)", "https://user:pass@google.com/"]) {
    assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, exitUrl }));
  }
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, warningSeconds: 0 }));
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, quote: "" }));
  assert.equal(validateSettings({ ...DEFAULT_SETTINGS, expiryAction: undefined }).expiryAction, "pause");
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, expiryAction: "unknown" }));
});

test("requires explicit duration and nonempty reason", () => {
  assert.deepEqual(validateGrant(0.1, " test "), { duration: 0.1, purpose: "test" });
  for (const minutes of [0, -1, NaN, Infinity, 1441]) assert.throws(() => validateGrant(minutes, "test"));
  assert.throws(() => validateGrant(15, "  "));
});

test("confirmation targets preserve path, query, and fragments", () => {
  const page = "chrome-extension://test/pause.html";
  const target = "https://www.bilibili.com/list/ml3197110280?bvid=BV19Scpz3ED5#part2";
  assert.equal(pauseTarget(`${page}#${target}`, page), target);
});

test("confirmation parser rejects other extension pages and unsafe targets", () => {
  const page = "chrome-extension://test/pause.html";
  for (const url of [
    `${page}#javascript:alert(1)`, `${page}#https://www.google.com/`,
    `${page}#https://me:secret@douyin.com/`, `${page}.evil#https://douyin.com/`,
    "chrome-extension://other/pause.html#https://douyin.com/", undefined
  ]) assert.equal(pauseTarget(url, page), null);
});

test("navigation interception needs neither DNR nor web-accessible extension pages", () => {
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.deepEqual(manifest.permissions, ["storage", "alarms", "webNavigation"]);
  assert.deepEqual(manifest.host_permissions, [
    "*://*.douyin.com/*", "*://*.xiaohongshu.com/*", "*://*.bilibili.com/*"
  ]);
  assert.match(manifest.content_security_policy.extension_pages, /frame-ancestors 'none'/);
  assert.deepEqual(manifest.content_scripts[0].js, ["expiry.js", "timer.js"]);
});
