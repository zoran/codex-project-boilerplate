import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..", "..");

function cleanGitEnvironment() {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("GIT_")) delete environment[name];
  }
  return {
    ...environment,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
}

function git(args) {
  return spawnSync("git", ["-c", "core.excludesFile=", ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: cleanGitEnvironment(),
    input: "",
    stdio: "pipe",
  });
}

function successful(result) {
  return !result.error && result.status === 0;
}

function fail(message) {
  console.error(`Cannot start a new goal: ${message}`);
  process.exitCode = 1;
}

function main() {
  if (process.argv.length !== 2) {
    fail("goal:new takes no arguments and only verifies the publication precondition.");
    return;
  }

  const insideWorktree = git(["rev-parse", "--is-inside-work-tree"]);
  const topLevel = git(["rev-parse", "--show-toplevel"]);
  if (
    !successful(insideWorktree) ||
    insideWorktree.stdout.trim() !== "true" ||
    !successful(topLevel) ||
    path.resolve(topLevel.stdout.trim()) !== repositoryRoot
  ) {
    fail("the canonical project root is not a Git worktree.");
    return;
  }

  const currentBranch = git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!successful(currentBranch) || !currentBranch.stdout.trim()) {
    fail("the repository must be on a named branch.");
    return;
  }
  if (!successful(git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]))) {
    fail("the current branch has no published commit to verify.");
    return;
  }

  const worktree = git([
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ]);
  if (!successful(worktree)) {
    fail("the previous goal's worktree state could not be verified.");
    return;
  }
  if (worktree.stdout.length > 0) {
    fail("commit or otherwise resolve all non-ignored work from the previous goal first.");
    return;
  }

  const branchName = currentBranch.stdout.trim();
  const configuredRemote = git(["config", "--local", "--get", `branch.${branchName}.remote`]);
  if (
    !successful(configuredRemote) ||
    !configuredRemote.stdout.trim() ||
    configuredRemote.stdout.trim() === "."
  ) {
    fail("the current branch has no verifiable configured remote upstream.");
    return;
  }
  const remoteName = configuredRemote.stdout.trim();
  const configuredMerge = git(["config", "--local", "--get", `branch.${branchName}.merge`]);
  if (!successful(configuredMerge) || !configuredMerge.stdout.trim().startsWith("refs/heads/")) {
    fail("the current branch has no verifiable configured remote upstream.");
    return;
  }
  const remoteUrl = git(["config", "--local", "--get-all", `remote.${remoteName}.url`]);
  if (!successful(remoteUrl) || !remoteUrl.stdout.trim()) {
    fail("the current branch has no verifiable configured remote upstream.");
    return;
  }
  const upstreamReference = git(["rev-parse", "--symbolic-full-name", "@{upstream}"]);
  if (
    !successful(upstreamReference) ||
    !upstreamReference.stdout.trim().startsWith(`refs/remotes/${remoteName}/`) ||
    !successful(git(["rev-parse", "--verify", "--quiet", "@{upstream}^{commit}"]))
  ) {
    fail("the current branch has no verifiable configured upstream.");
    return;
  }

  const comparison = git(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
  if (!successful(comparison)) {
    fail("the current branch could not be compared with its configured upstream.");
    return;
  }
  const counts = comparison.stdout.trim().split(/\s+/).map(Number);
  if (counts.length !== 2 || counts.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    fail("Git returned an invalid publication comparison.");
    return;
  }
  const [ahead, behind] = counts;
  if (ahead !== 0 || behind !== 0) {
    fail(
      `the current branch must exactly match its configured upstream (ahead ${ahead}, behind ${behind}).`,
    );
    return;
  }

  console.log(
    "Goal publication precondition passed: the worktree is clean and HEAD matches its configured upstream.",
  );
}

main();
