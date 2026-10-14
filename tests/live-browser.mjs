import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import installDefaults from "../install-defaults.js";
import { runLiveVideoCheck } from "./live-video.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const sites = [
  { id: "bilibili", url: "https://www.bilibili.com/", name: "哔哩哔哩" },
  { id: "douyin", url: "https://www.douyin.com/", name: "抖音" },
  { id: "xiaohongshu", url: "https://www.xiaohongshu.com/explore", name: "小红书" }
];
const origins = sites.map(site => `*://*.${new URL(site.url).hostname.replace(/^www\./, "")}/*`);

async function eventually(check, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}

async function navigate(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(error => {
    if (!error.message.includes("ERR_ABORTED")) throw error;
  });
}

async function documentState(page) {
  return page.evaluate(() => ({
    url: location.href, timeOrigin: performance.timeOrigin, title: document.title,
    visibleCharacters: document.body?.innerText.length || 0,
    media: [...document.querySelectorAll("video,audio")].map(media => ({
      paused: media.paused, ended: media.ended, readyState: media.readyState,
      currentTime: media.currentTime
    }))
  }));
}

// Native approval stays human-operated. Do not substitute developerPrivate,
// permissions stubs, or a modified manifest for this part of the acceptance test.
export async function requestNativeConsent(context, worker, output) {
  const base = `chrome-extension://${new URL(worker.url()).host}`;
  await eventually(() => context.pages().some(page => page.url() === `${base}/journal.html#sites`), "first-run page");
  const journal = context.pages().find(page => page.url() === `${base}/journal.html#sites`);
  await journal.locator("#site-save").waitFor();
  assert.deepEqual((await worker.evaluate(() => chrome.permissions.getAll())).origins, []);
  for (const site of sites) await journal.locator(`[name="enabled-site"][value="${site.id}"]`).check();
  await journal.screenshot({ path: path.join(output, "native-before-request.png"), fullPage: true });
  await journal.locator("#site-save").click();
  console.log("HUMAN ACTION 1/2: click Deny in the native Chromium permission dialog.");
  await eventually(() => journal.locator("#site-save").isEnabled(), "human denial", 180000);
  assert.match(await journal.locator("#status").textContent(), /未获得/);
  assert.deepEqual((await worker.evaluate(() => chrome.permissions.getAll())).origins, []);
  for (const site of sites) assert.ok(await journal.locator(`[name="enabled-site"][value="${site.id}"]`).isChecked());
  assert.deepEqual((await worker.evaluate(() => chrome.storage.local.get("settings"))).settings.enabledSites, []);
  await journal.screenshot({ path: path.join(output, "native-denied-draft-retained.png"), fullPage: true });
  console.log("PASS native denial retained the draft and granted no access.");

  await journal.locator("#site-save").click();
  console.log("HUMAN ACTION 2/2: click Allow in the native Chromium permission dialog.");
  await eventually(() => journal.locator("#site-save").isEnabled(), "human approval", 180000);
  assert.equal(await journal.locator("#status").textContent(), "网站配置已保存");
  assert.deepEqual(new Set((await worker.evaluate(() => chrome.permissions.getAll())).origins), new Set(origins));
  await journal.screenshot({ path: path.join(output, "native-approved.png"), fullPage: true });
  console.log("PASS native approval enabled only the selected sites.");
  return { denialVerified: true, approvalVerified: true };
}

export async function runLiveChecks(context, worker, output, nativePermission) {
  assert.equal(installDefaults, null, "Live tests must not contain a private WebDAV preset.");
  const local = await worker.evaluate(() => chrome.storage.local.get(["settings", "syncConfig"]));
  assert.ok(!local.syncConfig?.enabled, "Live website checks must not upload records.");
  assert.equal(local.settings.expiryAction, "pause");
  assert.deepEqual(new Set((await worker.evaluate(() => chrome.permissions.getAll())).origins), new Set(origins));
  await mkdir(output, { recursive: true });
  const base = `chrome-extension://${new URL(worker.url()).host}`;
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const report = {
    startedAt: new Date().toISOString(), extensionVersion: manifest.version,
    timerSha256: createHash("sha256").update(await readFile(path.join(root, "timer.js"))).digest("hex"),
    browser: context.browser().version(), platform: platform(),
    environment: "isolated headed Chromium; real public websites; no response mocking",
    nativePermission, status: "running", visualReview: "pending", scenarios: [],
    limitations: [
      "No personal cookies, authenticated accounts, private WebDAV, or telemetry.",
      "Page screenshots do not include native browser permission dialogs.",
      "A login screen or an HTTP error is not evidence of usable playback.",
      "Playback suspension is observed only when media was actually playing beforehand.",
      "Real draft preservation, fullscreen, macOS and behavioral efficacy need separate verification."
    ]
  };
  const saveReport = () => writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  await saveReport();
  for (const site of sites) {
    const result = { site: site.id, target: site.url, status: "running", documents: [], checkpoints: [] };
    report.scenarios.push(result);
    const page = await context.newPage();
    page.on("response", response => {
      if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
        // Only public test-document status is recorded; never capture headers, cookies or bodies.
        const url = new URL(response.url());
        result.documents.push({ origin: url.origin, pathname: url.pathname, status: response.status() });
      }
    });
    try {
      const before = new Set((await worker.evaluate(() => chrome.storage.local.get("records"))).records.map(record => record.id));
      await navigate(page, site.url);
      await page.locator("#choose").waitFor();
      await eventually(() => page.locator("#choose").isEnabled(), "confirmation initialized");
      assert.equal(page.url(), `${base}/pause.html#${site.url}`);
      assert.ok((await page.locator("#destination").textContent()).includes(site.name));
      result.checkpoints.push("real-navigation-intercepted");
      await page.screenshot({ path: path.join(output, `${site.id}-gate.png`) });
      await page.locator("#choose").click();
      await page.locator("#reason").selectOption("查找资料");
      await page.locator('[name="duration"][value="custom"]').check();
      await page.locator("#custom-minutes").fill("0.8");
      await page.locator("#continue").click();
      const timer = page.locator("#pause-before-scroll-timer");
      await timer.waitFor({ timeout: 30000 });
      await page.waitForFunction(() => (document.body?.innerText.length || 0) > 100, undefined, { timeout: 25000 });
      result.beforeExpiry = await documentState(page);
      const response = result.documents.at(-1);
      assert.ok(response && response.status >= 200 && response.status < 400,
        "No successful real-site document response; do not count an error page as acceptance.");
      assert.ok(result.beforeExpiry.visibleCharacters > 100, "Real page content has not rendered.");
      assert.ok(!await page.locator("#pause-before-scroll-expiry dialog").isVisible(),
        "The site did not become usable before the deadline.");
      result.checkpoints.push("real-page-rendered-with-timer");
      result.playbackObserved = result.beforeExpiry.media.some(media => !media.paused && !media.ended && media.readyState >= 2);
      result.timerLayout = await timer.evaluate(host => {
        const label = host.shadowRoot.querySelector(".label");
        const clock = host.shadowRoot.querySelector(".clock");
        const bounds = host.getBoundingClientRect();
        return {
          hostWidth: bounds.width, hostLeft: bounds.left, hostRight: bounds.right,
          viewportWidth: document.documentElement.clientWidth,
          labelHeight: label.getBoundingClientRect().height,
          labelLineHeight: parseFloat(getComputedStyle(label).lineHeight),
          clockWidth: clock.getBoundingClientRect().width, clockHeight: clock.getBoundingClientRect().height,
          controlsHittable: [...host.shadowRoot.querySelectorAll("button")].every(button => {
            const box = button.getBoundingClientRect();
            return box.left >= bounds.left && box.right <= bounds.right + 0.5 &&
              host.shadowRoot.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === button;
          })
        };
      });
      assert.ok(result.timerLayout.hostLeft >= 0 && result.timerLayout.hostRight <= result.timerLayout.viewportWidth);
      assert.ok(result.timerLayout.labelHeight <= result.timerLayout.labelLineHeight + 1, "Timer label unexpectedly wraps.");
      assert.ok(result.timerLayout.controlsHittable, "A timer control is outside its frame or cannot receive clicks.");
      await page.screenshot({ path: path.join(output, `${site.id}-active.png`) });
      await timer.getByRole("button", { name: "收起倒计时", exact: true }).click();
      await timer.getByRole("button", { name: "展开倒计时", exact: true }).waitFor();
      await page.screenshot({ path: path.join(output, `${site.id}-collapsed.png`) });
      await timer.getByRole("button", { name: "展开倒计时", exact: true }).click();

      const prompt = page.locator("#pause-before-scroll-expiry");
      await prompt.locator("dialog").waitFor({ state: "visible", timeout: 60000 });
      result.afterExpiry = await documentState(page);
      assert.equal(result.afterExpiry.timeOrigin, result.beforeExpiry.timeOrigin, "Expiry must not replace the real document.");
      assert.ok(result.afterExpiry.media.every(media => media.paused || media.ended), "Top-level media did not pause.");
      const visits = (await worker.evaluate(() => chrome.storage.local.get("records"))).records.filter(record => !before.has(record.id));
      assert.equal(visits.length, 1);
      assert.equal(visits[0].outcome, "expired");
      assert.equal(visits[0].elapsedMs, 48000);
      result.record = { outcome: visits[0].outcome, elapsedMs: visits[0].elapsedMs, foregroundMs: visits[0].foregroundMs };
      result.checkpoints.push("same-document-expiry-and-one-completed-record");
      result.playbackPause = result.playbackObserved ? "observed" : "not-exercised";
      await page.screenshot({ path: path.join(output, `${site.id}-expired.png`) });
      await page.setViewportSize({ width: 390, height: 700 });
      const bounds = await prompt.locator("dialog").boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 390 && bounds.y + bounds.height <= 700);
      await page.screenshot({ path: path.join(output, `${site.id}-expired-390.png`) });

      await prompt.getByRole("button", { name: "先保存内容 · 2 分钟", exact: true }).click();
      await prompt.waitFor({ state: "detached" });
      assert.equal((await documentState(page)).timeOrigin, result.beforeExpiry.timeOrigin);
      await timer.waitFor();
      result.checkpoints.push("explicit-resumption-without-document-reload");
      await page.screenshot({ path: path.join(output, `${site.id}-resumed-390.png`) });
      await Promise.all([
        page.waitForEvent("close"),
        timer.getByRole("button", { name: "结束并关闭", exact: true }).click()
      ]);
      await eventually(async () => {
        const current = (await worker.evaluate(() => chrome.storage.local.get("records"))).records;
        return current.filter(record => !before.has(record.id)).some(record => record.finishIntent === "done");
      }, "deliberate end recorded");
      result.checkpoints.push("deliberate-end-closes-only-test-tab");
      result.status = "passed";
      console.log(`PASS live functional checks: ${site.id}; playback pause: ${result.playbackPause}. Visual review pending.`);
    } catch (error) {
      result.status = "failed";
      result.error = error.message;
      console.error(`FAIL live checks: ${site.id}: ${error.message}`);
      if (!page.isClosed()) {
        result.failureState = await documentState(page).catch(() => null);
        await page.screenshot({ path: path.join(output, `${site.id}-failure.png`) }).catch(() => {});
      }
    } finally {
      if (!page.isClosed()) await page.close();
      await saveReport();
    }
  }
  report.finishedAt = new Date().toISOString();
  report.status = report.scenarios.some(result => result.status !== "passed") ? "functional-checks-failed" :
    !nativePermission?.denialVerified || !nativePermission?.approvalVerified ? "native-checks-incomplete" :
      "awaiting-visual-review";
  await saveReport();
  return report;
}

if (typeof process !== "undefined" && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { chromium } = await import("playwright");
  assert.equal(installDefaults, null, "Refusing a private preset in live website tests.");
  const output = path.join(root, "test-results", `live-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(output, { recursive: true });
  const profile = await mkdtemp(path.join(output, "profile-"));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: "chromium", headless: false, locale: "zh-CN", timezoneId: "Asia/Shanghai",
      viewport: { width: 1280, height: 800 },
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const consent = await requestNativeConsent(context, worker, output);
    const report = await runLiveChecks(context, worker, output, consent);
    const video = await runLiveVideoCheck(context, worker, path.join(output, "video"));
    if (report.status === "functional-checks-failed" || video.status !== "passed") process.exitCode = 1;
    console.log(`Evidence: ${output}. Site checks: ${report.status}; video: ${video.status}. Visual review remains separate.`);
  } catch (error) {
    await writeFile(path.join(output, "interrupted.json"), JSON.stringify({
      status: "incomplete", time: new Date().toISOString(), error: error.message
    }, null, 2));
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    if (context) await context.close();
  }
}
