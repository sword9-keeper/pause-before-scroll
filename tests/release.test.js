import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkPublicSource } from "../scripts/check-public.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

test("public source includes versioned disclosure, complete icons and licenses without an installation preset", async () => {
  const report = await checkPublicSource();
  assert.deepEqual(report.iconSizes, [16, 32, 48, 128]);
});

test("public packaging preflight rejects private presets, required hosts, broken icons and stale privacy text", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "pause-release-"));
  try {
    for (const name of ["manifest.json", "install-defaults.js", "privacy.html", "journal.html", "pause.html", "assets", "vendor"]) {
      await cp(path.join(root, name), path.join(fixture, name), { recursive: true });
    }
    const manifest = await readFile(path.join(fixture, "manifest.json"), "utf8");
    const preset = await readFile(path.join(fixture, "install-defaults.js"), "utf8");
    await writeFile(path.join(fixture, "install-defaults.js"), 'export default {"password":"synthetic-only"};');
    await assert.rejects(checkPublicSource(fixture), /empty install preset/);
    await writeFile(path.join(fixture, "install-defaults.js"), preset);
    await writeFile(path.join(fixture, "manifest.json"), JSON.stringify({ ...JSON.parse(manifest), host_permissions: ["https://example.test/*"] }));
    await assert.rejects(checkPublicSource(fixture), /required host permissions/);
    await writeFile(path.join(fixture, "manifest.json"), manifest);
    const iconPath = path.join(fixture, "assets/icon-32.png");
    const icon = await readFile(iconPath);
    const invalid = Buffer.from(icon);
    invalid.writeUInt32BE(31, 16);
    await writeFile(iconPath, invalid);
    await assert.rejects(checkPublicSource(fixture), /PNG size/);
    await writeFile(iconPath, icon);
    await writeFile(path.join(fixture, "assets/unexpected.txt"), "synthetic-only");
    await assert.rejects(checkPublicSource(fixture), /unexpected files/);
    await rm(path.join(fixture, "assets/unexpected.txt"));
    await writeFile(path.join(fixture, "privacy.html"), "<h1>Outdated disclosure</h1>");
    await assert.rejects(checkPublicSource(fixture), /version does not match/);
  } finally {
    if (path.dirname(fixture) !== path.resolve(tmpdir()) || !path.basename(fixture).startsWith("pause-release-")) {
      throw new Error("Refusing to remove an unexpected release test directory.");
    }
    await rm(fixture, { recursive: true, force: true });
  }
});
