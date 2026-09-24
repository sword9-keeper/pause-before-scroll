import test from "node:test";
import assert from "node:assert/strict";
import { siteFor, targetUrl, validateSettings, validateGrant, redirectRules, allowRule, DEFAULT_SETTINGS } from "../core.js";

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
});

test("requires explicit duration and nonempty reason", () => {
  assert.deepEqual(validateGrant(0.1, " test "), { duration: 0.1, purpose: "test" });
  for (const minutes of [0, -1, NaN, Infinity, 1441]) assert.throws(() => validateGrant(minutes, "test"));
  assert.throws(() => validateGrant(15, "  "));
});

test("redirect rules preserve target and exclude lookalike domains", () => {
  const rules = redirectRules("chrome-extension://test/pause.html");
  assert.equal(rules.length, 3);
  const rule = rules[2];
  const regex = new RegExp(rule.condition.regexFilter, "i");
  assert.match("https://www.bilibili.com/list/ml3197110280?bvid=BV19Scpz3ED5", regex);
  assert.doesNotMatch("https://bilibili.com.evil.test/", regex);
  assert.equal(rule.action.redirect.regexSubstitution, "chrome-extension://test/pause.html#\\0");
});

test("allow rules are scoped to one tab and one site", () => {
  const rule = allowRule({ tabId: 42, siteId: "douyin" });
  assert.deepEqual(rule.condition.tabIds, [42]);
  assert.deepEqual(rule.condition.requestDomains, ["douyin.com"]);
  assert.deepEqual(rule.condition.resourceTypes, ["main_frame"]);
  assert.ok(rule.priority > redirectRules("test")[0].priority);
});
