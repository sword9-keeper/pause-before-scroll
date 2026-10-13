export const builtinOrigins = ["*://*.douyin.com/*", "*://*.xiaohongshu.com/*", "*://*.bilibili.com/*"];

export async function authorize(context, base, origins = builtinOrigins) {
  const manager = await context.newPage();
  try {
    await manager.goto("chrome://extensions/");
    // Simulate host-access approval only in this isolated test profile.
    // The extension's own optional-permission request still runs from its save button.
    await manager.evaluate(async ({ id, origins }) => {
      for (const origin of origins) await chrome.developerPrivate.addHostPermission(id, origin);
    }, { id: new URL(base).host, origins });
  } finally { await manager.close(); }
}

export async function setupSites(context, base) {
  await authorize(context, base);
  const page = await context.newPage();
  try {
    await page.goto(`${base}/journal.html#sites`);
    await page.locator('#site-rules [name="enabled-site"]').first().waitFor();
    for (const input of await page.locator('#site-rules [name="enabled-site"]').all()) await input.check();
    await page.locator("#site-save").click();
    await page.waitForFunction(() => document.querySelector("#status").textContent === "网站配置已保存").catch(async error => {
      console.error("SETUP status", await page.locator("#status").textContent(), await page.locator("#site-save").isDisabled());
      throw error;
    });
  } finally { await page.close(); }
}
