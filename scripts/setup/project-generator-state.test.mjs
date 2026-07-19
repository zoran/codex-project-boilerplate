import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertSourceGitStateUnchanged,
  captureSourceGitState,
} from "../../.agents/skills/create-project-from-boilerplate/scripts/source-git-state.mjs";

test("generator source state detects content changes inside an already dirty tracked path", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "project-generator-state-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  execFileSync("git", ["init", "-q"], { cwd: root });
  const trackedPath = path.join(root, "tracked.txt");
  writeFileSync(trackedPath, "staged\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: root });
  writeFileSync(trackedPath, "before\n");
  const before = captureSourceGitState(root);

  assert.doesNotThrow(() => assertSourceGitStateUnchanged(root, before));
  writeFileSync(trackedPath, "after!\n");
  assert.throws(
    () => assertSourceGitStateUnchanged(root, before),
    /Source boilerplate changed during project creation/,
  );
});

test("generator source state binds its worktree and disables repository-local FSMonitor", (t) => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "project-generator-git-config-"));
  const root = path.join(parent, "source");
  const redirectedWorktree = path.join(parent, "redirected-worktree");
  const sentinel = path.join(parent, "fsmonitor-was-invoked");
  const fsmonitor = path.join(parent, "fsmonitor-hook.mjs");
  t.after(() => rmSync(parent, { force: true, recursive: true }));
  mkdirSync(root);
  mkdirSync(redirectedWorktree);
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(path.join(root, "tracked.txt"), "source\n");
  writeFileSync(path.join(redirectedWorktree, "foreign.txt"), "foreign\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: root });
  writeFileSync(
    fsmonitor,
    '#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nif (process.env.FSMONITOR_SENTINEL) writeFileSync(process.env.FSMONITOR_SENTINEL, "called\\n");\nprocess.exitCode = 1;\n',
    "utf8",
  );
  chmodSync(fsmonitor, 0o755);
  execFileSync("git", ["config", "core.fsmonitor", fsmonitor], { cwd: root });
  execFileSync("git", ["status", "--porcelain=v1"], {
    cwd: root,
    env: { ...process.env, FSMONITOR_SENTINEL: sentinel },
  });
  assert.equal(existsSync(sentinel), true);
  rmSync(sentinel);
  execFileSync("git", ["config", "core.worktree", redirectedWorktree], { cwd: root });

  const previousSentinel = process.env.FSMONITOR_SENTINEL;
  process.env.FSMONITOR_SENTINEL = sentinel;
  try {
    const state = captureSourceGitState(root);
    assert.equal(Buffer.isBuffer(state), true);
    assert.doesNotThrow(() => assertSourceGitStateUnchanged(root, state));
    assert.equal(existsSync(sentinel), false);
  } finally {
    if (previousSentinel === undefined) delete process.env.FSMONITOR_SENTINEL;
    else process.env.FSMONITOR_SENTINEL = previousSentinel;
  }
});

test("generator source state rejects a Git-less root nested below another repository", (t) => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "project-generator-parent-repository-"));
  const root = path.join(parent, "nested-project");
  t.after(() => rmSync(parent, { force: true, recursive: true }));
  mkdirSync(root);
  execFileSync("git", ["init", "-q"], { cwd: parent });
  writeFileSync(path.join(root, "source.txt"), "nested source\n");

  assert.throws(
    () => captureSourceGitState(root),
    /Source repository must be the root of a real Git worktree/,
  );
});
