import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const sizes = [16, 32, 48, 128];
const expectedPreset = "// Personal release packaging replaces this module inside the ZIP only.\nexport default null;";

export async function checkPublicSource(directory = root) {
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  const preset = (await readFile(path.join(directory, "install-defaults.js"), "utf8")).replaceAll("\r\n", "\n").trim();
  if (preset !== expectedPreset) throw new Error("Public source must contain only the empty install preset.");
  if (!Array.isArray(manifest.host_permissions) || manifest.host_permissions.length) {
    throw new Error("Public source must not have required host permissions.");
  }
  for (const [map, expected] of [[manifest.icons, sizes], [manifest.action?.default_icon, [16, 32, 48]]]) {
    if (!map || Object.keys(map).sort().join(",") !== expected.map(String).sort().join(",")) {
      throw new Error("Extension icon declarations are incomplete or unexpected.");
    }
    for (const size of expected) {
      if (map[size] !== `assets/icon-${size}.png`) throw new Error("Unexpected extension icon path.");
    }
  }
  const allowedAssets = ["icon.svg", ...sizes.map(size => `icon-${size}.png`)];
  if ((await readdir(path.join(directory, "assets"))).sort().join(",") !== allowedAssets.sort().join(",")) {
    throw new Error("Assets directory contains missing or unexpected files.");
  }
  for (const size of sizes) {
    const png = await readFile(path.join(directory, `assets/icon-${size}.png`));
    if (png.length < 33 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
        png.toString("ascii", 12, 16) !== "IHDR" || png.readUInt32BE(16) !== size ||
        png.readUInt32BE(20) !== size || png[24] !== 8 || ![2, 6].includes(png[25])) {
      throw new Error("Extension icon is not an expected 8-bit RGB/RGBA PNG size.");
    }
  }
  const privacy = await readFile(path.join(directory, "privacy.html"), "utf8");
  if (!privacy.includes(`适用版本：${manifest.version}`)) throw new Error("Privacy disclosure version does not match the extension.");
  if (/<script\b|<iframe\b/i.test(privacy)) throw new Error("The privacy disclosure must be a static document.");
  for (const name of ["journal.html", "pause.html"]) {
    const page = await readFile(path.join(directory, name), "utf8");
    if (!page.includes('href="privacy.html"') || !page.includes('src="assets/icon-48.png"')) {
      throw new Error("An extension page is missing its privacy entry or brand icon.");
    }
  }
  for (const name of ["parse-xml-LICENSE", "tldts-LICENSE"]) {
    if (!(await readFile(path.join(directory, "vendor", name), "utf8")).trim()) throw new Error("Missing dependency license.");
  }
  return { version: manifest.version, iconSizes: sizes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await checkPublicSource();
    console.log(`Public packaging checks passed for ${result.version}. This is not store approval or a complete security audit.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
