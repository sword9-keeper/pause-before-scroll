import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { setupSites } from "./browser-setup.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const profile = await mkdtemp(path.join(tmpdir(), "pause-timer-layout-"));
const output = path.join(root, "test-results");
await mkdir(output, { recursive: true });
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium", headless: true, viewport: { width: 1280, height: 800 },
  ignoreDefaultArgs: ["--hide-scrollbars"],
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
});

try {
  await context.route("https://www.bilibili.com/**", route => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><meta charset="utf-8"><title>Scrollbar layout regression fixture</title>
      <style>html{overflow-y:scroll}body{min-height:2200px;margin:24px;font:16px system-ui}
      ::-webkit-scrollbar{width:18px}::-webkit-scrollbar-thumb{background:#999}</style>
      <h1>Scrollbar layout regression</h1><p>Synthetic page, not real-site acceptance.</p></html>`
  }));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const base = `chrome-extension://${new URL(worker.url()).host}`;
  await setupSites(context, base);
  const page = await context.newPage();
  await page.goto("https://www.bilibili.com/").catch(error => {
    if (!error.message.includes("ERR_ABORTED")) throw error;
  });
  await page.locator("#choose").click();
  await page.locator("#reason").selectOption("查找资料");
  await page.locator('[name="duration"][value="5"]').check();
  await page.locator("#continue").click();
  const timer = page.locator("#pause-before-scroll-timer");
  await timer.waitFor();

  async function geometry(label) {
    const value = await timer.evaluate(host => {
      const root = host.shadowRoot;
      const bounds = node => {
        const box = node.getBoundingClientRect();
        return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
      };
      const text = root.querySelector(".label");
      return {
        viewport: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
        innerWidth, host: bounds(host), label: bounds(text),
        lineHeight: parseFloat(getComputedStyle(text).lineHeight),
        controls: [...root.querySelectorAll("button,strong")].map(node => ({
          text: node.getAttribute("aria-label") || node.textContent, ...bounds(node),
          hittable: root.elementFromPoint(
            node.getBoundingClientRect().x + node.getBoundingClientRect().width / 2,
            node.getBoundingClientRect().y + node.getBoundingClientRect().height / 2
          ) === node
        }))
      };
    });
    assert.ok(value.viewport.width < value.innerWidth, "Fixture must reproduce a non-overlay vertical scrollbar.");
    assert.ok(value.host.left >= 0 && value.host.right <= value.viewport.width &&
      value.host.top >= 0 && value.host.bottom <= value.viewport.height, `${label}: host outside client viewport: ${JSON.stringify(value)}`);
    for (const control of value.controls) {
      assert.ok(control.left >= value.host.left && control.right <= value.host.right + 0.5,
        `${label}: overflowing control: ${JSON.stringify(value)}`);
      assert.ok(control.hittable, `${label}: control cannot receive a real pointer click: ${control.text}`);
    }
    if (value.label.width) assert.ok(value.label.height <= value.lineHeight + 1,
      `${label}: the four-character label wrapped: ${JSON.stringify(value)}`);
    return value;
  }

  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 700 });
    await page.waitForTimeout(1100);
    await page.screenshot({ path: path.join(output, `timer-scrollbar-${width}.png`) });
    const first = await geometry(`${width}px expanded`);
    await timer.getByRole("button", { name: "收起倒计时", exact: true }).click();
    const collapsed = await geometry(`${width}px collapsed`);
    assert.ok(collapsed.host.width < first.host.width, "Collapsing should reduce the timer footprint.");
    await timer.getByRole("button", { name: "展开倒计时", exact: true }).click();
    await geometry(`${width}px re-expanded`);
  }
  console.log("PASS all timer controls stay inside the scrollable viewport and are clickable at 1280/390/320 px");

  const grip = timer.getByRole("button", { name: "移动倒计时", exact: true });
  await grip.focus();
  for (let i = 0; i < 24; i++) await page.keyboard.press("ArrowDown");
  await geometry("moved to bottom");
  await page.setViewportSize({ width: 390, height: 568 });
  await geometry("resized at bottom");
  console.log("PASS a timer moved to the lower edge remains within the client viewport after resize");
} finally {
  await context.close();
  if (path.dirname(profile) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith("pause-timer-layout-")) {
    throw new Error("Refusing to remove an unexpected timer-layout test directory.");
  }
  await rm(profile, { recursive: true, force: true });
}
