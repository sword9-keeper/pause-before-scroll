import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { setupSites } from "./browser-setup.mjs";
import { dayKey } from "../insights.js";
import { emptyReviews, offsetDay, updateReviews } from "../reviews.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const profile = await mkdtemp(path.join(tmpdir(), "pause-reviews-"));
const output = path.join(root, "test-results");
await mkdir(output, { recursive: true });
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium", headless: true, viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
});
const errors = [];
context.on("weberror", event => errors.push(event.error().message));
let networkRequests = 0;
context.on("request", request => { if (/^https?:/.test(request.url())) networkRequests++; });
async function eventually(check, label) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error(`Timed out: ${label}`);
}
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const base = `chrome-extension://${new URL(worker.url()).host}`;
  await setupSites(context, base);
  const stored = async () => (await worker.evaluate(() => chrome.storage.local.get("selfReview"))).selfReview;
  async function open() {
    const page = await context.newPage();
    await page.goto(`${base}/journal.html`);
    await page.locator("#overview-panel").waitFor({ state: "visible" });
    await page.locator("#self-review summary").click();
    await eventually(async () => !await page.locator("#review-definition").isDisabled(), "review loaded");
    return page;
  }
  const page = await open();
  assert.equal(await stored(), undefined);
  assert.equal(await page.locator("#review-enabled").isChecked(), false);
  assert.equal(await page.locator("#review-form").isHidden(), true);
  await page.locator("#review-definition").fill("我本来不想花在短视频和推荐流上的时间，包括手机");
  await page.locator("#review-enabled").check();
  await page.locator('#review-config [type="submit"]').click();
  await eventually(async () => (await page.locator("#review-status").textContent()) === "本机自评设置已保存", "opt-in");
  const today = await page.locator("#review-day").inputValue();
  const yesterday = offsetDay(today, -1);
  assert.equal(await page.locator("#review-minutes").inputValue(), "");
  await page.locator("#review-fit").selectOption("partly");
  await page.locator("#review-save").click();
  await eventually(async () => (await stored()).reports.length === 1, "first report");
  assert.equal((await stored()).reports[0].unwantedMinutes, null);
  assert.ok((await page.locator("#review-periods").textContent()).includes("0 / 7 天"));
  assert.equal((await stored()).reports[0].displacement, "unsure");
  await page.locator("#review-day").fill(yesterday);
  await page.locator("#review-day").dispatchEvent("change");
  await page.locator("#review-minutes").fill("0");
  await page.locator("#review-fit").selectOption("yes");
  await page.locator("#review-protection").selectOption("no");
  await page.locator("#review-interference").selectOption("unused");
  await page.locator("#review-save").click();
  await eventually(async () => (await stored()).reports.length === 2, "intentional zero");
  assert.equal((await stored()).reports[0].unwantedMinutes, 0);
  assert.ok((await page.locator("#review-periods").textContent()).includes("无明确回答"));
  console.log("PASS opt-in, unknown versus zero, incomplete-day exclusion, and unknown adverse-effect denominators");

  const other = await open();
  await page.locator("#review-minutes").fill("17");
  await other.locator("#review-day").fill(yesterday);
  await other.locator("#review-day").dispatchEvent("change");
  await other.locator("#review-minutes").fill("45");
  await other.locator("#review-save").click();
  await eventually(async () => (await page.locator("#review-status").textContent()).includes("另一页面"), "conflict notice");
  assert.equal(await page.locator("#review-minutes").inputValue(), "17");
  await page.locator("#review-save").click();
  await eventually(async () => (await page.locator("#review-status").textContent()).includes("另一页面"), "stale save rejected");
  assert.equal((await stored()).reports[0].unwantedMinutes, 45);
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#review-reload").click();
  await eventually(async () => (await page.locator("#review-minutes").inputValue()) === "45", "fresh values");
  await other.close();
  page.once("dialog", dialog => dialog.accept());
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#review-export").click();
  const download = await downloadPromise;
  const exported = JSON.parse(await readFile(await download.path(), "utf8"));
  assert.equal(exported.kind, "daily-self-review");
  assert.equal(exported.reports.length, 2);
  assert.ok(!("syncConfig" in exported) && !("records" in exported));
  assert.equal(exported.summary.recent.numericDays, 1);
  console.log("PASS two-window conflict protection and a separate, explicitly confirmed local JSON export");

  await page.locator("#review-enabled").uncheck();
  await page.locator('#review-config [type="submit"]').click();
  await eventually(async () => (await stored()).enabled === false, "opt-out");
  assert.equal((await stored()).reports.length, 2);
  await page.reload();
  await page.locator("#self-review summary").click();
  await eventually(async () => !await page.locator("#review-definition").isDisabled(), "reload");
  assert.equal(await page.locator("#review-enabled").isChecked(), false);
  assert.equal((await stored()).reports.length, 2);
  assert.equal(networkRequests, 0);
  console.log("PASS opt-out persists without erasure or automatic re-enrollment, and self-review sends no network requests");

  // Synthetic visual history only. No user participation or efficacy is asserted.
  let fixture = updateReviews(emptyReviews(), {
    type: "reviewConfigure", revision: 0, enabled: true, consent: true,
    definition: "仅用于视觉验收的虚构自评口径，不是用户效果数据。".repeat(5)
  });
  for (let index = 13; index >= 0; index--) {
    const day = offsetDay(dayKey(Date.now()), -index);
    fixture = updateReviews(fixture, { type: "reviewSave", revision: fixture.revision, report: {
      day, unwantedMinutes: index % 4 ? index * 3 : null, fit: "partly", protection: index > 6 ? "no" : "partly",
      displacement: index % 3 ? "unsure" : "yes", interference: index % 2 ? "some" : "unsure"
    } }, new Date(`${day}T20:00:00`).getTime());
  }
  await worker.evaluate(value => chrome.storage.local.set({ selfReview: value }), fixture);
  await eventually(async () => (await page.locator("#review-history .review-row").count()) === 14, "visual fixture");
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: path.join(output, `self-review-${width}.png`), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`);
    assert.ok(await page.locator("#review-save").isEnabled());
    assert.ok(await page.locator("#review-entry-fields input, #review-entry-fields select").evaluateAll(nodes =>
      nodes.every(node => {
        const rect = node.getBoundingClientRect();
        return rect.width > 50 && rect.left >= 0 && rect.right <= innerWidth;
      })));
  }
  await page.locator("#review-fit").focus();
  await page.keyboard.press("Tab");
  assert.equal(await page.locator("#review-protection").evaluate(node => node === document.activeElement), true);
  page.once("dialog", dialog => dialog.dismiss());
  await page.locator("#review-erase").click();
  assert.equal((await stored()).reports.length, 14);
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#review-erase").click();
  await eventually(async () => (await stored()).reports.length === 0, "erase");
  assert.equal((await stored()).enabled, false);
  assert.equal((await stored()).definition, "");
  assert.deepEqual(errors, []);
  console.log("PASS keyboard navigation, 1280/390/320 layouts, deletion cancellation, and explicit complete erasure");
} finally {
  await context.close();
  if (path.dirname(profile) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith("pause-reviews-")) {
    throw new Error("Refusing to remove unexpected self-review-test profile.");
  }
  await rm(profile, { recursive: true, force: true });
}
