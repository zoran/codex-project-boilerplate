import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sourceScript = path.join(root, "scripts/goals/goal-publication-precondition.mjs");
const temporaryRoots = [];

function temporaryRoot(prefix) {
  const value = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(value);
  return value;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    input: "",
    stdio: "pipe",
  });
  assert.equal(result.error, undefined);
  return result;
}

function git(cwd, ...args) {
  return run("git", args, cwd);
}

function assertGit(cwd, ...args) {
  const result = git(cwd, ...args);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function createFixture() {
  const parent = temporaryRoot("goal gate private workspace ");
  const repository = path.join(parent, "project-secret-name");
  const remote = path.join(parent, "remote-secret-name.git");
  mkdirSync(path.join(repository, "scripts", "goals"), { recursive: true });
  copyFileSync(
    sourceScript,
    path.join(repository, "scripts/goals/goal-publication-precondition.mjs"),
  );
  writeFileSync(path.join(repository, ".gitignore"), "/auth.json\n/.context-index/\n", "utf8");
  writeFileSync(path.join(repository, "tracked.txt"), "initial\n", "utf8");
  assertGit(repository, "init", "-q");
  assertGit(repository, "config", "user.name", "Goal Gate Test");
  assertGit(repository, "config", "user.email", "goal-gate@example.invalid");
  assertGit(repository, "add", "-A");
  assertGit(repository, "commit", "-q", "-m", "initial");
  assertGit(parent, "init", "--bare", "-q", remote);
  assertGit(repository, "remote", "add", "origin", remote);
  assertGit(repository, "push", "-q", "-u", "origin", "HEAD");
  return { parent, remote, repository };
}

function runGate(repository, options = {}) {
  return spawnSync(
    process.execPath,
    [path.join(repository, "scripts/goals/goal-publication-precondition.mjs")],
    {
      cwd: options.cwd ?? repository,
      encoding: "utf8",
      env: { ...process.env, ...(options.env ?? {}) },
      input: "",
      stdio: "pipe",
    },
  );
}

function outputOf(result) {
  return `${result.stdout}${result.stderr}`;
}

after(() => {
  for (const temporaryRootPath of temporaryRoots) {
    rmSync(temporaryRootPath, { force: true, recursive: true });
  }
});

test("goal:new passes only for a clean branch that exactly matches its upstream", () => {
  const { parent, repository } = createFixture();
  writeFileSync(path.join(repository, "auth.json"), "ignored local runtime\n", "utf8");
  mkdirSync(path.join(repository, ".context-index"));
  writeFileSync(path.join(repository, ".context-index", "manifest.json"), "{}\n", "utf8");

  const result = runGate(repository, { cwd: parent });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /publication precondition passed/i);
  assert.equal(outputOf(result).includes(parent), false);
  assert.equal(outputOf(result).includes("secret-name"), false);
});

test("goal:new fails closed for dirty, unpublished, missing-upstream, behind, and detached states", () => {
  const { parent, remote, repository } = createFixture();

  writeFileSync(path.join(repository, "unfinished-secret.txt"), "dirty\n", "utf8");
  const dirty = runGate(repository);
  assert.equal(dirty.status, 1);
  assert.match(dirty.stderr, /resolve all non-ignored work/i);
  rmSync(path.join(repository, "unfinished-secret.txt"));

  writeFileSync(path.join(repository, "tracked.txt"), "unpublished\n", "utf8");
  assertGit(repository, "add", "tracked.txt");
  assertGit(repository, "commit", "-q", "-m", "unpublished completion");
  const ahead = runGate(repository);
  assert.equal(ahead.status, 1);
  assert.match(ahead.stderr, /ahead 1, behind 0/);
  assertGit(repository, "push", "-q");
  assert.equal(runGate(repository).status, 0);

  const branch = git(repository, "branch", "--show-current").stdout.trim();
  assertGit(repository, "branch", "--unset-upstream");
  const noUpstream = runGate(repository);
  assert.equal(noUpstream.status, 1);
  assert.match(noUpstream.stderr, /no verifiable configured remote upstream/i);
  assertGit(repository, "branch", `--set-upstream-to=origin/${branch}`);

  const publisher = path.join(parent, "publisher-secret-name");
  assertGit(parent, "clone", "-q", remote, publisher);
  assertGit(publisher, "config", "user.name", "Goal Gate Publisher");
  assertGit(publisher, "config", "user.email", "goal-publisher@example.invalid");
  writeFileSync(path.join(publisher, "remote.txt"), "remote completion\n", "utf8");
  assertGit(publisher, "add", "remote.txt");
  assertGit(publisher, "commit", "-q", "-m", "remote completion");
  assertGit(publisher, "push", "-q");
  assertGit(repository, "fetch", "-q");
  const behind = runGate(repository);
  assert.equal(behind.status, 1);
  assert.match(behind.stderr, /ahead 0, behind 1/i);
  assert.equal(outputOf(behind).includes(parent), false);

  assertGit(repository, "checkout", "--detach", "-q");
  const detached = runGate(repository);
  assert.equal(detached.status, 1);
  assert.match(detached.stderr, /named branch/i);
  assert.equal(outputOf(detached).includes(parent), false);
});

test("goal:new ignores ambient Git redirection and fails outside its own project root", () => {
  const { remote, repository } = createFixture();
  const result = runGate(repository, {
    env: {
      GIT_DIR: remote,
      GIT_WORK_TREE: path.dirname(remote),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.bare",
      GIT_CONFIG_VALUE_0: "true",
    },
  });
  assert.equal(result.status, 0, result.stderr);

  const nonRepository = temporaryRoot("goal gate no repository ");
  mkdirSync(path.join(nonRepository, "scripts", "goals"), { recursive: true });
  copyFileSync(
    sourceScript,
    path.join(nonRepository, "scripts/goals/goal-publication-precondition.mjs"),
  );
  const missing = runGate(nonRepository);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /not a Git worktree/i);
  assert.equal(outputOf(missing).includes(nonRepository), false);
});

test("goal:new cannot hide unfinished work through ambient Git exclude configuration", () => {
  const { parent, repository } = createFixture();
  const unfinishedName = "unfinished-private.txt";
  const excludesPath = path.join(parent, "ambient-excludes");
  const globalConfigPath = path.join(parent, "ambient-global-config");
  const xdgConfigHome = path.join(parent, "ambient-xdg-config");
  mkdirSync(path.join(xdgConfigHome, "git"), { recursive: true });
  writeFileSync(path.join(repository, unfinishedName), "unfinished\n", "utf8");
  writeFileSync(excludesPath, `${unfinishedName}\n`, "utf8");
  writeFileSync(path.join(xdgConfigHome, "git", "ignore"), `${unfinishedName}\n`, "utf8");
  assertGit(parent, "config", "--file", globalConfigPath, "core.excludesFile", excludesPath);
  const ambientEnvironment = {
    GIT_CONFIG_GLOBAL: globalConfigPath,
    GIT_CONFIG_NOSYSTEM: "0",
    GIT_CONFIG_PARAMETERS: `'core.excludesFile'='${excludesPath}'`,
    GIT_CONFIG_SYSTEM: globalConfigPath,
    XDG_CONFIG_HOME: xdgConfigHome,
  };
  const hiddenStatus = spawnSync(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    {
      cwd: repository,
      encoding: "utf8",
      env: { ...process.env, ...ambientEnvironment },
      input: "",
      stdio: "pipe",
    },
  );
  assert.equal(hiddenStatus.status, 0, hiddenStatus.stderr);
  assert.equal(hiddenStatus.stdout, "");

  const result = runGate(repository, { env: ambientEnvironment });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /resolve all non-ignored work/i);
  assert.equal(outputOf(result).includes(parent), false);
});

test("goal:new rejects a local branch masquerading as a publication upstream", () => {
  const { repository } = createFixture();
  assertGit(repository, "branch", "local-proof", "HEAD");
  assertGit(repository, "branch", "--set-upstream-to=local-proof");

  const result = runGate(repository);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no verifiable configured remote upstream/i);
});
