import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const temporaryRoots = [];

export function temporaryRoot(prefix) {
  const value = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(value);
  return value;
}

export function cleanupTemporaryRoots() {
  for (const temporaryRootPath of temporaryRoots.splice(0)) {
    rmSync(temporaryRootPath, { force: true, recursive: true });
  }
}

export function readdirNames(directory) {
  return readdirSync(directory).sort();
}

export function textFiles(directory) {
  const files = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolutePath);
      else if (entry.isFile()) files.push(absolutePath);
    }
  }
  return files;
}

export function initializeTrackedSource(sourceRoot) {
  const initialized = spawnSync("git", ["init", "-q"], {
    cwd: sourceRoot,
    encoding: "utf8",
    input: "",
    stdio: "pipe",
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  const added = spawnSync("git", ["add", "-A"], {
    cwd: sourceRoot,
    encoding: "utf8",
    input: "",
    stdio: "pipe",
  });
  assert.equal(added.status, 0, added.stderr);
}

export function gitState(sourceRoot) {
  const result = spawnSync(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"],
    {
      cwd: sourceRoot,
      encoding: null,
      input: Buffer.alloc(0),
      stdio: "pipe",
    },
  );
  assert.equal(result.status, 0, result.stderr?.toString("utf8"));
  return result.stdout;
}

export function assertFormatting(targetRoot) {
  const formatterPath = path.join(root, "node_modules", "prettier", "bin", "prettier.cjs");
  const result = spawnSync(process.execPath, [formatterPath, "--check", "."], {
    cwd: targetRoot,
    encoding: "utf8",
    input: "",
    stdio: "pipe",
  });
  assert.equal(result.status, 0, result.stderr);
}
