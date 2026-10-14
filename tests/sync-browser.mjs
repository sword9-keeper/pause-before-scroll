import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { authorize, setupSites } from "./browser-setup.mjs";
import { createDav } from "./dav-fixture.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const work = await mkdtemp(path.join(tmpdir(), "pause-sync-"));
const extensionPath = path.join(work, "extension");
const output = path.join(root, "test-results");
await mkdir(extensionPath);
await mkdir(output, { recursive: true });
for (const file of ["manifest.json", "core.js", "rules.js", "site-editor.js", "reviews.js", "review-editor.js", "background.js", "sync.js", "install-defaults.js", "insights.js", "vendor", "assets", "privacy.html", "pause.html", "pause.js", "expiry.js", "timer.js", "journal.html", "journal.js", "style.css"]) {
  await cp(path.join(root, file), path.join(extensionPath, file), { recursive: true });
}
const manifest = JSON.parse(await readFile(path.join(extensionPath, "manifest.json"), "utf8"));
// The isolated fixture pre-grants only a nonexistent test host, avoiding an unattended permission prompt.
manifest.host_permissions.push("https://dav.example.test/*");
await writeFile(path.join(extensionPath, "manifest.json"), JSON.stringify(manifest));
const dav = createDav();
const contexts = [];
const errors = [];

async function eventually(check, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${label}`);
}

async function device(name) {
  const context = await chromium.launchPersistentContext(path.join(work, name), {
    channel: "chromium", headless: true, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  contexts.push(context);
  context.on("weberror", error => errors.push(error.error().message));
  await context.route("https://dav.example.test/**", async route => {
    const request = route.request();
    try {
      const response = await dav.fetcher(request.url(), {
        method: request.method(), headers: await request.allHeaders(), body: request.postData()
      });
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    } catch { await route.abort("failed"); }
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extension = `chrome-extension://${new URL(worker.url()).host}`;
  await setupSites(context, extension);
  const page = await context.newPage();
  await page.goto(`${extension}/journal.html`);
  await page.locator("#sync-tab").click();
  await page.locator("#sync-enabled").check();
  await page.locator("#sync-url").fill("https://dav.example.test/back-to-flow/");
  await page.locator("#sync-username").fill("test-user");
  await page.locator("#sync-password").fill("test-only-password");
  await page.locator("#sync-save").click();
  await eventually(async () => (await page.locator("#status").textContent()) === "连接已保存", "saved connection");
  assert.equal(await page.locator("#sync-password").inputValue(), "");
  return { context, page, worker };
}

async function sync(device) {
  await device.page.locator("#sync-tab").click();
  await device.page.locator("#sync-now").click();
  await eventually(async () => (await device.page.locator("#status").textContent()) === "同步完成", "manual sync");
}

try {
  const a = await device("device-a");
  const b = await device("device-b");
  await a.page.locator("#settings-tab").click();
  await a.page.locator('[name="expiry-action"][value="close"]').check();
  await a.page.locator("#quote-input").fill("Settings from device A");
  await a.page.locator('#settings-form [type="submit"]').click();
  await eventually(async () => (await a.page.locator("#status").textContent()) === "已保存", "settings");
  await a.page.locator("#sites-tab").click();
  await a.page.locator('[name="enabled-site"][value="xiaohongshu"]').uncheck();
  await a.page.locator("#site-save").click();
  await eventually(async () => (await a.page.locator("#status").textContent()) === "网站配置已保存", "site rules");
  // Create a completed visit through normal extension messages.
  await a.context.route("https://www.douyin.com/**", route => route.fulfill({ contentType: "text/html", body: "<h1>Fixture</h1>" }));
  await a.context.route("https://www.google.com/**", route => route.fulfill({ contentType: "text/html", body: "<h1>Exit</h1>" }));
  const visit = await a.context.newPage();
  await visit.goto("https://www.douyin.com/").catch(error => {
    if (!error.message.includes("ERR_ABORTED")) throw error;
  });
  await visit.locator("#leave").click();
  await visit.waitForURL("https://www.google.com/");
  await visit.close();
  await sync(a);
  await sync(b);
  const storedB = await b.worker.evaluate(() => chrome.storage.local.get(["settings", "records", "syncMeta"]));
  assert.equal(storedB.settings.quote, "Settings from device A");
  assert.equal(storedB.settings.expiryAction, "close");
  assert.ok(!storedB.settings.enabledSites.includes("xiaohongshu"));
  assert.equal(storedB.records.length, 1);
  assert.equal(storedB.records[0].outcome, "declined");
  console.log("PASS two independent browser profiles sync settings, site switches, and completed records");
  assert.equal(dav.files.size, 2);
  assert.ok([...dav.files.values()].every(text => !text.includes("test-only-password") && !text.includes("test-user")));
  console.log("PASS credentials stay out of remote snapshots and the password field");
  await b.page.screenshot({ path: path.join(output, "sync-desktop.png"), fullPage: true });
  await b.page.setViewportSize({ width: 390, height: 844 });
  await b.page.screenshot({ path: path.join(output, "sync-mobile.png"), fullPage: true });
  assert.ok(await b.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  console.log("PASS sync controls fit desktop and narrow viewports");

  dav.setOffline(true);
  await a.page.locator("#sync-now").click();
  await eventually(async () => (await a.page.locator("#sync-state").textContent()) === "同步失败", "offline failure");
  assert.equal((await a.worker.evaluate(() => chrome.storage.local.get("records"))).records.length, 1);
  await a.page.screenshot({ path: path.join(output, "sync-offline.png"), fullPage: true });
  dav.setOffline(false);
  await sync(a);
  console.log("PASS network failure is visible and retry preserves local records");
  await b.page.locator("#records-tab").click();
  b.page.once("dialog", dialog => dialog.accept());
  await b.page.locator("#clear").click();
  await eventually(async () => (await b.worker.evaluate(() => chrome.storage.local.get("records"))).records.length === 0, "clear");
  await sync(b);
  await sync(a);
  assert.equal((await a.worker.evaluate(() => chrome.storage.local.get("records"))).records.length, 0);
  console.log("PASS deletion propagates and old local records do not reappear");
  await a.page.locator("#sites-tab").click();
  await authorize(a.context, a.page.url(), ["*://*.video.example.test/*"]);
  await a.page.locator("#site-domain").fill("video.example.test");
  // Save also includes a domain typed without pressing the separate Add button.
  await a.page.locator("#site-save").click();
  await eventually(async () => (await a.page.locator("#status").textContent()) === "网站配置已保存", "custom site");
  await sync(a);
  await sync(b);
  await b.page.locator("#sites-tab").click();
  const custom = b.page.locator('.rule-row[data-domain="video.example.test"]');
  await eventually(async () => (await custom.locator(".rule-permission").textContent()) === "本机待授权", "independent device permission");
  await b.context.route("https://video.example.test/**", route => route.fulfill({
    contentType: "text/html", body: '<h1 id="fixture">Local custom-site fixture</h1>'
  }));
  const customPage = await b.context.newPage();
  await customPage.goto("https://video.example.test/");
  await customPage.locator("#fixture").waitFor();
  assert.equal((await b.worker.evaluate(() => chrome.storage.local.get("records"))).records.length, 0);
  await authorize(b.context, b.page.url(), ["*://*.video.example.test/*"]);
  await custom.locator('[data-action="grant"]').click();
  await eventually(async () => (await custom.locator(".rule-permission").textContent()) === "已授权", "local custom grant");
  await customPage.reload().catch(error => {
    if (!error.message.includes("ERR_ABORTED")) throw error;
  });
  await customPage.locator("#choose").waitFor();
  await customPage.close();
  console.log("PASS custom rules sync to an independent device without granting host access; only local authorization enables the gate");
  await b.page.reload();
  await b.page.locator("#sync-tab").click();
  await eventually(async () => (await b.page.locator("#sync-password").getAttribute("placeholder")).includes("已保存"), "saved password marker");
  assert.equal(await b.page.locator("#sync-password").inputValue(), "");
  await b.page.locator("#sync-save").click();
  await eventually(async () => (await b.page.locator("#status").textContent()) === "连接已保存", "retained password");
  await sync(b);
  b.page.once("dialog", dialog => dialog.accept());
  await b.page.locator("#sync-forget").click();
  await eventually(async () => (await b.page.locator("#sync-state").textContent()) === "未启用", "forget connection");
  assert.equal((await b.worker.evaluate(() => chrome.storage.local.get("syncConfig"))).syncConfig.password, "");
  assert.equal(dav.files.size, 2);
  assert.deepEqual(errors, []);
  console.log("PASS reload preserves the connection; forgetting it removes only local credentials");
} finally {
  for (const context of contexts) await context.close();
  if (path.dirname(work) !== path.resolve(tmpdir()) || !path.basename(work).startsWith("pause-sync-")) {
    throw new Error("Refusing to remove unexpected sync-test directory.");
  }
  await rm(work, { recursive: true, force: true });
}
