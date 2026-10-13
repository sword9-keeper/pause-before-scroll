import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { setupSites } from "./browser-setup.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const profile = await mkdtemp(path.join(tmpdir(), "pause-value-"));
const output = path.join(root, "test-results");
await mkdir(output, { recursive: true });
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium", headless: true, viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
});
const errors = [];
context.on("weberror", event => errors.push(event.error().message));
async function eventually(check, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
try {
  await context.route(/^https:\/\/www\.(douyin|google)\.com\//, route =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><h1>Browsing fixture</h1><p>Local test only.</p>" }));
  let worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const base = `chrome-extension://${new URL(worker.url()).host}`;
  await setupSites(context, base);
  const stored = async () => worker.evaluate(async () => {
    const { records } = await chrome.storage.local.get("records");
    const { state } = await chrome.storage.session.get("state");
    const attention = state?.attention;
    const record = records.find(item => item.id === attention?.recordId);
    if (record && attention.snapshot) Object.assign(record, attention.snapshot);
    return records;
  });
  async function enter() {
    const page = await context.newPage();
    await page.goto("https://www.douyin.com/").catch(error => {
      if (!error.message.includes("ERR_ABORTED")) throw error;
    });
    await page.locator("#choose").click();
    await page.locator("#reason").selectOption("查找资料");
    await page.locator("#continue").click();
    await page.waitForURL("https://www.douyin.com/");
    await page.locator("#pause-before-scroll-timer").waitFor();
    await page.bringToFront();
    return page;
  }
  const page = await enter();
  await eventually(async () => (await stored())[0].foregroundMs >= 4000, "real foreground observation");
  const before = (await stored())[0].foregroundMs;
  const away = await context.newPage();
  await away.goto("https://www.google.com/");
  await away.bringToFront();
  await away.waitForTimeout(300);
  const afterSwitch = (await stored())[0].foregroundMs;
  await away.waitForTimeout(6000);
  assert.equal((await stored())[0].foregroundMs, afterSwitch);
  assert.ok(afterSwitch >= before && afterSwitch - before < 3000);
  console.log("PASS real active-tab observations accrue; background time does not");
  await page.bringToFront();
  await eventually(async () => (await stored())[0].foregroundMs > afterSwitch, "return to foreground");
  const closed = page.waitForEvent("close");
  await page.locator("#pause-before-scroll-timer").getByRole("button", { name: "结束并关闭", exact: true }).click();
  await closed;
  await eventually(async () => (await stored())[0].finishIntent === "done", "intentional stop persisted");
  assert.equal((await stored())[0].outcome, "left");
  console.log("PASS the in-page stop command closes the visit and records the deliberate decision");

  const parent = await enter();
  const childPromise = context.waitForEvent("page");
  await parent.evaluate(() => window.open("https://www.douyin.com/linked", "_blank"));
  const child = await childPromise;
  await child.waitForURL("https://www.douyin.com/linked");
  await child.locator("#pause-before-scroll-timer").waitFor();
  const end = child.locator("#pause-before-scroll-timer").getByRole("button", { name: "结束并关闭", exact: true });
  child.once("dialog", dialog => {
    assert.match(dialog.message(), /2 个/);
    return dialog.dismiss();
  });
  await end.click();
  assert.ok(!parent.isClosed() && !child.isClosed());
  child.once("dialog", dialog => dialog.accept());
  const bothClosed = Promise.all([parent.waitForEvent("close"), child.waitForEvent("close")]);
  await end.click();
  await bothClosed;
  assert.ok(!away.isClosed());
  await eventually(async () => (await stored()).at(-1).finishIntent === "done", "linked stop persisted");
  console.log("PASS linked-tab stopping respects cancellation and leaves unrelated pages untouched");

  const journal = await context.newPage();
  await journal.goto(`${base}/journal.html`);
  await journal.locator("#overview-panel").waitFor({ state: "visible" });
  await eventually(async () => (await journal.locator("#insight-done").textContent()) === "2", "honest outcome totals");
  await journal.screenshot({ path: path.join(output, "overview-observed.png"), fullPage: true });
  // Seed a separate visual fixture, not user data or evidence of efficacy.
  await worker.evaluate(async () => {
    const rows = [];
    for (let i = 0; i < 7; i++) {
      const at = new Date();
      at.setHours(10, 0, 0, 0);
      at.setDate(at.getDate() - 6 + i);
      const key = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
      for (const [siteId, siteName, multiplier] of [["douyin", "抖音", 1], ["xiaohongshu", "小红书", 0.5]]) {
        const foregroundMs = [14, 9, 12, 7, 8, 4, 6][i] * 60000 * multiplier;
        rows.push({
          id: `fixture-${siteId}-${i}`, siteId, siteName, attemptedAt: at.getTime(),
          startedAt: at.getTime(), endedAt: at.getTime() + 1800000, plannedMs: 1800000,
          elapsedMs: 1800000, reason: "休息一下", outcome: "left",
          activityVersion: 1, foregroundMs, foregroundByDay: { [key]: foregroundMs },
          ...(i % 2 ? {} : { finishIntent: "done" })
        });
      }
      rows.push({
        id: `fixture-declined-${i}`, siteId: "douyin", siteName: "抖音",
        attemptedAt: at.getTime() + 2000000, startedAt: null, endedAt: at.getTime() + 2001000,
        plannedMs: 0, elapsedMs: 0, reason: "", outcome: "declined",
        activityVersion: 1, foregroundMs: 0, foregroundByDay: {}
      });
    }
    rows.push({
      id: "fixture-legacy", siteId: "bilibili", siteName: "哔哩哔哩", attemptedAt: Date.now(),
      startedAt: Date.now() - 60000, endedAt: Date.now(), plannedMs: 60000, elapsedMs: 60000,
      reason: "旧版记录", outcome: "closed"
    });
    await chrome.storage.local.set({ records: rows });
  });
  const cdp = await context.newCDPSession(journal);
  const { targetInfos } = await cdp.send("Target.getTargets");
  const target = targetInfos.find(item => item.type === "service_worker" && item.url === worker.url());
  await cdp.send("Target.closeTarget", { targetId: target.targetId });
  await journal.reload();
  await eventually(async () => (await journal.locator("#insight-entries").textContent()) === "15", "visual fixture");
  await journal.screenshot({ path: path.join(output, "overview-desktop.png"), fullPage: true });
  assert.equal(await journal.locator("#site-summary .site-row").filter({ hasText: "哔哩哔哩" }).locator(".site-duration").textContent(), "未观测");
  for (const width of [390, 320]) {
    await journal.setViewportSize({ width, height: 844 });
    await journal.screenshot({ path: path.join(output, `overview-${width}.png`), fullPage: true });
    assert.ok(await journal.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await journal.locator('[data-period="30"]').click();
  assert.equal(await journal.locator("#daily-chart [role=listitem]").count(), 30);
  await journal.screenshot({ path: path.join(output, "overview-30-days-mobile.png"), fullPage: true });
  assert.ok(await journal.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.ok(await journal.locator(".day-label").evaluateAll(labels => {
    const visible = labels.filter(label => label.textContent).map(label => label.getBoundingClientRect());
    return visible.every((label, index) => index === 0 || label.left >= visible[index - 1].right);
  }), "30-day labels do not overlap on the narrowest viewport");
  await journal.locator("#manage-sites").click();
  assert.ok(await journal.locator("#sites-panel").isVisible());
  await cdp.detach();
  assert.deepEqual(errors, []);
  console.log("PASS overview renders real outcomes, preserves legacy unknowns, and fits 1280/390/320 px");
} finally {
  await context.close();
  if (path.dirname(profile) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith("pause-value-")) {
    throw new Error("Refusing to remove unexpected test profile.");
  }
  await rm(profile, { recursive: true, force: true });
}
