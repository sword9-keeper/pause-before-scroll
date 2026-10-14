import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { authorize } from "./browser-setup.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const profile = await mkdtemp(path.join(tmpdir(), "pause-sites-"));
const output = path.join(root, "test-results");
await mkdir(output, { recursive: true });
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium", headless: true, viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
});
const errors = [];
context.on("weberror", event => errors.push(event.error().message));
async function eventually(check, label) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error(`Timed out: ${label}`);
}
async function navigate(page, url) {
  await page.goto(url).catch(error => {
    if (!error.message.includes("ERR_ABORTED")) throw error;
  });
}

try {
  await context.route(/^https:\/\/(.*\.)?(example\.test|bilibili\.com|douyin\.com)\//, route => route.fulfill({
    contentType: "text/html",
    body: '<!doctype html><meta charset="utf-8"><title>Local sites fixture</title><h1>Fixture</h1><textarea id="draft" aria-label="Draft"></textarea>'
  }));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  await worker.evaluate(() => {
    globalThis.__siteTestTrace = [];
    const trace = data => {
      globalThis.__siteTestTrace.push(data);
      if (globalThis.__siteTestTrace.length > 120) globalThis.__siteTestTrace.shift();
    };
    for (const name of ["onBeforeNavigate", "onCommitted", "onCompleted", "onHistoryStateUpdated", "onReferenceFragmentUpdated"]) {
      chrome.webNavigation[name].addListener(data => {
        if (data.frameId === 0) trace({ event: name, tabId: data.tabId, url: data.url, documentId: data.documentId });
      });
    }
    chrome.runtime.onMessage.addListener((message, sender) => {
      if (["timer", "inspect", "continue"].includes(message.type)) {
        trace({ message: message.type, tabId: sender.tab?.id, url: sender.url, documentId: sender.documentId });
      }
    });
  });
  const base = `chrome-extension://${new URL(worker.url()).host}`;
  await eventually(() => context.pages().some(page => page.url() === `${base}/journal.html#sites`), "automatic first-run page");
  const journal = context.pages().find(page => page.url() === `${base}/journal.html#sites`);
  await journal.locator("#site-save").waitFor({ state: "visible" });
  assert.equal(await journal.locator("#site-save").textContent(), "保存并开始");
  assert.equal(await journal.locator('[name="enabled-site"]:checked').count(), 0);
  assert.deepEqual((await worker.evaluate(() => chrome.permissions.getAll())).origins, []);
  const getStored = () => worker.evaluate(() => chrome.storage.local.get(["settings", "records", "setupComplete"]));
  const row = domain => journal.locator(`.rule-row[data-domain="${domain}"]`);
  const page = await context.newPage();
  await navigate(page, "https://www.douyin.com/");
  await page.locator("#draft").waitFor();
  assert.equal((await getStored()).records.length, 0);
  await journal.screenshot({ path: path.join(output, "sites-first-run.png"), fullPage: true });
  console.log("PASS automatic first-run setup has no site permissions or interception before explicit selection");

  await journal.locator("#site-domain").fill("video.example.test");
  await journal.locator("#site-add").click();
  await row("video.example.test").locator('[data-field="name"]').fill("My Videos");
  await row("video.example.test").locator('[data-field="subdomains"]').uncheck();
  await journal.locator('[name="enabled-site"][value="bilibili"]').check();
  await journal.locator("#exception-url").fill("https://video.example.test/watch?v=lesson#part1");
  await journal.locator("#exception-add").click();
  await journal.locator("#exception-url").fill("https://www.bilibili.com/list/ml3197110280?oid=123&bvid=fixture");
  await journal.locator("#exception-mode").selectOption("path");
  await journal.locator("#exception-add").click();

  // Native permission denial is simulated only for this UI branch in the isolated profile.
  await journal.evaluate(() => {
    globalThis.originalRequest = chrome.permissions.request;
    chrome.permissions.request = async () => false;
  });
  await journal.locator("#site-save").click();
  await eventually(async () => (await journal.locator("#status").textContent()).includes("未获得"), "denied permission");
  assert.equal((await getStored()).settings.customSites.length, 0);
  assert.equal(await row("video.example.test").locator('[data-field="name"]').inputValue(), "My Videos");
  assert.equal(await journal.locator(".exception-row").count(), 2);
  await journal.evaluate(() => { chrome.permissions.request = globalThis.originalRequest; });
  const origins = ["*://video.example.test/*", "*://*.bilibili.com/*"];
  await authorize(context, base, origins);
  async function save() {
    await journal.locator("#site-save").click();
    await eventually(async () => (await journal.locator("#status").textContent()) === "网站配置已保存", "saved rules");
  }
  await save();
  assert.equal((await getStored()).setupComplete, true);
  const granted = (await worker.evaluate(() => chrome.permissions.getAll())).origins;
  assert.deepEqual(new Set(granted), new Set(origins));
  const scripts = await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts());
  assert.deepEqual(new Set(scripts[0].matches), new Set(origins));
  assert.equal(scripts[0].runAt, "document_start");
  assert.ok(!await journal.locator("#site-trial").isHidden());
  assert.ok(!context.pages().some(item => item.url().startsWith("https://www.bilibili.com")));
  console.log("PASS denied setup preserves drafts; the real Save requests only the selected built-in and custom hosts");

  async function free(url) {
    await navigate(page, url);
    await page.locator("#draft").waitFor();
    await page.waitForTimeout(250);
    assert.equal(page.url(), url);
    assert.equal(await page.locator("#pause-before-scroll-timer").count(), 0);
  }
  async function gated(url) {
    await navigate(page, url);
    await page.locator("#choose").waitFor();
    assert.equal(page.url(), `${base}/pause.html#${url}`);
  }
  async function enter() {
    try {
      await page.locator("#choose").click();
      await page.locator("#reason").selectOption("查找资料");
      await page.locator('[name="duration"][value="5"]').check();
      await page.locator("#continue").click();
      await page.locator("#pause-before-scroll-timer").waitFor();
    } catch (error) {
      const diagnostic = await worker.evaluate(async url => {
        const tab = (await chrome.tabs.query({})).find(item => item.url === url);
        let content;
        if (tab && url.startsWith("https://")) {
          content = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: async () => ({
            installed: Boolean(globalThis.__pauseTimerInstalled),
            promptLoaded: Boolean(globalThis.PauseExpiryPrompt), ready: document.readyState,
            response: await chrome.runtime.sendMessage({ type: "timer", foreground: false })
          }) }).catch(error => ({ error: error.message }));
        }
        return {
          url, tab, content, trace: globalThis.__siteTestTrace,
          state: (await chrome.storage.session.get("state")).state,
          scripts: await chrome.scripting.getRegisteredContentScripts()
        };
      }, page.url());
      console.error("Synthetic sites-test failure:", JSON.stringify({
        ...diagnostic, visibleError: await page.locator("#error").count() ? await page.locator("#error").textContent() : ""
      }, null, 2));
      throw error;
    }
  }
  await gated("https://www.bilibili.com/video/retarget-fixture");
  await page.locator("#choose").click();
  await page.locator("#reason").selectOption("查找资料");
  await page.evaluate(() => {
    window.previousGateDocument = true;
    location.hash = "https://video.example.test/retarget-fixture#section";
  });
  await page.waitForFunction(() => !window.previousGateDocument &&
    document.querySelector("#destination")?.textContent.includes("My Videos") &&
    !document.querySelector("#choose").disabled);
  assert.equal(await page.locator("#visit-form").isHidden(), true);
  assert.equal(await page.locator("#reason").inputValue(), "");
  assert.equal(await page.locator("#reason option").count(), 5);
  await enter();
  assert.equal(page.url(), "https://video.example.test/retarget-fixture#section");
  console.log("PASS a same-document gate retarget reloads its identity, updates the site, and requires a fresh decision");
  await free("https://child.video.example.test/");
  await free("https://video.example.test/watch?v=lesson#part1");
  await gated("https://video.example.test/watch?v=other#part1");
  await free("https://www.bilibili.com/list/ml3197110280?oid=456&bvid=other");
  await free("https://www.bilibili.com/list/ml3197110280/next?oid=789");
  await gated("https://www.bilibili.com/list/ml31971102801?oid=123");
  await gated("https://video.example.test/watch?v=lesson#part2");
  await enter();
  assert.equal((await getStored()).records.at(-1).siteName, "My Videos");
  const token = await page.evaluate(() => {
    window.documentToken = crypto.randomUUID();
    return window.documentToken;
  });
  await page.locator("#draft").fill("Keep this unsubmitted draft.");
  await page.evaluate(() => history.pushState({}, "", "/watch?v=lesson#part1"));
  await page.locator("#pause-before-scroll-timer").waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => window.documentToken), token);
  assert.equal((await getStored()).records.at(-1).outcome, "left");
  await page.evaluate(() => history.pushState({}, "", "/restricted"));
  await page.locator("#choose").waitFor();
  await enter();
  await page.locator("#draft").fill("Do not reload when permissions change.");
  const secondToken = await page.evaluate(() => {
    window.documentToken = crypto.randomUUID();
    return window.documentToken;
  });
  console.log("PASS precise query/fragment and list-path exceptions; custom gates and live SPA transitions preserve the right boundaries");

  await journal.locator("#sites-tab").click();
  journal.once("dialog", dialog => dialog.accept());
  await row("video.example.test").locator('[data-action="revoke"]').click();
  await eventually(async () => (await row("video.example.test").locator(".rule-permission").textContent()) === "本机待授权", "revoked permission");
  await page.locator("#pause-before-scroll-timer").waitFor({ state: "detached" });
  await authorize(context, base, ["*://video.example.test/*"]);
  await row("video.example.test").locator('[data-action="grant"]').click();
  await eventually(async () => (await row("video.example.test").locator(".rule-permission").textContent()) === "已授权", "regranted permission");
  await page.bringToFront();
  await page.waitForTimeout(6000);
  assert.equal(await page.evaluate(() => window.documentToken), secondToken);
  assert.equal(await page.locator("#draft").inputValue(), "Do not reload when permissions change.");
  assert.equal(await page.locator("#pause-before-scroll-timer").count(), 0);
  await gated("https://video.example.test/restricted");
  await enter();

  await journal.bringToFront();
  await row("video.example.test").locator('[data-field="enabled"]').uncheck();
  await save();
  await page.locator("#pause-before-scroll-timer").waitFor({ state: "detached" });
  await row("video.example.test").locator('[data-field="enabled"]').check();
  await save();
  await page.bringToFront();
  await page.waitForTimeout(6000);
  assert.equal(page.url(), "https://video.example.test/restricted");
  assert.equal(await page.locator("#pause-before-scroll-timer").count(), 0);
  console.log("PASS revoke/regrant and disable/re-enable preserve the existing document; only subsequent navigation reactivates the gate");

  await journal.bringToFront();
  await authorize(context, base, ["*://*.video.example.test/*"]);
  await row("video.example.test").locator('[data-field="subdomains"]').check();
  await save();
  await gated("https://child.video.example.test/");
  await page.close();
  await journal.locator("#records-tab").click();
  await journal.locator("#site-filter").selectOption("custom:video.example.test");
  assert.ok(await journal.locator("#record-rows tr").count() >= 3);
  assert.ok((await journal.locator("#record-rows").textContent()).includes("My Videos"));
  await journal.locator("#sites-tab").click();
  for (const width of [1280, 390, 320]) {
    await journal.setViewportSize({ width, height: 900 });
    await journal.screenshot({ path: path.join(output, `sites-${width}.png`), fullPage: true });
    assert.ok(await journal.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`);
    assert.ok(await journal.locator("#site-save").isEnabled());
    const overlaps = await journal.locator(".rule-row").evaluateAll(rows => rows.some(row => {
      const heading = row.querySelector(".rule-heading").getBoundingClientRect();
      const status = row.querySelector(".rule-permission").getBoundingClientRect();
      return heading.right > status.left && heading.bottom > status.top && status.bottom > heading.top;
    }));
    assert.equal(overlaps, false, `rule text overlaps at ${width}`);
  }
  journal.once("dialog", dialog => dialog.accept());
  await row("video.example.test").getByRole("button", { name: "删除", exact: true }).click();
  await save();
  assert.equal((await getStored()).settings.customSites.length, 0);
  assert.equal((await getStored()).settings.exceptions.length, 1);
  await journal.locator("#records-tab").click();
  await journal.locator("#site-filter").selectOption("custom:video.example.test");
  assert.ok(await journal.locator("#record-rows tr").count() >= 3);
  assert.deepEqual(errors, []);
  console.log("PASS subdomain scope, custom history after rule deletion, and 1280/390/320 layouts");
} finally {
  await context.close();
  if (path.dirname(profile) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith("pause-sites-")) {
    throw new Error("Refusing to remove unexpected sites-test profile.");
  }
  await rm(profile, { recursive: true, force: true });
}
