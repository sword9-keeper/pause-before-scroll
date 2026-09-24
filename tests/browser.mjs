import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "test-results");
const profile = await mkdtemp(path.join(tmpdir(), "pause-extension-"));
await mkdir(output, { recursive: true });
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  viewport: { width: 1365, height: 900 },
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
});
const errors = [];
context.on("weberror", error => errors.push(error.error().message));
let checks = 0;
function passed(label) { checks++; console.log(`PASS ${label}`); }

async function eventually(check, label, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}

try {
  let worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  const extension = `chrome-extension://${extensionId}`;
  const data = () => worker.evaluate(() => chrome.storage.local.get(["records", "settings"]));
  const session = () => worker.evaluate(() => chrome.storage.session.get("state"));
  await eventually(async () => (await data()).settings, "extension initialization");

  // Fixtures avoid credentials, third-party scripts, and live site dependencies.
  await context.route(/^https?:\/\/([^/]+\.)?(douyin|xiaohongshu|bilibili)\.com\//, route =>
    route.fulfill({
      status: 200, contentType: "text/html",
      body: "<!doctype html><html><head><meta charset='utf-8'><title>Site fixture</title></head><body><h1>Test content</h1><p>Extension test fixture.</p></body></html>"
    }));
  await context.route("https://www.google.com/**", route =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<title>Exit fixture</title><h1>Exit</h1>" }));

  const page = await context.newPage();
  await page.goto("https://www.douyin.com/");
  await page.waitForURL(`${extension}/pause.html#**`);
  await page.locator("#leave").waitFor({ state: "visible" });
  await eventually(() => page.locator("#leave").isEnabled(), "pause initialized");
  assert.equal(await page.locator("#destination").textContent(), "即将前往 · 抖音");
  assert.equal((await data()).records.length, 1);
  passed("network redirect opens confirmation and records one attempt");
  await page.reload();
  await eventually(() => page.locator("#leave").isEnabled(), "pause reload");
  assert.equal((await data()).records.length, 1);
  passed("confirmation refresh does not duplicate attempts");
  await page.screenshot({ path: path.join(output, "pause-desktop.png"), fullPage: true });
  await page.locator("#choose").click();
  await page.locator("#reason").selectOption("查找资料");
  await page.screenshot({ path: path.join(output, "pause-form-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, "pause-mobile.png"), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  passed("confirmation fits narrow viewport");
  await page.setViewportSize({ width: 1365, height: 900 });
  await page.locator("#continue").click();
  await page.waitForURL("https://www.douyin.com/");
  await page.locator("h1").filter({ hasText: "Test content" }).waitFor();
  assert.equal((await data()).records[0].outcome, "active");
  passed("selected reason and duration grant access");
  await page.goto("https://www.douyin.com/video/123");
  assert.equal(page.url(), "https://www.douyin.com/video/123");
  passed("same-tab same-site navigation stays allowed");
  const firstDeadline = Object.values((await session()).state.grants)[0].expiresAt;
  await page.evaluate(() => {
    history.pushState({}, "", "/video/456");
    location.hash = "comments";
  });
  await page.waitForTimeout(200);
  assert.equal(Object.values((await session()).state.grants)[0].expiresAt, firstDeadline);
  assert.equal((await data()).records.length, 1);
  passed("SPA and fragment navigation do not reset time or duplicate records");

  const second = await context.newPage();
  await second.goto("https://www.douyin.com/video/123");
  await second.waitForURL(`${extension}/pause.html#**`);
  await eventually(() => second.locator("#leave").isEnabled(), "second tab pause");
  passed("new tab does not inherit another tab's grant");
  await second.locator("#leave").click();
  await second.waitForURL("https://www.google.com/");
  assert.equal((await data()).records.at(-1).outcome, "declined");
  passed("decline opens configured destination and records choice");

  await page.goto("https://www.xiaohongshu.com/explore/test");
  await page.waitForURL(`${extension}/pause.html#**`);
  await eventually(() => page.locator("#leave").isEnabled(), "cross-site pause");
  assert.equal((await data()).records[0].outcome, "left");
  assert.equal(Object.keys((await session()).state.grants).length, 0);
  passed("cross-site navigation revokes original grant");
  await page.close();
  await eventually(async () => (await data()).records.at(-1).outcome === "dismissed", "abandoned confirmation");
  passed("closing confirmation records dismissal");

  const playlist = "https://www.bilibili.com/list/ml3197110280?oid=116067095609579&bvid=BV19Scpz3ED5";
  const video = await context.newPage();
  await video.goto(playlist);
  await video.waitForURL(`${extension}/pause.html#**`);
  await eventually(() => video.locator("#leave").isEnabled(), "playlist pause");
  assert.equal(video.url().slice(video.url().indexOf("#") + 1), playlist);
  passed("Bilibili playlist is restricted and its full query survives redirect");
  await video.locator("#choose").click();
  await video.locator('[name="duration"][value="custom"]').check();
  await video.locator("#custom-minutes").fill("0.1");
  await video.locator("#reason").selectOption("__custom__");
  await video.locator("#custom-reason").fill("验证到期关闭");
  await video.locator("#continue").click();
  await video.waitForURL(playlist);
  await eventually(() => video.evaluate(() => [...document.querySelectorAll("div")].some(el => el.style.zIndex === "2147483647")), "countdown mounted");
  await video.screenshot({ path: path.join(output, "countdown.png"), fullPage: true });
  await second.bringToFront();
  await video.waitForEvent("close", { timeout: 15000 });
  const expired = (await data()).records.at(-1);
  assert.equal(expired.outcome, "expired");
  assert.equal(expired.reason, "验证到期关闭");
  assert.equal(expired.elapsedMs, 6000);
  assert.equal(Object.keys((await session()).state.grants).length, 0);
  passed("background tab counts wall time, closes at expiry, and removes grant");

  const repeated = await context.newPage();
  await repeated.goto(playlist);
  await repeated.waitForURL(`${extension}/pause.html#**`);
  await eventually(() => repeated.locator("#leave").isEnabled(), "repeat attempt");
  await repeated.locator("#choose").click();
  await repeated.locator("#reason").selectOption("休息一下");
  await repeated.locator("#continue").click();
  await repeated.waitForURL(playlist);
  await repeated.close();
  await eventually(async () => (await data()).records.at(-1).outcome === "closed", "manual close");
  passed("repeat request is permitted and manual closure ends the record");

  const journal = await context.newPage();
  await journal.goto(`${extension}/journal.html`);
  await eventually(async () => Number(await journal.locator("#attempt-count").textContent()) > 0, "journal data");
  await journal.screenshot({ path: path.join(output, "journal-desktop.png"), fullPage: true });
  await journal.setViewportSize({ width: 390, height: 844 });
  await journal.screenshot({ path: path.join(output, "journal-mobile.png"), fullPage: true });
  assert.ok(await journal.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await journal.locator("#site-filter").selectOption("bilibili");
  assert.equal(await journal.locator("#record-rows tr").count(), 2);
  passed("journal displays records, filters sites, and fits narrow viewport");
  const downloadPromise = journal.waitForEvent("download");
  await journal.locator("#export").click();
  const download = await downloadPromise;
  await download.saveAs(path.join(output, "export.json"));
  passed("JSON export downloads locally");
  await journal.locator("#settings-tab").click();
  await journal.locator("#exit-url").fill("https://www.douyin.com/");
  await journal.locator('[type="submit"]').click();
  await eventually(async () => (await journal.locator("#status").textContent()).includes("非受限"), "loop prevention");
  assert.equal((await data()).settings.exitUrl, "https://www.google.com/");
  await journal.locator("#exit-url").fill("https://www.chatgpt.com/");
  await journal.locator("#quote-input").fill("今天只做这一件事。");
  await journal.locator('[type="submit"]').click();
  await eventually(async () => (await journal.locator("#status").textContent()) === "已保存", "settings persisted");
  assert.equal((await data()).settings.exitUrl, "https://www.chatgpt.com/");
  passed("settings persist and reject exit redirect loops");
  await journal.screenshot({ path: path.join(output, "settings-mobile.png"), fullPage: true });

  const restore = await context.newPage();
  await restore.goto("https://www.douyin.com/");
  await restore.waitForURL(`${extension}/pause.html#**`);
  await eventually(() => restore.locator("#leave").isEnabled(), "restoration pause");
  assert.equal(await restore.locator("#quote").textContent(), "今天只做这一件事。");
  assert.equal(await restore.locator(".attribution").isVisible(), false);
  await restore.locator("#choose").click();
  await restore.locator("#reason").selectOption("查找资料");
  await restore.locator("#continue").click();
  await restore.waitForURL("https://www.douyin.com/");
  const deadlineBeforeRestart = Object.values((await session()).state.grants)[0].expiresAt;
  const cdp = await context.newCDPSession(journal);
  const { targetInfos } = await cdp.send("Target.getTargets");
  const backgroundTarget = targetInfos.find(target => target.type === "service_worker" && target.url === worker.url());
  assert.ok(backgroundTarget);
  await worker.evaluate(() => { globalThis.__restartProof = true; });
  assert.equal((await cdp.send("Target.closeTarget", { targetId: backgroundTarget.targetId })).success, true);
  await journal.reload();
  // Chromium may reuse the target; a fresh global proves the runtime restarted.
  await eventually(async () => {
    worker = context.serviceWorkers()[0];
    return worker && await worker.evaluate(() => globalThis.__restartProof === undefined).catch(() => false);
  }, "fresh worker runtime");
  await eventually(async () => Object.values((await session()).state.grants).length === 1, "restored grant");
  assert.equal(Object.values((await session()).state.grants)[0].expiresAt, deadlineBeforeRestart);
  await restore.goto("https://www.douyin.com/video/789");
  assert.equal(restore.url(), "https://www.douyin.com/video/789");
  passed("service-worker restart preserves grants and original deadline");
  await restore.goto("https://www.google.com/");
  await eventually(async () => Object.keys((await session()).state.grants).length === 0, "leave for unrestricted site");
  await restore.goBack();
  await restore.waitForURL(`${extension}/pause.html#**`);
  passed("leaving for an unrestricted site revokes grant, including back navigation");
  await restore.close();
  await eventually(async () => !(await data()).records.some(record => record.outcome === "pending"), "last pending attempt closed");
  const storedRecords = (await data()).records;
  assert.ok(storedRecords.every(record => !("url" in record) && !("target" in record) && !("title" in record)));
  passed("persistent records omit visited URLs and page titles");
  await cdp.detach();
  await journal.locator("#records-tab").click();
  journal.once("dialog", dialog => dialog.accept());
  await journal.locator("#clear").click();
  await eventually(async () => (await data()).records.length === 0, "clear finished records");
  passed("confirmed record deletion clears only completed history");
  assert.deepEqual(errors, []);
  passed("no uncaught page errors");
  console.log(`\n${checks} browser checks passed. Screenshots: ${output}`);
} finally {
  await context.close();
  if (path.dirname(profile) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith("pause-extension-")) {
    throw new Error("Refusing to remove an unexpected browser profile path.");
  }
  await rm(profile, { recursive: true, force: true });
}
