import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const maxBytes = 64 * 1024 * 1024;
const archiveSignatures = [
  Buffer.from("504b0304", "hex"), Buffer.from("504b0506", "hex"),
  Buffer.from("377abcaf271c", "hex"), Buffer.from("526172211a07", "hex"),
  Buffer.from("1f8b", "hex")
];

export function auditGitObjects(directory, secrets) {
  if (!Array.isArray(secrets) || !secrets.length || secrets.some(secret =>
    !secret || !/^[a-z][a-z0-9_]*$/.test(secret.label) ||
    typeof secret.value !== "string" || secret.value.length < 4)) {
    throw new Error("Provide labelled known-secret values of at least four characters; values are never printed.");
  }
  const gitEnvironment = { ...process.env };
  for (const name of ["BTF_WEBDAV_URL", "BTF_WEBDAV_USERNAME", "BTF_WEBDAV_PASSWORD"]) delete gitEnvironment[name];
  const git = (args, options = {}) => execFileSync("git", args, {
    cwd: directory, env: gitEnvironment, maxBuffer: maxBytes, ...options
  });
  const inventory = git(["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], { encoding: "utf8" })
    .trim().split("\n").filter(Boolean).map(line => {
      const match = line.match(/^([a-f0-9]{40,64}) (blob|tree|commit|tag) ([0-9]+)$/);
      if (!match) throw new Error("Unexpected Git object inventory.");
      return { id: match[1], type: match[2], bytes: Number(match[3]) };
    });
  const bytes = inventory.reduce((sum, object) => sum + object.bytes, 0);
  if (bytes + inventory.length * 128 >= maxBytes) {
    throw new Error("Repository exceeds the bounded audit size; no objects were silently skipped.");
  }
  const output = git(["cat-file", "--batch"], { input: inventory.map(object => object.id).join("\n") + "\n" });
  const needles = secrets.flatMap(({ label, value }) => [...new Set([
    value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)
  ])].map(encoded => ({ label, bytes: Buffer.from(encoded) })));
  const findings = [];
  const archives = [];
  let offset = 0;
  for (const object of inventory) {
    const headerEnd = output.indexOf(10, offset);
    if (headerEnd < 0 || output.toString("ascii", offset, headerEnd) !== `${object.id} ${object.type} ${object.bytes}`) {
      throw new Error("Unexpected Git batch header; audit is incomplete.");
    }
    const start = headerEnd + 1;
    const content = output.subarray(start, start + object.bytes);
    if (content.length !== object.bytes || output[start + object.bytes] !== 10) {
      throw new Error("Truncated Git object; audit is incomplete.");
    }
    const labels = [...new Set(needles.filter(needle => content.includes(needle.bytes)).map(needle => needle.label))];
    if (labels.length) findings.push({ object: object.id, type: object.type, labels });
    // Raw scans cannot establish that compressed archives are free of credentials.
    if (object.type === "blob" && archiveSignatures.some(signature => content.subarray(0, signature.length).equals(signature))) {
      archives.push(object.id);
    }
    offset = start + object.bytes + 1;
  }
  if (offset !== output.length) throw new Error("Unexpected trailing batch data; audit is incomplete.");
  return {
    status: findings.length || archives.length ? "review-required" : "known-values-not-found",
    checkedAt: new Date().toISOString(),
    scope: "All local Git objects, including unreachable objects, for provided known values and common encoded forms. Not a general secret or security audit; working files and repository configuration are outside scope.",
    limits: "No arbitrary unknown credentials, custom encodings, nested or unrecognized containers are guaranteed detectable. Recognized archive blobs require separate inspection.",
    objects: inventory.length, bytes,
    objectTypes: Object.fromEntries(["blob", "tree", "commit", "tag"].map(type => [type, inventory.filter(object => object.type === type).length])),
    labels: [...new Set(secrets.map(secret => secret.label))],
    findings, archivesRequiringInspection: archives
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { BTF_WEBDAV_URL: url, BTF_WEBDAV_USERNAME: username, BTF_WEBDAV_PASSWORD: password } = process.env;
    if (!url || !username || !password) throw new Error("Set the three BTF_WEBDAV_* variables temporarily; do not put credentials in command arguments.");
    const report = auditGitObjects(root, [
      { label: "webdav_url", value: url }, { label: "webdav_host", value: new URL(url).hostname },
      { label: "webdav_username", value: username }, { label: "webdav_password", value: password },
      { label: "webdav_basic_auth", value: Buffer.from(`${username}:${password}`).toString("base64") }
    ]);
    const json = JSON.stringify(report, null, 2);
    if (process.argv[2]) await writeFile(path.resolve(process.argv[2]), json);
    console.log(json);
    if (report.status !== "known-values-not-found") process.exitCode = 1;
  } catch {
    console.error("Git audit could not complete. Check repository access, input configuration and the 64 MiB audit limit. No clean result is recorded.");
    process.exitCode = 1;
  }
}
