import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const assets = path.join(root, "assets");
await mkdir(assets, { recursive: true });
const svg = await readFile(path.join(assets, "icon.svg"), "utf8");
const browser = await chromium.launch({ channel: "chromium", headless: true });
try {
  const page = await browser.newPage();
  for (const size of [16, 32, 48, 128]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    await page.screenshot({ path: path.join(assets, `icon-${size}.png`), omitBackground: true });
  }
  console.log("Rendered 16/32/48/128 px PNG icons from assets/icon.svg.");
} finally {
  await browser.close();
}
