import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const profile = await mkdtemp(path.join(tmpdir(), "pause-expiry-"));
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
  await context.route(/^https:\/\/www\.(douyin|google)\.com\//, route => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html lang="en"><meta charset="utf-8"><title>Local expiry fixture</title>
      <style>body{font:16px system-ui;margin:28px;background:#f2f6f3;color:#244334}
      textarea{display:block;width:90%;height:100px}video{display:block;max-width:100%;margin-top:24px}</style>
      <h1>Unsubmitted draft</h1><textarea id="draft" aria-label="Draft"></textarea>
      <video id="media" width="360" height="160" muted></video><p>Local test content only.</p></html>`
  }));
  let worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const base = `chrome-extension://${new URL(worker.url()).host}`;
  const data = () => worker.evaluate(() => chrome.storage.local.get(["records", "settings"]));
  const state = async () => (await worker.evaluate(() => chrome.storage.session.get("state"))).state;
  async function enter() {
    const page = await context.newPage();
    await page.goto("https://www.douyin.com/").catch(error => {
      if (!error.message.includes("ERR_ABORTED")) throw error;
    });
    await page.locator("#choose").click();
    await page.locator("#reason").selectOption("查找资料");
    await page.locator('[name="duration"][value="custom"]').check();
    await page.locator("#custom-minutes").fill("0.1");
    await page.locator("#continue").click();
    await page.waitForURL("https://www.douyin.com/");
    await page.locator("#pause-before-scroll-timer").waitFor();
    return page;
  }
  const page = await enter();
  assert.equal((await data()).settings.expiryAction, "pause");
  await page.locator("#draft").fill("This draft must survive expiry and continuation.");
  const token = await page.evaluate(async () => {
    window.pageToken = crypto.randomUUID();
    const canvas = document.createElement("canvas");
    canvas.width = 360;
    canvas.height = 160;
    const drawing = canvas.getContext("2d");
    drawing.fillStyle = "#447a9b";
    drawing.fillRect(0, 0, 360, 160);
    drawing.fillStyle = "#fff";
    drawing.font = "18px sans-serif";
    drawing.fillText("Local playing video fixture", 40, 90);
    const media = document.querySelector("#media");
    media.srcObject = canvas.captureStream(10);
    await media.play();
    return window.pageToken;
  });
  assert.equal(await page.locator("#media").evaluate(media => media.paused), false);
  const childPromise = context.waitForEvent("page");
  await page.evaluate(() => window.open("https://www.douyin.com/child", "_blank"));
  const child = await childPromise;
  await child.waitForURL("https://www.douyin.com/child");
  await child.locator("#pause-before-scroll-timer").waitFor();
  const away = await context.newPage();
  await away.goto("https://www.google.com/");
  const prompt = page.locator("#pause-before-scroll-expiry");
  const childPrompt = child.locator("#pause-before-scroll-expiry");
  await prompt.locator("dialog").waitFor({ state: "visible" });
  await childPrompt.locator("dialog").waitFor({ state: "visible" });
  assert.equal(await prompt.locator("#expiry-title").evaluate(title => title.getRootNode().activeElement === title), true);
  assert.equal(await page.evaluate(() => window.pageToken), token);
  assert.equal(await page.locator("#draft").inputValue(), "This draft must survive expiry and continuation.");
  assert.equal(await page.locator("#media").evaluate(media => media.paused), true);
  assert.equal((await data()).records.length, 1);
  assert.equal((await data()).records[0].outcome, "expired");
  assert.equal((await data()).records[0].elapsedMs, 6000);
  assert.equal(Object.keys((await state()).paused).length, 2);
  const muted = await worker.evaluate(() => chrome.tabs.query({}));
  assert.ok(muted.filter(tab => tab.url?.startsWith("https://www.douyin.com/")).every(tab => tab.mutedInfo.muted));
  const observed = (await data()).records[0].foregroundMs;
  await page.waitForTimeout(1000);
  assert.equal((await data()).records[0].foregroundMs, observed);
  console.log("PASS default expiry retains drafts and document identity, pauses media, mutes linked tabs, and freezes completed measurements");

  await page.bringToFront();
  await page.keyboard.press("Enter");
  assert.ok(!page.isClosed() && !child.isClosed());
  page.once("dialog", dialog => {
    assert.match(dialog.message(), /2 个/);
    return dialog.dismiss();
  });
  await prompt.getByRole("button", { name: "结束并关闭", exact: true }).click();
  assert.ok(!page.isClosed() && !child.isClosed() && !away.isClosed());
  await page.keyboard.press("Escape");
  assert.equal(await prompt.getByRole("button", { name: "先保存内容 · 2 分钟", exact: true }).evaluate(button =>
    button.getRootNode().activeElement === button), true);
  const focusedCommands = new Set();
  for (let index = 0; index < 10; index++) {
    await page.keyboard.press("Tab");
    const focus = await prompt.locator("dialog").evaluate(dialog => ({
      contained: dialog.contains(dialog.getRootNode().activeElement),
      browserChrome: !document.hasFocus() && document.activeElement === document.body,
      command: dialog.getRootNode().activeElement?.textContent
    }));
    assert.ok(focus.contained || focus.browserChrome, JSON.stringify(focus));
    if (focus.contained) focusedCommands.add(focus.command);
  }
  assert.equal(focusedCommands.size, 3);
  await page.screenshot({ path: path.join(output, "expiry-desktop.png") });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 568 });
    await page.screenshot({ path: path.join(output, `expiry-${width}.png`) });
    const bounds = await prompt.locator("dialog").boundingBox();
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= 568);
    assert.ok(await prompt.locator("dialog").evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth));
  }

  const journal = await context.newPage();
  await journal.goto(`${base}/journal.html`);
  const cdp = await context.newCDPSession(journal);
  const target = (await cdp.send("Target.getTargets")).targetInfos.find(item => item.type === "service_worker" && item.url === worker.url());
  await worker.evaluate(() => { globalThis.__expiryTest = true; });
  await cdp.send("Target.closeTarget", { targetId: target.targetId });
  await journal.reload();
  await eventually(async () => {
    worker = context.serviceWorkers().find(item => item.url() === `${base}/background.js`);
    return worker && await worker.evaluate(() => globalThis.__expiryTest === undefined).catch(() => false);
  }, "worker restarted");
  await eventually(async () => Object.keys((await state()).paused).length === 2, "paused state restored");
  assert.equal((await data()).records.length, 1);
  assert.equal(await page.evaluate(() => window.pageToken), token);
  console.log("PASS keyboard focus and narrow dialog layouts remain usable; cancellation and worker restart preserve both pages");

  await page.bringToFront();
  await prompt.getByRole("button", { name: "再安排一段时间", exact: true }).click();
  await prompt.locator("#resume-reason").fill("保存待提交的回复，检查完就结束");
  await prompt.locator('[name="resume-duration"][value="custom"]').check();
  await prompt.locator("#resume-minutes").fill("0.1");
  await page.screenshot({ path: path.join(output, "expiry-resume-320.png") });
  assert.ok(await prompt.locator("dialog").evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth));
  await prompt.getByRole("button", { name: "开始这段时间", exact: true }).click();
  await prompt.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => window.pageToken), token);
  assert.equal(await page.locator("#draft").inputValue(), "This draft must survive expiry and continuation.");
  assert.equal(await page.locator("#media").evaluate(media => media.paused), true);
  assert.equal(Object.keys((await state()).grants).length, 1);
  assert.equal(Object.keys((await state()).paused).length, 1);
  assert.equal((await data()).records.length, 2);
  assert.equal((await data()).records[1].reason, "保存待提交的回复，检查完就结束");
  await childPrompt.locator("dialog").waitFor({ state: "visible" });
  const tabs = await worker.evaluate(() => chrome.tabs.query({}));
  assert.equal(tabs.find(tab => tab.url === "https://www.douyin.com/").mutedInfo.muted, false);
  assert.equal(tabs.find(tab => tab.url === "https://www.douyin.com/child").mutedInfo.muted, true);
  await prompt.locator("dialog").waitFor({ state: "visible" });
  const closedChild = child.waitForEvent("close");
  await childPrompt.getByRole("button", { name: "结束并关闭", exact: true }).click();
  await closedChild;
  assert.ok(!page.isClosed() && !away.isClosed());
  console.log("PASS explicit continuation preserves the original draft, resumes only one tab, and never restarts media automatically");

  await prompt.getByRole("button", { name: "先保存内容 · 2 分钟", exact: true }).click();
  await prompt.waitFor({ state: "detached" });
  assert.equal((await data()).records[2].reason, "保存当前页面内容");
  assert.equal((await data()).records[2].plannedMs, 120000);
  await page.bringToFront();
  await eventually(async () => {
    const current = await state();
    return current.attention?.snapshot?.foregroundMs >= 4000;
  }, "recovery is measured, not free invisible time");
  await page.locator("#draft").fill("Now saved by the user.");

  const full = await enter();
  await full.evaluate(() => {
    const button = document.createElement("button");
    button.id = "fullscreen";
    button.textContent = "Fullscreen fixture";
    button.onclick = () => document.documentElement.requestFullscreen();
    document.body.append(button);
  });
  await full.locator("#fullscreen").click();
  await full.waitForFunction(() => Boolean(document.fullscreenElement));
  await full.locator("#pause-before-scroll-expiry dialog").waitFor({ state: "visible" });
  await full.waitForFunction(() => !document.fullscreenElement);
  await full.reload().catch(error => {
    if (!error.message.includes("ERR_ABORTED")) throw error;
  });
  await full.locator("#leave").waitFor({ state: "visible" });
  assert.ok(full.url().startsWith(`${base}/pause.html#`));
  await full.close();
  console.log("PASS expiry exits document fullscreen and an explicit reload returns to the normal entry decision");

  await journal.locator("#settings-tab").click();
  await journal.locator('[name="enabled-site"][value="douyin"]').uncheck();
  await journal.locator('#settings-form [type="submit"]').click();
  await eventually(async () => Object.keys((await state()).grants).length === 0, "disabled site releases recovery");
  await page.locator("#pause-before-scroll-timer").waitFor({ state: "detached" });
  assert.ok(!page.isClosed());
  assert.equal(await page.locator("#draft").inputValue(), "Now saved by the user.");
  assert.deepEqual(errors, []);
  await cdp.detach();
  console.log("PASS the two-minute save interval is separately measured; disabling the site releases it without closing or reloading");
} finally {
  await context.close();
  if (path.dirname(profile) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith("pause-expiry-")) {
    throw new Error("Refusing to remove unexpected expiry-test profile.");
  }
  await rm(profile, { recursive: true, force: true });
}
