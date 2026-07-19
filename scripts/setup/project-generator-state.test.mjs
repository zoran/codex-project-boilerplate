import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
