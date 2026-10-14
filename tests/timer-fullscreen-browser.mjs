import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { setupSites } from "./browser-setup.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const profile = await mkdtemp(path.join(tmpdir(), "pause-timer-fullscreen-"));
const headed = process.env.BTF_HEADED === "1";
const output = path.join(root, "test-results", headed ? "timer-fullscreen-headed" : "timer-fullscreen");
await mkdir(output, { recursive: true });
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium", headless: !headed,
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
});
const pageErrors = [];
context.on("weberror", event => pageErrors.push(event.error().message));
const report = {
  scope: "Synthetic pages in an isolated Chromium profile; not authenticated Chrome acceptance.",
  headed,
  startedAt: new Date().toISOString(), browser: context.browser().version(),
  timerHash: createHash("sha256").update(await readFile(path.join(root, "timer.js"))).digest("hex"),
  expiryHash: createHash("sha256").update(await readFile(path.join(root, "expiry.js"))).digest("hex"),
  status: "running", checks: [], visualReview: "pending"
};
let page;

try {
  await context.route("https://www.bilibili.com/**", route => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><meta charset="utf-8"><title>Fullscreen timer regression fixture</title>
      <style>
        body { margin:24px; font:16px system-ui; background:#edf4ef; }
        #player { background:#17382a; color:white; padding:24px; box-sizing:border-box; }
        #player:fullscreen { display:flex; flex-direction:column; gap:16px; }
        video { display:block; width:640px; max-width:100%; height:360px; }
        button { padding:12px; font:inherit; }
        #site-menu { position:fixed; inset:auto auto 20px 20px; margin:0; }
        iframe { display:block; width:640px; max-width:100%; height:180px; }
      </style>
      <h1>Fullscreen timer regression</h1><p>Synthetic media; not real-site acceptance.</p>
      <section id="player">
        <video id="video" muted playsinline></video>
        <div>
          <button id="wrapper-fullscreen">Fullscreen player</button>
          <button id="video-fullscreen">Fullscreen video</button>
          <button id="outside">Page control</button>
          <button id="menu-toggle" popovertarget="site-menu">Page menu</button>
        </div>
      </section>
      <div id="site-menu" popover>Independent page menu</div>
      <button id="document-fullscreen">Fullscreen document</button>
      <div id="shadow-player"></div>
      <iframe src="https://player.example.test/" allowfullscreen></iframe>
      <script>
        const canvas = document.createElement("canvas");
        canvas.width = 640; canvas.height = 360;
        const paint = canvas.getContext("2d");
        setInterval(() => {
          paint.fillStyle = "#397651"; paint.fillRect(0, 0, 640, 360);
          paint.fillStyle = "#ffffff"; paint.font = "28px sans-serif";
          paint.fillText("Synthetic playback fixture", 32, 70);
          paint.fillRect(32 + (Date.now() / 30) % 500, 160, 30, 30);
        }, 40);
        video.srcObject = canvas.captureStream(25);
        void video.play();
        document.querySelector("#wrapper-fullscreen").onclick = () => player.requestFullscreen();
        document.querySelector("#video-fullscreen").onclick = () => video.requestFullscreen();
        document.querySelector("#document-fullscreen").onclick = () => document.documentElement.requestFullscreen();
        document.querySelector("#outside").onclick = event => {
          event.currentTarget.dataset.clicks = String(Number(event.currentTarget.dataset.clicks || 0) + 1);
        };
        const shadow = document.querySelector("#shadow-player").attachShadow({ mode: "open" });
        shadow.innerHTML = '<section id="shadow-surface" style="padding:24px;background:#d7e6dd">' +
          '<h2>Open shadow player fixture</h2><button id="shadow-fullscreen">Fullscreen shadow player</button></section>';
        shadow.querySelector("#shadow-fullscreen").onclick = () => shadow.querySelector("#shadow-surface").requestFullscreen();
        document.addEventListener("fullscreenchange", () => {
          document.documentElement.dataset.fullscreenFocus = document.activeElement?.id || "";
        });
      </script></html>`
  }));
  await context.route("https://player.example.test/**", route => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><meta charset="utf-8"><title>Frame fullscreen fixture</title>
      <style>body{background:#49759a;color:white;font:20px system-ui;padding:24px}</style>
      <h2>Cross-origin frame fixture</h2><button id="frame-fullscreen">Fullscreen frame</button>
      <script>
        document.querySelector("#frame-fullscreen").onclick = () => document.documentElement.requestFullscreen();
      </script></html>`
  }));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const base = `chrome-extension://${new URL(worker.url()).host}`;
  report.extensionVersion = await worker.evaluate(() => chrome.runtime.getManifest().version);
  await setupSites(context, base);
  page = await context.newPage();

  async function start(minutes = "5") {
    await page.goto("https://www.bilibili.com/").catch(error => {
      if (!error.message.includes("ERR_ABORTED")) throw error;
    });
    await page.locator("#choose").click();
    await page.locator("#reason").selectOption("查找资料");
    await page.locator('[name="duration"][value="custom"]').check();
    await page.locator("#custom-minutes").fill(minutes);
    await page.locator("#continue").click();
    await page.locator("#pause-before-scroll-timer").waitFor();
    await page.waitForFunction(() => document.querySelector("video")?.readyState >= 2);
  }

  async function geometry(label, interactive = true) {
    await page.screenshot({ path: path.join(output, `${label}.png`) });
    const state = await page.locator("#pause-before-scroll-timer").evaluate(host => {
      const box = host.getBoundingClientRect();
      const root = host.shadowRoot;
      return {
        fullscreen: document.fullscreenElement?.id || document.fullscreenElement?.tagName || null,
        popoverOpen: host.matches(":popover-open"),
        readonly: root.querySelector(".clock").classList.contains("readonly"),
        focusAtFullscreen: document.documentElement.dataset.fullscreenFocus,
        focused: document.activeElement?.id || "",
        viewport: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
        box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
        controls: [...root.querySelectorAll("button,strong")].map(node => {
          const rect = node.getBoundingClientRect();
          const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
          let hit = document.elementFromPoint(x, y);
          while (hit && hit !== host && hit.shadowRoot) {
            const next = hit.shadowRoot.elementFromPoint(x, y);
            if (next === hit) break;
            hit = next;
          }
          return {
            label: node.getAttribute("aria-label") || node.textContent,
            button: node.tagName === "BUTTON",
            displayed: rect.width > 0 && rect.height > 0,
            documentHit: document.elementFromPoint(x, y)?.id || document.elementFromPoint(x, y)?.tagName,
            hittable: hit === host && root.elementFromPoint(x, y) === node
          };
        })
      };
    });
    report.checks.push({ label, ...state });
    assert.ok(state.box.right > state.box.left && state.box.bottom > state.box.top, `${label}: timer has no rendered size`);
    assert.ok(state.box.left >= 0 && state.box.right <= state.viewport.width &&
      state.box.top >= 0 && state.box.bottom <= state.viewport.height, `${label}: timer outside viewport`);
    assert.equal(state.readonly, !interactive, `${label}: unexpected interaction mode`);
    if (interactive) {
      for (const control of state.controls) {
        assert.ok(control.hittable, `${label}: covered or unclickable control: ${control.label}`);
      }
    } else {
      assert.equal(state.popoverOpen, true, `${label}: countdown is not in the top layer`);
      assert.equal(state.box.top, 8, `${label}: display-only countdown must stay clear of native bottom controls`);
      assert.ok(state.controls.filter(control => control.button).every(control => !control.displayed),
        `${label}: display-only countdown must not show unusable controls`);
      assert.ok(state.controls.find(control => !control.button)?.displayed, `${label}: countdown text is missing`);
    }
    return state;
  }

  const timer = () => page.locator("#pause-before-scroll-timer");
  async function expandCollapse(label) {
    await timer().getByRole("button", { name: "收起倒计时", exact: true }).click();
    await geometry(`${label}-collapsed`);
    await timer().getByRole("button", { name: "展开倒计时", exact: true }).click();
    await geometry(`${label}-expanded`);
  }
  async function exitFullscreen() {
    await page.evaluate(async () => {
      for (let i = 0; i < 4 && document.fullscreenElement; i++) await document.exitFullscreen();
    });
    await page.waitForFunction(() => !document.fullscreenElement);
  }
  async function enter(selector, expected, label, interactive = true) {
    await page.locator(selector).click();
    await page.waitForFunction(id => (document.fullscreenElement?.id || document.fullscreenElement?.tagName) === id, expected);
    const state = await geometry(label, interactive);
    if (interactive) assert.equal(state.focused, state.focusAtFullscreen, `${label}: countdown stole fullscreen focus`);
    assert.notEqual(state.focused, "pause-before-scroll-timer", `${label}: countdown stole fullscreen focus`);
    return state;
  }

  await start();
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  await geometry("normal");
  await enter("#wrapper-fullscreen", "player", "player");
  await expandCollapse("player");
  await page.locator("#outside").click();
  assert.equal(await page.locator("#outside").getAttribute("data-clicks"), "1",
    "The countdown must not make the underlying player inert or intercept unrelated clicks.");
  await page.locator("#menu-toggle").click();
  assert.equal(await page.locator("#site-menu").evaluate(node => node.matches(":popover-open")), true);
  await geometry("player-with-page-menu");
  assert.equal(await page.locator("#site-menu").evaluate(node => node.matches(":popover-open")), true,
    "The countdown must not dismiss the page's own menu.");

  await enter("#video-fullscreen", "video", "nested-video", false);
  await page.evaluate(() => document.exitFullscreen());
  await page.waitForFunction(() => document.fullscreenElement?.id === "player");
  await geometry("after-nested-back");
  await expandCollapse("after-nested-back");
  await exitFullscreen();
  await geometry("after-nested-exit");
  await enter("#video-fullscreen", "video", "direct-video", false);
  await exitFullscreen();
  await enter("#document-fullscreen", "HTML", "document");
  await expandCollapse("document");
  await exitFullscreen();
  await enter("#shadow-player #shadow-fullscreen", "shadow-player", "open-shadow");
  await expandCollapse("open-shadow");
  await exitFullscreen();

  await page.frameLocator("iframe").locator("#frame-fullscreen").click();
  await page.waitForFunction(() => document.fullscreenElement?.tagName === "IFRAME");
  await geometry("cross-origin-frame", false);
  await exitFullscreen();

  const grip = timer().getByRole("button", { name: "移动倒计时", exact: true });
  await grip.focus();
  for (let i = 0; i < 24; i++) await page.keyboard.press("ArrowDown");
  await enter("#wrapper-fullscreen", "player", "player-bottom");
  const bottom = await timer().boundingBox();
  await enter("#video-fullscreen", "video", "video-after-bottom-layout", false);
  await page.evaluate(() => document.exitFullscreen());
  await page.waitForFunction(() => document.fullscreenElement?.id === "player");
  const restored = await geometry("restored-bottom-layout");
  assert.ok(Math.abs(restored.box.top - bottom.y) < 1, "Returning from display-only mode must retain the saved position.");
  await exitFullscreen();
  for (const width of [390, 320, 1280]) {
    await page.setViewportSize({ width, height: 700 });
    await enter("#wrapper-fullscreen", "player", `player-${width}`);
    await expandCollapse(`player-${width}`);
    await exitFullscreen();
    await geometry(`normal-${width}`);
  }
  assert.equal(await page.evaluate(() => performance.timeOrigin), timeOrigin, "Fullscreen controls must not replace the document.");
  assert.equal(await page.locator("video").evaluate(video => video.paused), false, "Fullscreen timer controls must not pause playback.");
  console.log("PASS container/document fullscreen controls and display-only native video/frame countdown, without focus theft");
  console.log("PASS page controls/menu, collapse, reposition and 1280/390/320 px fullscreen transitions preserve playback and document");

  await page.close();
  page = await context.newPage();
  await start("0.1");
  await enter("#wrapper-fullscreen", "player", "before-expiry");
  await enter("#video-fullscreen", "video", "nested-before-expiry", false);
  const expiryOrigin = await page.evaluate(() => performance.timeOrigin);
  report.beforeExpiry = await page.evaluate(() => ({
    fullscreen: document.fullscreenElement?.id, paused: document.querySelector("video").paused
  }));
  assert.equal(report.beforeExpiry.fullscreen, "video");
  assert.equal(report.beforeExpiry.paused, false);
  const prompt = page.locator("#pause-before-scroll-expiry");
  await prompt.locator("dialog").waitFor({ timeout: 15000 });
  await page.waitForFunction(() => !document.fullscreenElement && document.querySelector("video").paused);
  report.afterExpiry = await page.evaluate(() => ({
    fullscreen: document.fullscreenElement?.id || null, paused: document.querySelector("video").paused
  }));
  assert.equal(await timer().count(), 0);
  await page.screenshot({ path: path.join(output, "expired.png") });
  await prompt.getByRole("button", { name: "先保存内容 · 2 分钟", exact: true }).click();
  await prompt.waitFor({ state: "detached" });
  await geometry("resumed");
  assert.equal(await page.evaluate(() => performance.timeOrigin), expiryOrigin);
  assert.equal(await page.locator("video").evaluate(video => video.paused), true);
  await enter("#wrapper-fullscreen", "player", "resumed-fullscreen");
  await Promise.all([
    page.waitForEvent("close"),
    timer().getByRole("button", { name: "结束并关闭", exact: true }).click()
  ]);
  assert.deepEqual(pageErrors, [], "Unexpected page errors in fullscreen regression");
  report.pageErrors = pageErrors;
  console.log("PASS fullscreen expiry, deliberate recovery without autoplay and real early-exit click");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.message;
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  await context.close();
  if (path.dirname(profile) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith("pause-timer-fullscreen-")) {
    throw new Error("Refusing to remove an unexpected fullscreen test directory.");
  }
  await rm(profile, { recursive: true, force: true });
}
