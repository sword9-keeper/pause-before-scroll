import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { auditGitObjects } from "../scripts/audit-git.mjs";

async function fixture(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "pause-git-audit-"));
  const git = (...args) => execFileSync("git", [
    "-c", "user.name=Audit Fixture", "-c", "user.email=audit@example.test", ...args
  ], { cwd: directory, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  try {
    git("init", "--quiet");
    await run({ directory, git });
  } finally {
    if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith("pause-git-audit-")) {
      throw new Error("Refusing to remove an unexpected audit fixture.");
    }
    await rm(directory, { recursive: true, force: true });
  }
}

test("Git audit finds known values in deleted history, commit and tag messages, and unreachable objects without printing values", async () => {
  await fixture(async ({ directory, git }) => {
    const value = "synthetic-fixture-password-8246";
    await writeFile(path.join(directory, "removed.txt"), value);
    git("add", "removed.txt");
    git("commit", "--quiet", "-m", `synthetic commit ${value}`);
    git("tag", "-a", "fixture", "-m", `synthetic tag ${value}`);
    git("rm", "--quiet", "removed.txt");
    git("commit", "--quiet", "-m", "Remove synthetic file");
    const dangling = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: directory, input: `unreachable ${value}`, encoding: "utf8"
    }).trim();
    const report = auditGitObjects(directory, [{ label: "fixture_password", value }]);
    assert.equal(report.status, "review-required");
    assert.ok(report.findings.some(finding => finding.type === "commit"));
    assert.ok(report.findings.some(finding => finding.type === "tag"));
    assert.equal(report.findings.filter(finding => finding.type === "blob").length, 2);
    assert.ok(report.findings.some(finding => finding.object === dangling));
    assert.equal(JSON.stringify(report).includes(value), false);
    assert.ok(report.findings.every(finding => finding.labels.join() === "fixture_password"));
  });
});

test("Git audit handles binary framing, flags archive blobs, and checks common encodings", async () => {
  await fixture(async ({ directory, git }) => {
    const value = 'synthetic value "for/audit"';
    await writeFile(path.join(directory, "data.bin"), Buffer.concat([
      Buffer.from([0, 255, 10]), Buffer.from(encodeURIComponent(value)), Buffer.from([0, 10, 254])
    ]));
    await writeFile(path.join(directory, "data.json"), JSON.stringify({ fixture: value }));
    await writeFile(path.join(directory, "container.zip"), Buffer.from("504b030400000000", "hex"));
    git("add", ".");
    git("commit", "--quiet", "-m", "Synthetic binary and JSON");
    const report = auditGitObjects(directory, [{ label: "fixture_value", value }]);
    assert.equal(report.findings.length, 2);
    assert.equal(report.archivesRequiringInspection.length, 1);
    assert.equal(report.status, "review-required");
    assert.equal(JSON.stringify(report).includes(value), false);
  });
});

test("Git audit distinguishes a clean known-value scan from a general secrets guarantee and rejects empty inputs", async () => {
  await fixture(async ({ directory, git }) => {
    await writeFile(path.join(directory, "readme.txt"), "No configured fixture secret.");
    git("add", ".");
    git("commit", "--quiet", "-m", "Synthetic clean history");
    const report = auditGitObjects(directory, [{ label: "fixture_password", value: "synthetic-unmatched-credential" }]);
    assert.equal(report.status, "known-values-not-found");
    assert.equal(report.objects, 3);
    assert.deepEqual(report.findings, []);
    assert.deepEqual(report.archivesRequiringInspection, []);
    assert.match(report.scope, /Not a general secret or security audit/);
    assert.throws(() => auditGitObjects(directory, []), /known-secret/);
  });
});
