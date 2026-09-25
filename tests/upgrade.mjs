import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { DEFAULT_SETTINGS } from "../core.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const currentManifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const work = await mkdtemp(path.join(tmpdir(), "pause-upgrade-"));
const extensionPath = path.join(work, "extension");
await mkdir(extensionPath);
await cp(path.join(root, "tests", "fixtures", "legacy"), extensionPath, { recursive: true });
const context = await chromium.launchPersistentContext(path.join(work, "profile"), {
  channel: "chromium", headless: true,
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
});

async function eventually(check, label) {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}

try {
  let worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  await eventually(() => worker.evaluate(() => globalThis.legacyReady), "legacy rules");
  const extension = `chrome-extension://${new URL(worker.url()).host}`;
  assert.equal((await worker.evaluate(() => chrome.declarativeNetRequest.getDynamicRules())).length, 1);
  console.log("PASS legacy dynamic rule is installed before the upgrade");
  const manager = await context.newPage();
  await manager.goto("chrome://extensions/");
  await manager.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
  await eventually(() => manager.evaluate(() => new Promise(resolve =>
    chrome.developerPrivate.getProfileConfiguration(config => resolve(config.inDeveloperMode)))),
  "developer mode for unpacked reload");
  await worker.evaluate(async settings => {
    await chrome.storage.local.set({
      settings,
      records: [
        { id: "kept", siteId: "douyin", siteName: "抖音", attemptedAt: 1000, startedAt: null, endedAt: 2000, plannedMs: 0, elapsedMs: 0, reason: "", outcome: "declined" },
        { id: "interrupted", siteId: "bilibili", siteName: "哔哩哔哩", attemptedAt: 1000, startedAt: 1000, endedAt: null, plannedMs: 60000, elapsedMs: 0, reason: "upgrade test", outcome: "active" }
      ]
    });
    await chrome.storage.session.set({ state: {
      grants: { 999: { tabId: 999, siteId: "bilibili", recordId: "interrupted", startedAt: 1000, expiresAt: Date.now() + 60000 } },
      pending: {}
    } });
  }, { ...DEFAULT_SETTINGS, quote: "Upgrade setting preserved." });

  for (const file of [
    "manifest.json", "background.js", "core.js", "pause.html", "pause.js",
    "timer.js", "journal.html", "journal.js", "style.css"
  ]) await cp(path.join(root, file), path.join(extensionPath, file));

  await worker.evaluate(() => chrome.runtime.reload()).catch(error => {
    if (!/closed|destroyed/i.test(error.message)) throw error;
  });
  const journal = await context.newPage();
  await eventually(async () => {
    try {
      await journal.goto(`${extension}/journal.html`);
      return true;
    } catch (error) {
      if (!/ERR_BLOCKED_BY_CLIENT|ERR_ABORTED/.test(error.message)) throw error;
      return false;
    }
  }, "reloaded extension page");
  await eventually(async () => {
    for (const candidate of context.serviceWorkers()) {
      const version = await candidate.evaluate(() => chrome.runtime.getManifest().version).catch(() => null);
      if (version === currentManifest.version) {
        worker = candidate;
        return true;
      }
    }
    return false;
  }, "new extension runtime");
  await eventually(async () => {
    const { records } = await worker.evaluate(() => chrome.storage.local.get("records"));
    return records?.find(record => record.id === "interrupted")?.outcome === "interrupted";
  }, "history reconciliation");
  const stored = await worker.evaluate(() => chrome.storage.local.get(["settings", "records"]));
  assert.equal(stored.settings.quote, "Upgrade setting preserved.");
  assert.equal(stored.records.find(record => record.id === "kept").outcome, "declined");
  assert.equal(stored.records.find(record => record.id === "interrupted").elapsedMs, null);
  console.log("PASS in-place upgrade preserves settings and records, without restoring old grants");
  const permissions = await worker.evaluate(() => chrome.permissions.getAll());
  assert.ok(permissions.permissions.every(permission => !permission.startsWith("declarativeNetRequest")));
  console.log("PASS DNR permission is absent after reloading the same extension directory");

  await context.route("https://www.google.com/**", route => route.fulfill({
    contentType: "text/html", body: '<a id="link" href="https://www.douyin.com/?upgrade=1">Open</a>'
  }));
  await context.route("https://www.douyin.com/**", route => route.fulfill({
    contentType: "text/html", body: "<h1>Target fixture</h1>"
  }));
  const page = await context.newPage();
  await page.goto("https://www.google.com/");
  await page.locator("#link").click();
  await eventually(async () =>
    page.url() === `${extension}/pause.html#https://www.douyin.com/?upgrade=1` &&
    await page.evaluate(() => Boolean(document.querySelector("#leave:not(:disabled)"))).catch(() => false),
  "new confirmation, not legacy DNR");
  assert.equal(await page.locator("#quote").textContent(), "Upgrade setting preserved.");
  assert.equal((await worker.evaluate(() => chrome.storage.local.get("records"))).records.length, 3);
  console.log("PASS legacy DNR redirects no longer run; the new navigation flow records the click");
  await page.locator("#choose").click();
  await page.locator("#reason").selectOption("查找资料");
  await page.locator("#continue").click();
  await page.waitForURL("https://www.douyin.com/?upgrade=1");
  console.log("PASS approval after upgrade reaches the target rather than a legacy blocking page");
} catch (error) {
  console.error("Upgrade workers:", context.serviceWorkers().map(worker => worker.url()));
  for (const page of context.pages()) {
    console.error("Upgrade page:", page.url());
    console.error(await page.locator("body").innerText({ timeout: 1000 }).catch(() => "(unavailable)"));
  }
  const manager = await context.newPage();
  await manager.goto("chrome://extensions/");
  console.error("Extension manager:", await manager.evaluate(() => new Promise(resolve =>
    chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true, includeTerminated: true }, resolve))));
  throw error;
} finally {
  await context.close();
  if (path.dirname(work) !== path.resolve(tmpdir()) || !path.basename(work).startsWith("pause-upgrade-")) {
    throw new Error("Refusing to remove an unexpected upgrade-test directory.");
  }
  await rm(work, { recursive: true, force: true });
}
