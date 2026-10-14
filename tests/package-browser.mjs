import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { checkPublicSource } from "../scripts/check-public.mjs";
import { setupSites } from "./browser-setup.mjs";

if (!process.argv[2]) throw new Error("Usage: npm run test:package -- <extracted-public-package-directory>");
const extensionPath = path.resolve(process.argv[2]);
const root = fileURLToPath(new URL("../", import.meta.url));
assert.notEqual(extensionPath.toLowerCase(), path.resolve(root).toLowerCase(), "Test the extracted package, not the source directory.");
const checked = await checkPublicSource(extensionPath);
const output = path.join(root, "test-results", `package-${checked.version}`);
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), "pause-package-"));
const report = {
  version: checked.version, startedAt: new Date().toISOString(), status: "running",
  scope: "Extracted public ZIP in isolated Windows Chromium; synthetic website; not regular Chrome or macOS acceptance.",
  manifestHash: createHash("sha256").update(await readFile(path.join(extensionPath, "manifest.json"))).digest("hex"),
  visualReview: "pending"
};
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: true, viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  report.browser = context.browser().version();
  const errors = [];
  context.on("weberror", event => errors.push(event.error().message));
  await context.route(/^https?:\/\//, route => {
    if (route.request().url() !== "https://www.bilibili.com/") return route.abort();
    return route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Package test</title><h1>合成安装测试</h1><label for="draft">测试输入</label><textarea id="draft"></textarea></html>'
    });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const base = `chrome-extension://${new URL(worker.url()).host}`;
  const journal = await context.newPage();
  await journal.goto(`${base}/journal.html#sites`);
  await journal.waitForFunction(version => document.querySelector("#version")?.textContent === `v${version}`, checked.version);
  assert.equal((await worker.evaluate(() => chrome.storage.local.get("syncConfig"))).syncConfig?.enabled || false, false);
  await journal.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
  await setupSites(context, base);

  const visit = await context.newPage();
  await visit.goto("https://www.bilibili.com/").catch(error => {
    if (!error.message.includes("ERR_ABORTED")) throw error;
  });
  await visit.waitForFunction(() => document.querySelector("#choose")?.disabled === false);
  await visit.locator("#choose").click();
  await visit.locator("#reason").selectOption("__custom__");
  await visit.locator("#custom-reason").fill("Synthetic package smoke test");
  await visit.locator('[name="duration"][value="custom"]').check();
  await visit.locator("#custom-minutes").fill("0.1");
  await visit.locator("#continue").click();
  await visit.locator("#draft").fill("preserved-package-draft");
  const timeOrigin = await visit.evaluate(() => performance.timeOrigin);
  await visit.locator("#pause-before-scroll-expiry dialog").waitFor();
  assert.equal(await visit.locator("#draft").inputValue(), "preserved-package-draft");
  assert.equal(await visit.evaluate(() => performance.timeOrigin), timeOrigin);
  const records = (await worker.evaluate(() => chrome.storage.local.get("records"))).records;
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, "expired");
  await visit.screenshot({ path: path.join(output, "expired.png") });

  const privacyPromise = context.waitForEvent("page");
  await journal.getByRole("link", { name: "数据与隐私", exact: true }).click();
  const privacy = await privacyPromise;
  await privacy.waitForURL(`${base}/privacy.html`);
  await privacy.setViewportSize({ width: 390, height: 800 });
  await privacy.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
  assert.ok(await privacy.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.equal(await privacy.locator("script,iframe").count(), 0);
  await privacy.screenshot({ path: path.join(output, "privacy-390.png") });
  assert.deepEqual(errors, []);
  report.status = "passed";
  console.log("PASS extracted public ZIP: worker, version, icons, opt-in sync, entry decision, six-second expiry, draft/document preservation, record and privacy page");
} catch (error) {
  report.status = "failed";
  report.error = error.message;
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  if (context) await context.close();
  if (path.dirname(profile) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith("pause-package-")) {
    throw new Error("Refusing to remove an unexpected package test profile.");
  }
  await rm(profile, { recursive: true, force: true });
}
