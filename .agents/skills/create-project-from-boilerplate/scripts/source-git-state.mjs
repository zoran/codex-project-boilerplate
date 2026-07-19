import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { listPortableTransferFiles } from "../../../../scripts/repository/source-inventory.mjs";
import { captureStableRepositoryFileIdentity } from "../../../../scripts/repository/stable-file-snapshot.mjs";
import {
  cleanGitEnvironment,
  isolatedGitArguments,
  resolveOwnedGitMetadata,
} from "../../../../scripts/repository/git-runtime-isolation.mjs";
import { fail } from "./project-options.mjs";

function runGit(metadata, args, label) {
  const result = spawnSync("git", isolatedGitArguments({ args, ...metadata }), {
    cwd: metadata.workTree,
    encoding: null,
    env: cleanGitEnvironment(),
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
  let gitMetadata;
  try {
    gitMetadata = resolveOwnedGitMetadata(sourceRoot);
  } catch {
    fail("Source repository must have safe project-owned Git metadata.");
  }
  if (!gitMetadata) fail("Source repository must be the root of a real Git worktree.");
  const gitRoot = runGit(gitMetadata, ["rev-parse", "--show-toplevel"], "Source Git root probe")
    .toString("utf8")
    .trim();
  if (!gitRoot || realpathSync(gitRoot) !== gitMetadata.workTree) {
    fail("Source repository must be the root of a real Git worktree.");
  }
  const trackedState = runGit(
    gitMetadata,
    ["status", "--porcelain=v1", "-z", "--untracked-files=no"],
    "Source Git state capture",
  );
  const portableWorkingTree = listPortableTransferFiles({
    root: gitMetadata.workTree,
    includeUntracked: true,
  });
  const portableIdentities = portableWorkingTree.flatMap((relativePath) => {
    const { bytes, identity } = captureStableRepositoryFileIdentity({
      repositoryRoot: gitMetadata.workTree,
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
