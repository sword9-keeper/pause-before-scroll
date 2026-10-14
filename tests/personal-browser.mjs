import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const work = await mkdtemp(path.join(tmpdir(), "pause-personal-"));
const extensionPath = path.join(work, "extension");
await mkdir(extensionPath);
for (const file of ["manifest.json", "core.js", "rules.js", "site-editor.js", "reviews.js", "review-editor.js", "background.js", "sync.js", "install-defaults.js", "insights.js", "vendor", "pause.html", "pause.js", "expiry.js", "timer.js", "journal.html", "journal.js", "style.css"]) {
  await cp(path.join(root, file), path.join(extensionPath, file), { recursive: true });
}
const manifest = JSON.parse(await readFile(path.join(extensionPath, "manifest.json"), "utf8"));
manifest.host_permissions.push("https://dav.example.test/*");
await writeFile(path.join(extensionPath, "manifest.json"), JSON.stringify(manifest));
const preset = {
  enabled: true, url: "https://dav.example.test/back-to-flow/",
  username: "personal-test", password: "fake-test-credential", syncRecords: true
};
await writeFile(path.join(extensionPath, "install-defaults.js"), `export default ${JSON.stringify(preset)};`);
let context;
try {
  context = await chromium.launchPersistentContext(path.join(work, "profile"), {
    channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  await context.route("https://dav.example.test/**", route => route.abort());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const base = `chrome-extension://${new URL(worker.url()).host}`;
  const page = await context.newPage();
  await page.goto(`${base}/journal.html`);
  await page.locator("#sync-tab").click();
  await page.waitForFunction(() => document.querySelector("#sync-enabled").checked &&
    document.querySelector("#sync-password").placeholder.includes("已保存"));
  assert.equal(await page.locator("#sync-url").inputValue(), preset.url);
  assert.equal(await page.locator("#sync-username").inputValue(), preset.username);
  assert.equal(await page.locator("#sync-password").inputValue(), "");
  assert.deepEqual((await worker.evaluate(() => chrome.storage.local.get("syncConfig"))).syncConfig, preset);
  assert.ok(await worker.evaluate(() => chrome.permissions.contains({ origins: ["https://dav.example.test/*"] })));
  assert.equal((await worker.evaluate(() => chrome.alarms.get("webdav-sync"))).periodInMinutes, 5);
  assert.equal((await worker.evaluate(() => chrome.storage.local.get("selfReview"))).selfReview, undefined);
  console.log("PASS personal install seeds credentials, host access and automatic sync without setup");

  await page.locator("#sync-enabled").uncheck();
  await page.locator("#sync-save").click();
  await page.waitForFunction(() => document.querySelector("#status").textContent === "连接已保存");
  const cdp = await context.newCDPSession(page);
  const { targetInfos } = await cdp.send("Target.getTargets");
  const target = targetInfos.find(item => item.type === "service_worker" && item.url === worker.url());
  await cdp.send("Target.closeTarget", { targetId: target.targetId });
  await page.reload();
  await page.locator("#sync-tab").click();
  await page.waitForFunction(() => document.querySelector("#sync-password").placeholder.includes("已保存"));
  assert.equal(await page.locator("#sync-enabled").isChecked(), false);
  console.log("PASS a saved opt-out survives worker restart despite the embedded preset");

  page.once("dialog", dialog => dialog.accept());
  await page.locator("#sync-forget").click();
  await page.waitForFunction(() => document.querySelector("#status").textContent === "本机连接已移除");
  const latest = (await cdp.send("Target.getTargets")).targetInfos.find(item =>
    item.type === "service_worker" && item.url === `${base}/background.js`);
  await cdp.send("Target.closeTarget", { targetId: latest.targetId });
  await page.reload();
  await page.locator("#sync-tab").click();
  await page.waitForFunction(() => document.querySelector("#exit-url").value.length > 0);
  assert.equal(await page.locator("#sync-url").inputValue(), "");
  assert.equal(await page.locator("#sync-enabled").isChecked(), false);
  assert.equal(await page.locator("#sync-password").getAttribute("placeholder"), "");
  console.log("PASS forgetting a personal connection does not silently re-enable it at restart");
  await cdp.detach();
} finally {
  if (context) await context.close();
  if (path.dirname(work) !== path.resolve(tmpdir()) || !path.basename(work).startsWith("pause-personal-")) {
    throw new Error("Refusing to remove unexpected personal-test directory.");
  }
  await rm(work, { recursive: true, force: true });
}
