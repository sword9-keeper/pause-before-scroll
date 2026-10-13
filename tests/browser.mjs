import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcher = path.join(root, "tests", "fixtures", "launcher");
const output = path.join(root, "test-results");
const profile = await mkdtemp(path.join(tmpdir(), "pause-extension-"));
await mkdir(output, { recursive: true });
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  viewport: { width: 1365, height: 900 },
  args: [`--disable-extensions-except=${root},${launcher}`, `--load-extension=${root},${launcher}`]
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

async function navigate(page, url) {
  try {
    await page.goto(url);
  } catch (error) {
    // A background tab update intentionally cancels the original navigation.
    if (!error.message.includes("net::ERR_ABORTED")) throw error;
  }
}

try {
  let worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  const extension = `chrome-extension://${extensionId}`;
  const waitForPause = page => eventually(async () =>
    page.url().startsWith(`${extension}/pause.html#`) &&
    await page.evaluate(() => Boolean(document.querySelector("#leave:not(:disabled)"))).catch(() => false),
  "usable confirmation");
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
    route.fulfill({
      status: 200, contentType: "text/html",
      body: '<title>Exit fixture</title><h1>Exit</h1><a id="outbound" href="https://www.douyin.com/?ug_source=pc_liangxiang_01">Open Douyin</a><a id="new-tab" target="_blank" href="https://www.xiaohongshu.com/explore/test">Open in new tab</a>'
    }));

  const page = await context.newPage();
  await navigate(page, "https://www.douyin.com/");
  await waitForPause(page);
  await page.locator("#leave").waitFor({ state: "visible" });
  await eventually(() => page.locator("#leave").isEnabled(), "pause initialized");
  assert.equal(await page.locator("#destination").textContent(), "即将前往 · 抖音");
  assert.equal((await data()).records.length, 1);
  passed("background navigation opens confirmation and records one attempt");
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

  const floating = page.locator("#pause-before-scroll-timer");
  await floating.getByRole("button", { name: "移动倒计时" }).waitFor();
  const beforeDrag = await floating.boundingBox();
  const grip = await floating.getByRole("button", { name: "移动倒计时" }).boundingBox();
  await page.mouse.move(grip.x + 14, grip.y + 14);
  await page.mouse.down();
  await page.mouse.move(300, 350, { steps: 10 });
  await page.mouse.up();
  const afterDrag = await floating.boundingBox();
  assert.ok(afterDrag.x < beforeDrag.x - 100 && afterDrag.y > 200);
  await floating.getByRole("button", { name: "收起倒计时" }).click();
  assert.ok((await floating.boundingBox()).width < afterDrag.width);
  await page.screenshot({ path: path.join(output, "timer-collapsed.png") });
  await eventually(async () => (await worker.evaluate(() => chrome.storage.local.get("timerLayout"))).timerLayout?.collapsed, "timer layout saved");
  await page.reload();
  await floating.getByRole("button", { name: "展开倒计时" }).waitFor();
  assert.ok((await floating.boundingBox()).y > 200);
  await page.setViewportSize({ width: 390, height: 300 });
  await floating.getByRole("button", { name: "展开倒计时" }).click();
  const narrow = await floating.boundingBox();
  assert.ok(narrow.x >= 0 && narrow.y >= 0 && narrow.x + narrow.width <= 390 && narrow.y + narrow.height <= 300);
  await page.screenshot({ path: path.join(output, "timer-narrow.png") });
  await page.setViewportSize({ width: 1365, height: 900 });
  passed("floating timer drags, collapses, remembers layout, and stays within a resized viewport");

  await page.evaluate(() => {
    const link = document.createElement("a");
    link.id = "related";
    link.href = "https://www.douyin.com/video/related";
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Related video";
    document.body.append(link);
  });
  const childPromise = context.waitForEvent("page");
  await page.locator("#related").click();
  const child = await childPromise;
  await child.waitForURL("https://www.douyin.com/video/related");
  await child.locator("#pause-before-scroll-timer").waitFor();
  await eventually(async () => Object.keys((await session()).state.grants).length === 2, "inherited child grant");
  assert.ok(Object.values((await session()).state.grants).every(grant => grant.expiresAt === firstDeadline));
  assert.equal((await data()).records.length, 1);
  passed("noopener new-tab links inherit the same deadline without a second attempt");
  const grandchildPromise = context.waitForEvent("page");
  await child.evaluate(() => window.open("https://www.douyin.com/video/grandchild", "_blank"));
  const grandchild = await grandchildPromise;
  await grandchild.waitForURL("https://www.douyin.com/video/grandchild");
  await eventually(async () => Object.keys((await session()).state.grants).length === 3, "grandchild grant");
  await child.close();
  await eventually(async () => Object.keys((await session()).state.grants).length === 2, "middle tab closed");
  assert.equal((await data()).records[0].outcome, "active");
  assert.equal((await data()).records.length, 1);
  await grandchild.close();
  await eventually(async () => Object.keys((await session()).state.grants).length === 1, "child closed");
  assert.equal((await data()).records[0].outcome, "active");
  passed("closing a related tab does not finish the remaining visit");

  const second = await context.newPage();
  await navigate(second, "https://www.douyin.com/video/123");
  await waitForPause(second);
  await eventually(() => second.locator("#leave").isEnabled(), "second tab pause");
  passed("new tab does not inherit another tab's grant");
  await second.locator("#leave").click();
  await second.waitForURL("https://www.google.com/");
  assert.equal((await data()).records.at(-1).outcome, "declined");
  passed("decline opens configured destination and records choice");

  await navigate(page, "https://www.xiaohongshu.com/explore/test");
  await waitForPause(page);
  await eventually(() => page.locator("#leave").isEnabled(), "cross-site pause");
  assert.equal((await data()).records[0].outcome, "left");
  assert.equal(Object.keys((await session()).state.grants).length, 0);
  passed("cross-site navigation revokes original grant");
  await page.close();
  await eventually(async () => (await data()).records.at(-1).outcome === "dismissed", "abandoned confirmation");
  passed("closing confirmation records dismissal");

  const playlist = "https://www.bilibili.com/list/ml3197110280?oid=116067095609579&bvid=BV19Scpz3ED5";
  const settingsPage = await context.newPage();
  await settingsPage.goto(`${extension}/journal.html`);
  await settingsPage.locator("#settings-tab").click();
  await settingsPage.locator('[name="expiry-action"][value="close"]').check();
  await settingsPage.locator('#settings-form [type="submit"]').click();
  await eventually(async () => (await data()).settings.expiryAction === "close", "explicit auto-close preference");
  await settingsPage.close();
  const video = await context.newPage();
  await navigate(video, playlist);
  await waitForPause(video);
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
  const expiryChildPromise = context.waitForEvent("page");
  await video.evaluate(() => window.open("https://www.bilibili.com/video/expiry-child", "_blank"));
  const expiryChild = await expiryChildPromise;
  await expiryChild.waitForURL("https://www.bilibili.com/video/expiry-child");
  await eventually(async () => Object.keys((await session()).state.grants).length === 2, "expiry child grant");
  const bothClosed = Promise.all([video.waitForEvent("close", { timeout: 15000 }), expiryChild.waitForEvent("close", { timeout: 15000 })]);
  await second.bringToFront();
  await bothClosed;
  const expired = (await data()).records.at(-1);
  assert.equal(expired.outcome, "expired");
  assert.equal(expired.reason, "验证到期关闭");
  assert.equal(expired.elapsedMs, 6000);
  assert.equal(Object.keys((await session()).state.grants).length, 0);
  passed("related background tabs close together at expiry with one elapsed-time record");

  const repeated = await context.newPage();
  await navigate(repeated, playlist);
  await waitForPause(repeated);
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
  await journal.locator("#records-tab").click();
  await eventually(async () => Number(await journal.locator("#attempt-count").textContent()) > 0, "journal data");
  assert.equal(await journal.locator("#version").textContent(), `v${await worker.evaluate(() => chrome.runtime.getManifest().version)}`);
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
  await journal.locator('#settings-form [type="submit"]').click();
  await eventually(async () => (await journal.locator("#status").textContent()).includes("非受限"), "loop prevention");
  assert.equal((await data()).settings.exitUrl, "https://www.google.com/");
  await journal.locator("#exit-url").fill("https://www.chatgpt.com/");
  await journal.locator("#quote-input").fill("今天只做这一件事。");
  await journal.locator('#settings-form [type="submit"]').click();
  await eventually(async () => (await journal.locator("#status").textContent()) === "已保存", "settings persisted");
  assert.equal((await data()).settings.exitUrl, "https://www.chatgpt.com/");
  passed("settings persist and reject exit redirect loops");
  await journal.screenshot({ path: path.join(output, "settings-mobile.png"), fullPage: true });

  const restore = await context.newPage();
  await navigate(restore, "https://www.douyin.com/");
  await waitForPause(restore);
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
  await restore.goBack().catch(error => {
    if (!error.message.includes("net::ERR_ABORTED")) throw error;
  });
  await waitForPause(restore);
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
  const outbound = await context.newPage();
  await outbound.goto("https://www.google.com/");
  await outbound.locator("#outbound").click();
  try {
    await waitForPause(outbound);
  } catch (error) {
    console.error("External navigation URL:", outbound.url());
    console.error("External navigation body:", await outbound.locator("body").innerText());
    await outbound.screenshot({ path: path.join(output, "external-link-failure.png") });
    throw error;
  }
  assert.equal((await data()).records.length, 1);
  assert.equal((await data()).records[0].siteId, "douyin");
  passed("external website link opens usable confirmation and records an attempt");
  await outbound.locator("#choose").click();
  await outbound.locator("#reason").selectOption("查找资料");
  await outbound.locator("#continue").click();
  await outbound.waitForURL("https://www.douyin.com/?ug_source=pc_liangxiang_01");
  assert.equal((await data()).records[0].outcome, "active");
  passed("external-link confirmation can grant access to the original query URL");
  await outbound.close();
  const source = await context.newPage();
  await source.goto("https://www.google.com/");
  const popupPromise = context.waitForEvent("page");
  await source.locator("#new-tab").click();
  const popup = await popupPromise;
  await waitForPause(popup);
  await eventually(() => popup.locator("#leave").isEnabled(), "external new-tab confirmation");
  assert.equal((await data()).records.at(-1).siteId, "xiaohongshu");
  passed("external target-blank link opens usable confirmation and records an attempt");
  await popup.close();
  const attemptsBeforeFrame = (await data()).records.length;
  await source.evaluate(url => {
    const frame = document.createElement("iframe");
    frame.src = url;
    document.body.append(frame);
  }, `${extension}/pause.html#https://www.douyin.com/`);
  await source.waitForTimeout(500);
  assert.equal(source.url(), "https://www.google.com/");
  assert.equal((await data()).records.length, attemptsBeforeFrame);
  passed("embedded confirmation cannot create attempts or control the parent tab");
  await source.close();
  const extensionLauncher = await context.newPage();
  await extensionLauncher.goto("chrome://newtab/");
  await extensionLauncher.locator("#outbound").waitFor();
  const attemptsBeforeLauncher = (await data()).records.length;
  await extensionLauncher.locator("#outbound").click();
  try {
    await waitForPause(extensionLauncher);
  } catch (error) {
    console.error("Extension launcher navigation URL:", extensionLauncher.url());
    console.error("Extension launcher navigation body:", await extensionLauncher.locator("body").innerText());
    await extensionLauncher.screenshot({ path: path.join(output, "extension-launcher-failure.png") });
    throw error;
  }
  assert.equal((await data()).records.length, attemptsBeforeLauncher + 1);
  passed("third-party extension new-tab link opens usable confirmation and records an attempt");
  await extensionLauncher.close();

  const brokenUI = await context.newPage();
  let scriptBlocked = false;
  await brokenUI.route(`${extension}/pause.js`, route => {
    scriptBlocked = true;
    return route.abort();
  });
  const beforeBrokenUI = (await data()).records.length;
  await navigate(brokenUI, "https://www.douyin.com/?no-ui=1");
  await eventually(async () =>
    brokenUI.url().startsWith(`${extension}/pause.html#`) &&
    (await data()).records.length === beforeBrokenUI + 1, "attempt without confirmation script");
  await eventually(() => scriptBlocked, "confirmation script intentionally blocked");
  assert.equal((await data()).records.at(-1).outcome, "pending");
  assert.equal(await brokenUI.locator("#leave").isEnabled(), false);
  passed("the attempt is recorded even when the confirmation script cannot load");
  await brokenUI.close();

  const pendingRestore = await context.newPage();
  await navigate(pendingRestore, "https://www.douyin.com/?pending-restart=1");
  await waitForPause(pendingRestore);
  const beforePendingRestart = (await data()).records.length;
  const restartSession = await context.newCDPSession(journal);
  const targets = await restartSession.send("Target.getTargets");
  const activeWorker = targets.targetInfos.find(target => target.type === "service_worker" && target.url === worker.url());
  await worker.evaluate(() => { globalThis.__restartProof = true; });
  await restartSession.send("Target.closeTarget", { targetId: activeWorker.targetId });
  await pendingRestore.reload();
  await waitForPause(pendingRestore);
  worker = context.serviceWorkers().find(candidate => candidate.url() === `${extension}/background.js`);
  assert.equal(await worker.evaluate(() => globalThis.__restartProof), undefined);
  assert.equal((await data()).records.length, beforePendingRestart);
  passed("pending confirmation survives worker restart without duplicating its record");
  await pendingRestore.close();
  await restartSession.detach();

  const rapidStart = (await data()).records.length;
  for (let index = 0; index < 5; index++) {
    const rapid = await context.newPage();
    await navigate(rapid, `https://www.douyin.com/?cycle=${index}`);
    await waitForPause(rapid);
    await rapid.locator("#choose").click();
    await rapid.locator("#reason").selectOption("查找资料");
    await rapid.locator("#continue").click();
    await rapid.waitForURL(`https://www.douyin.com/?cycle=${index}`);
    await rapid.close();
  }
  await eventually(async () => (await data()).records.at(-1).outcome === "closed", "last rapid visit closed");
  const rapidRecords = (await data()).records.slice(rapidStart);
  assert.equal(rapidRecords.length, 5);
  assert.ok(rapidRecords.every(record => record.outcome === "closed"));
  passed("repeated visit/approve/close cycles do not duplicate attempts or re-block approval");
  assert.deepEqual(errors, []);
  passed("no uncaught page errors");
  console.log(`\n${checks} browser checks passed. Screenshots: ${output}`);
} catch (error) {
  for (const page of context.pages()) {
    console.error("Failed-test page:", page.url());
    console.error(await page.locator("body").innerText({ timeout: 1000 }).catch(() => "(unavailable)"));
  }
  const worker = context.serviceWorkers()[0];
  if (worker) {
    console.error("Failed-test session:", await worker.evaluate(() => chrome.storage.session.get(null)).catch(() => null));
  }
  throw error;
} finally {
  await context.close();
  if (path.dirname(profile) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith("pause-extension-")) {
    throw new Error("Refusing to remove an unexpected browser profile path.");
  }
  await rm(profile, { recursive: true, force: true });
}
