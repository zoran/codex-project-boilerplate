import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { listActiveFiles, listPortableTransferFiles } from "./source-inventory.mjs";
import { projectFormatFiles } from "../verify/format-project.mjs";

function write(root, relativePath, content = relativePath) {
  const target = path.join(root, ...relativePath.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

test("source inventory ignores ambient and repository-local Git excludes", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "source-inventory-git-environment-"));
  const root = path.join(fixture, "project");
  const xdgConfigHome = path.join(fixture, "xdg");
  mkdirSync(root, { recursive: true });
  write(root, ".gitignore", "src/project-ignored.ts\n");
  write(root, "src/ambient-hidden.ts", "export const ambient = true;\n");
  write(root, "src/local-hidden.ts", "export const local = true;\n");
  write(root, "src/project-ignored.ts", "export const ignored = true;\n");
  write(root, "src/visible.ts", "export const visible = true;\n");
  write(xdgConfigHome, "git/ignore", "src/ambient-hidden.ts\n");
  const initialized = spawnSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  write(root, ".git/info/exclude", "src/local-hidden.ts\n");

  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdgConfigHome;
  try {
    const ambientGit = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(ambientGit.status, 0, ambientGit.stderr);
    assert.doesNotMatch(ambientGit.stdout, /(?:ambient|local)-hidden\.ts/);

    for (const files of [
      listActiveFiles({ root }),
      listPortableTransferFiles({ root }),
      projectFormatFiles(root),
    ]) {
      assert.equal(files.includes("src/ambient-hidden.ts"), true);
      assert.equal(files.includes("src/local-hidden.ts"), true);
      assert.equal(files.includes("src/project-ignored.ts"), false);
    }
  } finally {
    if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("source inventory binds its worktree and disables repository-local FSMonitor execution", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "source-inventory-local-git-config-"));
  const root = path.join(fixture, "project");
  const redirectedWorktree = path.join(fixture, "redirected-worktree");
  const sentinel = path.join(fixture, "fsmonitor-was-invoked");
  const fsmonitor = path.join(fixture, "fsmonitor-hook.mjs");
  mkdirSync(root, { recursive: true });
  mkdirSync(redirectedWorktree, { recursive: true });
  write(root, ".gitignore", "src/project-ignored.ts\n");
  write(root, "src/project.ts", "export const project = true;\n");
  write(redirectedWorktree, "src/foreign.ts", "export const foreign = true;\n");
  writeFileSync(
    fsmonitor,
    '#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nif (process.env.FSMONITOR_SENTINEL) writeFileSync(process.env.FSMONITOR_SENTINEL, "called\\n");\nprocess.exitCode = 1;\n',
    "utf8",
  );
  chmodSync(fsmonitor, 0o755);
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: root }).status, 0);
  assert.equal(spawnSync("git", ["config", "core.fsmonitor", fsmonitor], { cwd: root }).status, 0);

  const naiveStatus = spawnSync("git", ["status", "--porcelain=v1"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, FSMONITOR_SENTINEL: sentinel },
  });
  assert.equal(naiveStatus.status, 0, naiveStatus.stderr);
  assert.equal(existsSync(sentinel), true);
  rmSync(sentinel);
  assert.equal(
    spawnSync("git", ["config", "core.worktree", redirectedWorktree], { cwd: root }).status,
    0,
  );
  const naiveRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(naiveRoot.status, 0, naiveRoot.stderr);
  assert.equal(path.resolve(naiveRoot.stdout.trim()), redirectedWorktree);

  const previousSentinel = process.env.FSMONITOR_SENTINEL;
  process.env.FSMONITOR_SENTINEL = sentinel;
  try {
    for (const files of [
      listActiveFiles({ root }),
      listPortableTransferFiles({ root }),
      projectFormatFiles(root),
    ]) {
      assert.equal(files.includes("src/project.ts"), true);
      assert.equal(files.includes("src/foreign.ts"), false);
    }
    assert.equal(existsSync(sentinel), false);
  } finally {
    if (previousSentinel === undefined) delete process.env.FSMONITOR_SENTINEL;
    else process.env.FSMONITOR_SENTINEL = previousSentinel;
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("Git-less roots nested below another repository keep their own inventory boundary", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "source-inventory-parent-repository-"));
  const outer = path.join(fixture, "outer");
  const root = path.join(outer, "nested-project");
  mkdirSync(root, { recursive: true });
  write(outer, ".gitignore", "nested-project/src/hidden-by-parent.ts\n");
  write(root, "src/hidden-by-parent.ts", "export const local = true;\n");
  write(root, "src/project.ts", "export const project = true;\n");
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: outer }).status, 0);

  const naiveRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(path.resolve(naiveRoot.stdout.trim()), outer);
  for (const files of [
    listActiveFiles({ root }),
    listPortableTransferFiles({ root, includeUntracked: true }),
    projectFormatFiles(root),
  ]) {
    assert.equal(files.includes("src/hidden-by-parent.ts"), true);
    assert.equal(files.includes("src/project.ts"), true);
  }
  assert.throws(
    () => listPortableTransferFiles({ root, includeUntracked: false }),
    /Tracked portable transfer requires the source root to be a Git worktree/,
  );
  rmSync(fixture, { force: true, recursive: true });
});

test("owned Git worktree gitfiles are supported while symlinked metadata is rejected", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "source-inventory-owned-gitfile-"));
  const main = path.join(fixture, "main");
  const linked = path.join(fixture, "linked");
  mkdirSync(main);
  write(main, "README.md", "main\n");
  for (const args of [
    ["init", "-q"],
    ["config", "user.name", "Source Inventory Test"],
    ["config", "user.email", "source-inventory@example.invalid"],
    ["add", "README.md"],
    ["commit", "-q", "-m", "fixture"],
  ]) {
    const result = spawnSync("git", args, { cwd: main, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const addedWorktree = spawnSync("git", ["worktree", "add", "-q", "-b", "linked", linked], {
    cwd: main,
    encoding: "utf8",
  });
  assert.equal(addedWorktree.status, 0, addedWorktree.stderr);
  write(linked, "src/linked.ts", "export const linked = true;\n");
  assert.equal(listActiveFiles({ root: linked }).includes("src/linked.ts"), true);

  const unsafe = path.join(fixture, "unsafe");
  mkdirSync(unsafe);
  write(unsafe, "src/unsafe.ts", "export const unsafe = true;\n");
  symlinkSync(path.join(main, ".git"), path.join(unsafe, ".git"), "dir");
  assert.throws(() => listActiveFiles({ root: unsafe }), /Local Git metadata is unreadable/);
  rmSync(fixture, { force: true, recursive: true });
});
