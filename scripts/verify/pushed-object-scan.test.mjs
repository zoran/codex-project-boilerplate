import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectPushedObjects } from "./pushed-object-scan.mjs";
import { createSecretContentScanner } from "./secret-content-scan.mjs";

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function commit(root, message) {
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

function temporaryRepository() {
  const root = mkdtempSync(path.join(tmpdir(), "pushed-object-scan-"));
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "user.name", "Verification Fixture");
  git(root, "config", "advice.nestedTag", "false");
  return root;
}

test("stream scanner detects a signature split across chunks", () => {
  const scanner = createSecretContentScanner();
  scanner.write(Buffer.from("prefix -----BEGIN PRI"));
  scanner.write(Buffer.from("VATE KEY----- suffix"));
  assert.deepEqual(scanner.findings(), ["private key block"]);
});

test("pushed range includes secrets and sensitive paths removed before the tip", async (t) => {
  const root = temporaryRepository();
  t.after(() => rmSync(root, { force: true, recursive: true }));

  writeFileSync(path.join(root, "README.md"), "# Fixture\n", "utf8");
  const baseline = commit(root, "baseline");

  writeFileSync(
    path.join(root, "temporary.txt"),
    ["-----BEGIN PRIVATE", " KEY-----\nsynthetic fixture only\n"].join(""),
    "utf8",
  );
  writeFileSync(path.join(root, ".npmrc"), "registry=https://example.invalid\n", "utf8");
  const unsafeCommit = commit(root, ["unsafe intermediate state ", "sk-", "a".repeat(24)].join(""));

  unlinkSync(path.join(root, "temporary.txt"));
  unlinkSync(path.join(root, ".npmrc"));
  const tip = commit(root, "remove unsafe files");

  const input = `refs/heads/main ${tip} refs/heads/main ${baseline}\n`;
  const result = await inspectPushedObjects(input, { repositoryRoot: root });

  assert.ok(result.commitCount >= 2);
  assert.ok(
    result.findings.some(
      (finding) =>
        finding.includes(unsafeCommit.slice(0, 12)) && finding.includes("private key block"),
    ),
  );
  assert.ok(result.findings.some((finding) => finding.includes(".npmrc")));
  assert.ok(
    result.findings.some(
      (finding) =>
        finding.includes(`${unsafeCommit.slice(0, 12)} commit metadata`) &&
        finding.includes("OpenAI-style API key"),
    ),
  );
});

test("clean pushed range passes without findings", async (t) => {
  const root = temporaryRepository();
  t.after(() => rmSync(root, { force: true, recursive: true }));

  writeFileSync(path.join(root, "README.md"), "# Fixture\n", "utf8");
  const baseline = commit(root, "baseline");
  writeFileSync(path.join(root, "feature.txt"), "ordinary fixture content\n", "utf8");
  const tip = commit(root, "feature");

  const result = await inspectPushedObjects(
    `refs/heads/main ${tip} refs/heads/main ${baseline}\n`,
    { repositoryRoot: root },
  );
  assert.deepEqual(result.findings, []);
  assert.equal(result.commitCount, 1);
  assert.equal(result.refCount, 1);
});

test("annotated tag metadata is part of the pushed object scan", async (t) => {
  const root = temporaryRepository();
  t.after(() => rmSync(root, { force: true, recursive: true }));
  writeFileSync(path.join(root, "README.md"), "# Fixture\n", "utf8");
  commit(root, "baseline");
  git(
    root,
    "tag",
    "--annotate",
    "release",
    "--message",
    ["tag fixture ", "github_pat_", "a".repeat(24)].join(""),
  );
  const tagObject = git(root, "rev-parse", "refs/tags/release");
  const result = await inspectPushedObjects(
    `refs/tags/release ${tagObject} refs/tags/release ${"0".repeat(tagObject.length)}\n`,
    { repositoryRoot: root },
  );
  assert.ok(
    result.findings.some(
      (finding) =>
        finding.includes("pushed tag metadata") && finding.includes("GitHub fine-grained token"),
    ),
  );
});

test("nested annotated tags scan every tag object before the commit", async (t) => {
  const root = temporaryRepository();
  t.after(() => rmSync(root, { force: true, recursive: true }));
  writeFileSync(path.join(root, "README.md"), "# Fixture\n", "utf8");
  commit(root, "baseline");
  git(
    root,
    "tag",
    "--annotate",
    "inner-release",
    "--message",
    ["inner tag fixture ", "github_pat_", "b".repeat(24)].join(""),
  );
  const innerTagObject = git(root, "rev-parse", "refs/tags/inner-release");
  git(root, "tag", "--annotate", "outer-release", "--message", "clean outer tag", "inner-release");
  const outerTagObject = git(root, "rev-parse", "refs/tags/outer-release");

  const result = await inspectPushedObjects(
    `refs/tags/outer-release ${outerTagObject} refs/tags/outer-release ${"0".repeat(outerTagObject.length)}\n`,
    { repositoryRoot: root },
  );
  assert.ok(
    result.findings.some(
      (finding) =>
        finding.includes(innerTagObject.slice(0, 12)) &&
        finding.includes("pushed tag metadata") &&
        finding.includes("GitHub fine-grained token"),
    ),
  );
});

test("new refs do not trust local remote-tracking exclusions", async (t) => {
  const root = temporaryRepository();
  t.after(() => rmSync(root, { force: true, recursive: true }));
  writeFileSync(path.join(root, "README.md"), "# Fixture\n", "utf8");
  commit(root, "baseline");
  writeFileSync(
    path.join(root, "temporary.txt"),
    ["-----BEGIN PRIVATE", " KEY-----\nsynthetic fixture only\n"].join(""),
    "utf8",
  );
  const unsafeCommit = commit(root, "unsafe state");
  git(root, "update-ref", "refs/remotes/origin/stale", unsafeCommit);
  unlinkSync(path.join(root, "temporary.txt"));
  const tip = commit(root, "remove unsafe state");

  const result = await inspectPushedObjects(
    `refs/heads/new ${tip} refs/heads/new ${"0".repeat(tip.length)}\n`,
    { repositoryRoot: root },
  );
  assert.ok(
    result.findings.some(
      (finding) =>
        finding.includes(unsafeCommit.slice(0, 12)) && finding.includes("private key block"),
    ),
  );
});

test("long same-tip multi-ref pushes use a bounded Git process pipeline", async (t) => {
  const root = temporaryRepository();
  t.after(() => rmSync(root, { force: true, recursive: true }));
  writeFileSync(path.join(root, "history.txt"), "0\n", "utf8");
  const baseline = commit(root, "baseline");
  let unsafeCommit = "";
  for (let index = 1; index <= 100; index += 1) {
    writeFileSync(path.join(root, "history.txt"), `${index}\n`, "utf8");
    if (index === 50) {
      writeFileSync(
        path.join(root, "temporary.txt"),
        ["-----BEGIN PRIVATE", " KEY-----\nsynthetic fixture only\n"].join(""),
        "utf8",
      );
    }
    if (index === 51) unlinkSync(path.join(root, "temporary.txt"));
    const current = commit(root, `history ${index}`);
    if (index === 50) unsafeCommit = current;
  }
  const tip = git(root, "rev-parse", "HEAD");
  const tracePath = path.join(root, "git-trace.jsonl");
  const previousTrace = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = tracePath;
  let result;
  try {
    result = await inspectPushedObjects(
      [
        `refs/heads/main ${tip} refs/heads/main ${baseline}`,
        `refs/heads/release ${tip} refs/heads/release ${baseline}`,
        "",
      ].join("\n"),
      { repositoryRoot: root },
    );
  } finally {
    if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previousTrace;
  }

  assert.equal(result.commitCount, 100);
  assert.ok(
    result.findings.some(
      (finding) =>
        finding.includes(unsafeCommit.slice(0, 12)) && finding.includes("private key block"),
    ),
  );
  const starts = readFileSync(tracePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.event === "start");
  assert.ok(starts.length <= 9, `expected at most 9 Git processes, observed ${starts.length}`);
});
