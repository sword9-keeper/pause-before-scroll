import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// This is a real public player, not a synthetic media stream. A site's own
// login prompt or pause invalidates the near-deadline playback evidence.
export async function runLiveVideoCheck(context, worker, output) {
  const stored = await worker.evaluate(() => chrome.storage.local.get(["syncConfig", "records"]));
  assert.ok(!stored.syncConfig?.enabled, "Live video tests must not upload records.");
  const previousIds = new Set((stored.records || []).map(record => record.id));
  await mkdir(output, { recursive: true });
  const target = "https://www.bilibili.com/video/BV19Scpz3ED5/?t=0";
  const report = {
    target, startedAt: new Date().toISOString(), status: "running", samples: [],
    extensionVersion: await worker.evaluate(() => chrome.runtime.getManifest().version),
    browser: context.browser().version(), visualReview: "pending"
  };
  const page = await context.newPage();
  try {
    await page.goto(target, { waitUntil: "domcontentloaded" }).catch(error => {
      if (!error.message.includes("ERR_ABORTED")) throw error;
    });
    await page.locator("#choose").click();
    await page.locator("#reason").selectOption("查找资料");
    await page.locator('[name="duration"][value="custom"]').check();
    await page.locator("#custom-minutes").fill("0.3");
    await page.locator("#continue").click();
    await page.waitForFunction(() => document.querySelector("video")?.readyState >= 2, undefined, { timeout: 12000 });
    if (await page.locator("video").first().evaluate(video => video.paused)) {
      await page.locator('[aria-label="播放/暂停"]').click();
    }
    await page.locator('[aria-label="全屏"]').click();
    await page.waitForFunction(() => Boolean(document.fullscreenElement));
    await page.screenshot({ path: path.join(output, "playing-fullscreen.png") });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const sample = await page.evaluate(() => {
        const video = document.querySelector("video");
        return {
          time: Date.now(), timeOrigin: performance.timeOrigin,
          fullscreen: Boolean(document.fullscreenElement),
          promptOpen: Boolean(document.querySelector("#pause-before-scroll-expiry")?.shadowRoot.querySelector("dialog[open]")),
          paused: video?.paused, readyState: video?.readyState, mediaTime: video?.currentTime
        };
      });
      report.samples.push(sample);
      if (sample.promptOpen && !sample.fullscreen && sample.paused) break;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    const after = report.samples.at(-1);
    const before = report.samples.filter(sample => !sample.promptOpen && !sample.paused &&
      sample.readyState >= 2 && sample.fullscreen && after.time - sample.time <= 1200);
    assert.ok(after.promptOpen && !after.fullscreen && after.paused, "Expiry did not show a usable pause outside fullscreen.");
    assert.ok(before.length, "No actual fullscreen playback immediately before expiry; a site/login pause may have intervened.");
    assert.ok(report.samples.filter(sample => !sample.paused).length >= 2);
    assert.ok(report.samples.some(sample => after.mediaTime - sample.mediaTime > 0.5), "Video progress was not observed.");
    assert.ok(report.samples.every(sample => sample.timeOrigin === after.timeOrigin), "The player document was replaced.");
    const tabs = (await worker.evaluate(() => chrome.tabs.query({}))).filter(tab => tab.url === page.url());
    assert.equal(tabs.length, 1);
    assert.equal(tabs[0].mutedInfo.muted, true);
    report.mutedAtExpiry = true;
    const visits = (await worker.evaluate(() => chrome.storage.local.get("records"))).records.filter(record => !previousIds.has(record.id));
    assert.equal(visits.length, 1);
    assert.equal(visits[0].outcome, "expired");
    assert.equal(visits[0].elapsedMs, 18000);
    report.record = { outcome: visits[0].outcome, elapsedMs: visits[0].elapsedMs };
    await page.screenshot({ path: path.join(output, "expired-after-fullscreen.png") });
    await page.locator("#pause-before-scroll-expiry").getByRole("button", { name: "先保存内容 · 2 分钟", exact: true }).click();
    await page.locator("#pause-before-scroll-expiry").waitFor({ state: "detached" });
    report.pausedAfterResume = await page.locator("video").first().evaluate(video => video.paused);
    assert.equal(report.pausedAfterResume, true, "Explicit continuation must not auto-play the video.");
    assert.equal(await page.evaluate(() => performance.timeOrigin), after.timeOrigin);
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = error.message;
    if (!page.isClosed()) await page.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
  } finally {
    report.finishedAt = new Date().toISOString();
    await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
    if (!page.isClosed()) await page.close();
  }
  return report;
}
