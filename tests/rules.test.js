import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, siteFor, targetUrl, validateSettings, pauseTarget } from "../core.js";
import { normalizeDomain, siteOrigin, recordSite } from "../rules.js";

const custom = (overrides = {}) => validateSettings({
  ...DEFAULT_SETTINGS, customSites: [{ domain: "video.example.com", name: "Videos", ...overrides }]
});

test("domain input uses URL normalization and the public suffix list, not a guessed last-two-label rule", () => {
  assert.equal(normalizeDomain("  HTTPS://VIDEO.Example.COM/ "), "video.example.com");
  assert.equal(normalizeDomain("my-project.github.io"), "my-project.github.io");
  assert.equal(normalizeDomain("例子.中国"), "xn--fsqu00a.xn--fiqs8s");
  for (const domain of ["com", "co.uk", "github.io", "*.example.com", "localhost", "127.0.0.1", "[::1]",
    "https://user:secret@example.com/", "example.com/path", "example.com?query=1", "-bad.example.com",
    "https://example.com:8443/", "file://example.com/"]) {
    assert.throws(() => normalizeDomain(domain), domain);
  }
});

test("custom domains have stable identities, explicit subdomain scope, and bounded configuration", () => {
  const settings = custom();
  assert.equal(siteFor("https://video.example.com/", settings).id, "custom:video.example.com");
  assert.equal(siteFor("http://m.video.example.com/", settings).id, "custom:video.example.com");
  assert.equal(siteFor("https://video.example.com.evil.test/", settings), null);
  assert.equal(siteFor("https://m.video.example.com/", custom({ includeSubdomains: false })), null);
  assert.equal(siteFor("https://video.example.com/", custom({ enabled: false })), null);
  assert.equal(siteOrigin(settings.customSites[0]), "*://*.video.example.com/*");
  assert.equal(siteOrigin(custom({ includeSubdomains: false }).customSites[0]), "*://video.example.com/*");
  assert.throws(() => validateSettings({ ...settings, customSites: [...settings.customSites, { domain: "example.com" }] }), /重叠/);
  assert.throws(() => custom({ domain: "www.bilibili.com" }), /重叠/);
  assert.throws(() => custom({ enabled: "yes" }));
  assert.throws(() => custom({ name: "x".repeat(61) }));
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, customSites: Array.from({ length: 31 }, (_, i) => ({ domain: `s${i}.test` })) }));
  assert.throws(() => custom({ domain: "google.com" }), /离开网址/);
});

test("exact page exceptions retain query values and fragments and cannot exempt a lookalike host", () => {
  const settings = validateSettings({ ...custom(), exceptions: [
    { mode: "page", url: "https://video.example.com/watch?z=2&v=lesson#part1" }
  ] });
  assert.equal(siteFor("https://video.example.com/watch?v=lesson&z=2#part1", settings), null);
  for (const url of [
    "https://video.example.com/watch?v=other&z=2#part1",
    "https://video.example.com/watch?v=lesson&z=2#part2",
    "https://video.example.com/watch?v=lesson&z=2&extra=yes#part1",
    "https://video.example.com/watch?v=lesson&v=other&z=2#part1",
    "http://video.example.com/watch?v=lesson&z=2#part1"
  ]) assert.ok(siteFor(url, settings));
  assert.throws(() => validateSettings({ ...settings, exceptions: [{ mode: "page", url: "https://evil.test/" }] }));
});

test("path exceptions keep segment boundaries and reject encoded separators or whole-site exemptions", () => {
  const settings = validateSettings({ ...DEFAULT_SETTINGS, exceptions: [
    { mode: "path", url: "https://www.bilibili.com/list/ml123?bvid=changing" }
  ] });
  assert.equal(settings.exceptions[0].url, "https://www.bilibili.com/list/ml123");
  assert.equal(siteFor("https://www.bilibili.com/list/ml123?bvid=next", settings), null);
  assert.equal(siteFor("https://www.bilibili.com/list/ml123/part2", settings), null);
  for (const url of [
    "https://www.bilibili.com/list/ml1234",
    "https://www.bilibili.com/list/ml124",
    "https://www.bilibili.com/list/ml123/%2e%2e/ml124",
    "https://www.bilibili.com/list/ml123/%2f..%2fml124",
    "https://m.bilibili.com/list/ml123"
  ]) assert.ok(siteFor(url, settings));
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, exceptions: [{ mode: "path", url: "https://www.bilibili.com/" }] }));
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, exceptions: [{ mode: "path", url: "https://www.bilibili.com/list/%2fsecret" }] }));
});

test("target parsing supports configured custom domains but rejects credentials and unconfigured destinations", () => {
  const settings = custom();
  const page = "chrome-extension://test/pause.html";
  assert.equal(targetUrl("https://video.example.com/watch?v=1", settings), "https://video.example.com/watch?v=1");
  assert.equal(pauseTarget(`${page}#https://video.example.com/watch?v=1`, page, settings), "https://video.example.com/watch?v=1");
  assert.equal(pauseTarget(`${page}#https://unknown.test/`, page, settings), null);
  assert.throws(() => targetUrl("https://user:secret@video.example.com/", settings));
  assert.equal(recordSite({ siteId: "custom:video.example.com", siteName: "Former name" }).name, "Former name");
  assert.equal(recordSite({ siteId: "custom:com", siteName: "bad" }), null);
  assert.equal(recordSite({ siteId: 1, siteName: "bad" }), null);
});
