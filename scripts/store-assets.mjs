import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { checkPublicSource } from "./check-public.mjs";
import { authorize } from "../tests/browser-setup.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const checked = await checkPublicSource(root);
const output = path.join(root, "artifacts", `store-${checked.version}`);
const evidence = path.join(root, "test-results", "distribution");
const profile = await mkdtemp(path.join(tmpdir(), "pause-store-"));
await mkdir(output, { recursive: true });
await mkdir(evidence, { recursive: true });
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium", headless: true, locale: "zh-CN",
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
});
const errors = [];
const requests = [];
context.on("weberror", event => errors.push(event.error().message));
context.on("request", request => {
  if (/^https?:/.test(request.url())) requests.push(request.url());
});
const report = {
  version: checked.version, browser: context.browser().version(), startedAt: new Date().toISOString(),
  status: "running", visualReview: "pending", sourceHashes: {}, screenshots: [],
  scope: "Actual extension UI in a synthetic, isolated profile. No real users, efficacy data, personal cookies or WebDAV credentials.",
  storeSubmission: "blocked: publisher/contact/privacy hosting/security review/native Chrome/macOS acceptance outstanding"
};
for (const file of ["manifest.json", "journal.html", "pause.html", "privacy.html", "style.css", "assets/icon-128.png"]) {
  report.sourceHashes[file] = createHash("sha256").update(await readFile(path.join(root, file))).digest("hex");
}

try {
  await context.route(/^https?:\/\//, route => {
    if (route.request().url() !== "https://example.com/") return route.abort();
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>演示页面</title>
        <style>body{margin:0;background:#f3f6f8;color:#294659;font:17px/1.9 system-ui}
        main{max-width:820px;margin:60px auto;padding:0 32px}h1{font-size:28px}
        textarea{box-sizing:border-box;width:100%;height:120px;padding:16px;font:inherit;border:1px solid #b6c9d4}</style>
        <main><p>演示内容 · example.com</p><h1>给一段阅读留一点时间</h1>
        <p>这是用于展示扩展界面的虚构页面，不是实际网站或真实用户的浏览记录。</p>
        <label for="demo-note">阅读笔记</label><textarea id="demo-note"></textarea></main></html>`
    });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const base = `chrome-extension://${new URL(worker.url()).host}`;
  const journal = await context.newPage();
  await journal.goto(`${base}/journal.html#sites`);
  await journal.locator('#site-rules [name="enabled-site"]').first().waitFor();
  assert.equal(await journal.locator("#version").textContent(), `v${checked.version}`);
  assert.equal((await worker.evaluate(() => chrome.storage.local.get("syncConfig"))).syncConfig?.enabled || false, false);
  await journal.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
  await journal.screenshot({ path: path.join(output, "01-choose-sites.jpg"), type: "jpeg", quality: 95 });
  report.screenshots.push({ file: "01-choose-sites.jpg", width: 1280, height: 800, content: "Actual fresh-install site selection; no sites preselected." });

  report.icons = await journal.evaluate(async () => {
    const results = [];
    for (const size of [16, 32, 48, 128]) {
      const image = new Image();
      image.src = chrome.runtime.getURL(`assets/icon-${size}.png`);
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const drawing = canvas.getContext("2d");
      drawing.drawImage(image, 0, 0);
      const pixels = drawing.getImageData(0, 0, size, size).data;
      let visible = 0, white = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] > 0) visible++;
        if (pixels[i] > 240 && pixels[i + 1] > 240 && pixels[i + 2] > 240 && pixels[i + 3] > 200) white++;
      }
      results.push({ size, width: image.naturalWidth, height: image.naturalHeight, visible, white, cornerAlpha: pixels[3] });
    }
    return results;
  });
  for (const icon of report.icons) {
    assert.equal(icon.width, icon.size);
    assert.equal(icon.height, icon.size);
    assert.equal(icon.cornerAlpha, 0);
    assert.ok(icon.visible > icon.size ** 2 / 4 && icon.visible < icon.size ** 2 * .8);
    assert.ok(icon.white > 0, "Pause mark must survive small icon rendering.");
  }

  const privacyPromise = context.waitForEvent("page");
  await journal.getByRole("link", { name: "数据与隐私", exact: true }).click();
  const privacy = await privacyPromise;
  await privacy.waitForURL(`${base}/privacy.html`);
  assert.equal(await privacy.locator("script,iframe").count(), 0);
  assert.ok((await privacy.locator("main").textContent()).includes("没有应用层静态加密"));
  for (const width of [1280, 390, 320]) {
    await privacy.setViewportSize({ width, height: 800 });
    await privacy.screenshot({ path: path.join(evidence, `privacy-${width}.png`), fullPage: true });
    assert.ok(await privacy.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Privacy text must not overflow horizontally.");
    assert.ok(await privacy.locator(".privacy-index a").evaluateAll(links => links.every(link => {
      const box = link.getBoundingClientRect();
      return box.width > 0 && box.left >= 0 && box.right <= innerWidth;
    })));
  }
  await privacy.getByRole("link", { name: "安全边界", exact: true }).focus();
  await privacy.keyboard.press("Enter");
  assert.ok(privacy.url().endsWith("#security"));
  assert.equal(requests.length, 0, "Opening the journal and privacy page must not add external requests.");
  await privacy.close();
  console.log("PASS installed icons decode at all sizes; privacy link, keyboard anchors and 1280/390/320 px layout; no external requests");

  await authorize(context, base, ["*://example.com/*"]);
  await journal.locator("#site-domain").fill("example.com");
  await journal.locator("#site-add").click();
  await journal.locator('[data-domain="example.com"] [data-field="name"]').fill("演示网站");
  await journal.locator('[data-domain="example.com"] [data-field="subdomains"]').uncheck();
  await journal.locator("#site-save").click();
  await journal.waitForFunction(() => document.querySelector("#status").textContent === "网站配置已保存");
  const visit = await context.newPage();
  await visit.goto("https://example.com/").catch(error => {
    if (!error.message.includes("ERR_ABORTED")) throw error;
  });
  await visit.locator("#choose").waitFor();
  await visit.waitForFunction(() => !document.querySelector("#choose").disabled);
  await visit.screenshot({ path: path.join(output, "02-pause-before-entering.jpg"), type: "jpeg", quality: 95 });
  report.screenshots.push({ file: "02-pause-before-entering.jpg", width: 1280, height: 800, content: "Actual entry decision for an explicitly named demo site." });
  const gatePrivacyPromise = context.waitForEvent("page");
  await visit.getByRole("link", { name: "数据与隐私", exact: true }).click();
  const gatePrivacy = await gatePrivacyPromise;
  await gatePrivacy.waitForURL(`${base}/privacy.html`);
  await gatePrivacy.close();
  await visit.locator("#choose").click();
  await visit.locator("#reason").selectOption("__custom__");
  await visit.locator("#custom-reason").fill("演示：阅读一篇文章");
  await visit.locator('[name="duration"][value="custom"]').check();
  await visit.locator("#custom-minutes").fill("0.1");
  await visit.locator("#continue").click();
  await visit.locator("#demo-note").fill("演示笔记：到期暂停后，这段未提交的文字仍在当前页面。");
  await visit.locator("#pause-before-scroll-expiry dialog").waitFor();
  await visit.screenshot({ path: path.join(output, "03-keep-the-page-at-expiry.jpg"), type: "jpeg", quality: 95 });
  report.screenshots.push({ file: "03-keep-the-page-at-expiry.jpg", width: 1280, height: 800, content: "Actual expiry prompt; underlying article and note are labelled demonstration content." });
  assert.ok((await visit.locator("#demo-note").inputValue()).includes("演示笔记"));
  assert.ok(requests.every(url => url === "https://example.com/"), "Unexpected network destination during asset preparation.");
  assert.deepEqual(errors, []);
  await visit.close();

  const poster = await context.newPage();
  const svg = await readFile(path.join(root, "assets/icon.svg"), "utf8");
  await poster.setViewportSize({ width: 440, height: 280 });
  await poster.setContent(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
    html,body{margin:0;width:440px;height:280px;background:#e7f0eb;color:#254c37;font:26px/1.4 "Microsoft YaHei","PingFang SC",sans-serif;letter-spacing:0}
    main{height:280px;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:4px}
    svg{width:144px;height:144px;display:block}p{margin:0;font-weight:600}
    </style><main>${svg}<p>刷之前想一下</p></main></html>`);
  await poster.screenshot({ path: path.join(output, "promo-small.jpg"), type: "jpeg", quality: 95 });
  await poster.close();
  report.status = "passed";
  console.log("PASS three actual-UI demonstration screenshots and a 440x280 brand tile generated; not approved for store submission");
} catch (error) {
  report.status = "failed";
  report.error = error.message;
  for (const [index, page] of context.pages().entries()) {
    if (!page.isClosed() && page.url().startsWith("chrome-extension://")) {
      await page.screenshot({ path: path.join(evidence, `failure-${index}.png`), fullPage: true }).catch(() => {});
    }
  }
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, "evidence.json"), JSON.stringify(report, null, 2));
  await context.close();
  if (path.dirname(profile) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith("pause-store-")) {
    throw new Error("Refusing to remove an unexpected store preparation profile.");
  }
  await rm(profile, { recursive: true, force: true });
}
