import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { listPortableTransferFiles } from "../../../../scripts/repository/source-inventory.mjs";
import { captureStableRepositoryFileIdentity } from "../../../../scripts/repository/stable-file-snapshot.mjs";
import { fail } from "./project-options.mjs";

function runGit(root, args, label) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: null,
    input: Buffer.alloc(0),
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    const detail = result.error?.message ?? `status ${result.status}`;
    fail(`${label} failed (${detail}).`);
  }
  return result.stdout;
}

export function captureSourceGitState(sourceRoot) {
  const gitRoot = runGit(sourceRoot, ["rev-parse", "--show-toplevel"], "Source Git root probe")
    .toString("utf8")
    .trim();
  if (!gitRoot || realpathSync(gitRoot) !== sourceRoot) {
    fail("Source repository must be the root of a real Git worktree.");
  }
  const trackedState = runGit(
    sourceRoot,
    ["status", "--porcelain=v1", "-z", "--untracked-files=no"],
    "Source Git state capture",
  );
  const portableWorkingTree = listPortableTransferFiles({
    root: sourceRoot,
    includeUntracked: true,
  });
  const portableIdentities = portableWorkingTree.flatMap((relativePath) => {
    const { bytes, identity } = captureStableRepositoryFileIdentity({
      repositoryRoot: sourceRoot,
      relativePath,
    });
    return [relativePath, String(bytes), identity];
  });
  return Buffer.concat([
    trackedState,
    Buffer.from("\0portable-working-tree\0"),
    Buffer.from(`${portableIdentities.join("\0")}\0`),
  ]);
}

export function assertSourceGitStateUnchanged(sourceRoot, before) {
  const after = captureSourceGitState(sourceRoot);
  if (!after.equals(before)) {
    fail(
      "Source boilerplate changed during project creation; staging was discarded and no project was published.",
    );
  }
}
