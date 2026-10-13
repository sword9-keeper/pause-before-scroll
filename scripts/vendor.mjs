import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = path.join(root, "node_modules", "@rgrove", "parse-xml");
await mkdir(path.join(root, "vendor"), { recursive: true });
await copyFile(path.join(source, "dist", "browser.js"), path.join(root, "vendor", "parse-xml.js"));
await copyFile(path.join(source, "LICENSE"), path.join(root, "vendor", "parse-xml-LICENSE"));
