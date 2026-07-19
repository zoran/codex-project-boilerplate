import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { portableContextContractFiles } from "../context/portable-context-contract.mjs";
import {
  gitlessPreDescentExcludePatterns,
  isRepositoryCodexHomePath,
  listActiveFiles,
  listPortableTransferFiles,
  listRepositoryFiles,
  listStagedTransferFiles,
  portableCodexGitignorePatterns,
  portableCodexGitignoreProbePaths,
  repositoryCodexHomeGitignoreBehaviorFindings,
  repositoryCodexHomeGitignoreFindings,
  repositoryCodexHomeGitignorePatterns,
  repositoryCodexHomeProtectedGitignoreProbePaths,
  repositoryCodexHomeRuntimeDirectoryNames,
  repositoryCodexHomeRuntimeProbePaths,
  repositoryRoot,
} from "./source-inventory.mjs";
import { assertSafeTransferSource } from "./validate-transfer-source.mjs";
import { stageProjectExport } from "../setup/stage-project-export.mjs";
import { scanRepositorySecrets } from "../verify/secrets.mjs";
import { projectFormatFiles } from "../verify/format-project.mjs";
import {
  captureStableRepositoryFileIdentity,
  copyStableRepositoryFile,
} from "./stable-file-snapshot.mjs";

const temporaryRoots = [];

function temporaryRoot(prefix) {
  const value = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(value);
  return value;
}

function write(root, relativePath, content = relativePath) {
  const target = path.join(root, ...relativePath.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

function writePortableCodexFiles(targetRoot) {
  write(
    targetRoot,
    ".codex/config.toml",
    readFileSync(path.join(repositoryRoot, ".codex", "config.toml"), "utf8"),
  );
  write(targetRoot, ".codex/README.md", "portable config\n");
  write(
    targetRoot,
    ".codex/hooks.json",
    readFileSync(path.join(repositoryRoot, ".codex", "hooks.json"), "utf8"),
  );
  for (const relativePath of portableContextContractFiles) {
    write(
      targetRoot,
      relativePath,
      readFileSync(path.join(repositoryRoot, ...relativePath.split("/")), "utf8"),
    );
  }
  for (const name of ["refresh-context-index-on-stop.sh", "refresh-context-index-on-stop.mjs"]) {
    write(
      targetRoot,
      `scripts/context/${name}`,
      readFileSync(path.join(repositoryRoot, "scripts", "context", name), "utf8"),
    );
  }
  write(targetRoot, "src/.gitkeep", "");
}

function git(root, args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8", input: "", stdio: "pipe" });
}

function initializeGit(root) {
  const result = git(root, ["init", "-q"]);
  assert.equal(result.status, 0, result.stderr);
}

function runStagedProjectValidator(stageRoot, args = []) {
  return spawnSync(
    process.execPath,
    [path.join(stageRoot, "scripts/setup/validate-staged-project.mjs"), ...args],
    {
      cwd: stageRoot,
      encoding: "utf8",
      env: process.env,
      input: "",
      stdio: "pipe",
    },
  );
}

async function validateStagedProject(stageRoot) {
  const result = runStagedProjectValidator(stageRoot);
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message ?? `${result.stdout}${result.stderr}`);
  }
  return { root: stageRoot };
}

after(() => {
  for (const root of temporaryRoots) rmSync(root, { force: true, recursive: true });
});

test("active inventory excludes generated and runtime directories at every depth", () => {
  const root = temporaryRoot("source-inventory-");
  write(root, "README.md");
  write(root, ".codex/config.toml");
  write(root, ".codex/hooks.json", "{}\n");
  write(root, ".codex/README.md");
  write(root, ".codex/runtime/session.json");
  write(root, "apps/site/src/index.ts");
  write(root, "apps/site/node_modules/pkg/private.txt");
  write(root, "apps/site/.git/config");
  write(root, "packages/lib/dist/index.js");
  write(root, ".gitignore", "private-notes.md\n");
  write(root, "private-notes.md", "ignored private context\n");

  assert.deepEqual(listActiveFiles({ root }), [
    ".codex/README.md",
    ".codex/config.toml",
    ".codex/hooks.json",
    ".gitignore",
    "README.md",
    "apps/site/src/index.ts",
  ]);
});

test("Git-less inventory excludes private root Codex state before directory descent", () => {
  const root = temporaryRoot("source-gitless-codex-home-");
  write(root, "README.md", "portable\n");
  write(root, ".codex/config.toml", "portable config\n");
  write(root, ".codex/auth.json", "private auth\n");
  write(root, "auth.json", "private auth\n");
  write(root, "sessions/deep/private-thread.jsonl", "private session\n");
  write(root, ".context-index/model/private.bin", "private model\n");
  write(root, ".project-state/private.json", "private process state\n");

  assert.equal(existsSync(path.join(root, ".git")), false);
  for (const pattern of [
    ...repositoryCodexHomeGitignorePatterns,
    ...portableCodexGitignorePatterns,
    "/.context-index",
    "/.project-state",
  ]) {
    assert.equal(gitlessPreDescentExcludePatterns.includes(pattern), true, pattern);
  }

  const sessionsDirectory = path.join(root, "sessions");
  chmodSync(sessionsDirectory, 0o000);
  let files;
  try {
    files = listRepositoryFiles({ root });
  } finally {
    chmodSync(sessionsDirectory, 0o700);
  }
  assert.deepEqual(files, [".codex/config.toml", "README.md"]);
  assert.deepEqual(listActiveFiles({ root }), [".codex/config.toml", "README.md"]);
});

test("active, portable, and copy boundaries refuse hardlinked or replaced source identities", () => {
  const root = temporaryRoot("source-hardlink-boundary-");
  const target = temporaryRoot("source-hardlink-target-");
  write(root, ".gitignore", "/sessions\n");
  write(root, "README.md", "portable source\n");
  write(root, "sessions/private-thread.jsonl", "private runtime without token syntax\n");
  mkdirSync(path.join(root, "src"));
  linkSync(
    path.join(root, "sessions", "private-thread.jsonl"),
    path.join(root, "src", "alias.jsonl"),
  );
  initializeGit(root);
  assert.equal(git(root, ["add", ".gitignore", "README.md", "src/alias.jsonl"]).status, 0);

  assert.equal(listRepositoryFiles({ root }).includes("src/alias.jsonl"), true);
  assert.equal(listActiveFiles({ root }).includes("src/alias.jsonl"), false);
  assert.equal(projectFormatFiles(root).includes("src/alias.jsonl"), false);
  assert.throws(
    () => listPortableTransferFiles({ root }),
    /single-link regular file: src\/alias\.jsonl/,
  );
  assert.throws(
    () => stageProjectExport({ sourceRoot: root, targetRoot: path.join(target, "stage") }),
    /single-link regular file: src\/alias\.jsonl/,
  );

  rmSync(path.join(root, "src", "alias.jsonl"));
  write(root, "src/ordinary.txt", "first identity\n");
  const captured = captureStableRepositoryFileIdentity({
    repositoryRoot: root,
    relativePath: "src/ordinary.txt",
  });
  renameSync(path.join(root, "src", "ordinary.txt"), path.join(root, "src", "displaced.txt"));
  write(root, "src/ordinary.txt", "replacement identity\n");
  assert.throws(
    () =>
      copyStableRepositoryFile({
        repositoryRoot: root,
        relativePath: "src/ordinary.txt",
        targetRoot: target,
        expectedIdentity: captured.identity,
      }),
    /change since inventory capture/,
  );
  assert.equal(existsSync(path.join(target, "src", "ordinary.txt")), false);
});

test("tracked worktree ignore policy can replace a temporary local mask before commit", () => {
  const root = temporaryRoot("source-local-mask-lifecycle-");
  const canonical = readFileSync(path.join(repositoryRoot, ".gitignore"), "utf8");
  write(root, ".gitignore", canonical.replace("/auth.json\n", ""));
  write(root, "auth.json", "private auth\n");
  initializeGit(root);
  write(root, ".git/info/exclude", "/auth.json\n");

  assert.equal(git(root, ["check-ignore", "--quiet", "--", "auth.json"]).status, 0);
  assert.match(
    repositoryCodexHomeGitignoreBehaviorFindings({ root }).join("\n"),
    /runtime is not effectively ignored: auth\.json/,
  );

  write(root, ".gitignore", canonical);
  assert.deepEqual(repositoryCodexHomeGitignoreBehaviorFindings({ root }), []);
  rmSync(path.join(root, ".git", "info", "exclude"));
  assert.equal(git(root, ["check-ignore", "--quiet", "--", "auth.json"]).status, 0);
});

test("repository-root Codex runtime is ignored, excluded from source, and audited if tracked", async () => {
  const root = temporaryRoot("source-codex-home-");
  write(root, ".gitignore", readFileSync(path.join(repositoryRoot, ".gitignore"), "utf8"));
  write(root, "README.md", "# Active project source\n");
  write(root, "src/index.ts", "export const active = true;\n");
  write(root, ".codex/README.md", "# Portable Codex policy\n");
  write(root, ".codex/config.toml", "sandbox_mode = 'fixture'\n");
  write(root, ".codex/hooks.json", "{}\n");
  write(root, ".codex/agents/default.toml", 'name = "default"\n');
  for (const relativePath of repositoryCodexHomeRuntimeProbePaths) write(root, relativePath);
  initializeGit(root);
  const portableAdd = git(root, ["add", ".gitignore", "README.md", "src", ".codex"]);
  assert.equal(portableAdd.status, 0, portableAdd.stderr);

  assert.deepEqual(
    repositoryCodexHomeGitignoreFindings(readFileSync(path.join(root, ".gitignore"), "utf8")),
    [],
  );
  assert.deepEqual(repositoryCodexHomeGitignoreBehaviorFindings({ root }), []);
  for (const pattern of [
    ...repositoryCodexHomeGitignorePatterns,
    ...portableCodexGitignorePatterns,
  ]) {
    assert.equal(
      readFileSync(path.join(root, ".gitignore"), "utf8").split(/\r?\n/).includes(pattern),
      true,
      pattern,
    );
  }
  for (const relativePath of repositoryCodexHomeProtectedGitignoreProbePaths) {
    const ignored = git(root, ["check-ignore", "--no-index", "--quiet", "--", relativePath]);
    assert.equal(ignored.status, 0, `${relativePath}\n${ignored.stderr}`);
  }
  for (const relativePath of repositoryCodexHomeRuntimeProbePaths) {
    assert.equal(isRepositoryCodexHomePath(relativePath), true, relativePath);
  }
  for (const relativePath of portableCodexGitignoreProbePaths) {
    const ignored = git(root, ["check-ignore", "--no-index", "--quiet", "--", relativePath]);
    assert.equal(ignored.status, 1, relativePath);
  }
  const activeBeforeForce = listActiveFiles({ root });
  assert.equal(activeBeforeForce.includes("src/index.ts"), true);
  assert.equal(activeBeforeForce.includes(".codex/config.toml"), true);
  assert.equal(
    activeBeforeForce.some((relativePath) => isRepositoryCodexHomePath(relativePath)),
    false,
  );
  assert.equal(
    listRepositoryFiles({ root }).some((relativePath) => isRepositoryCodexHomePath(relativePath)),
    false,
  );

  const forced = git(root, ["add", "-f", ...repositoryCodexHomeRuntimeProbePaths]);
  assert.equal(forced.status, 0, forced.stderr);
  const baseFiles = listRepositoryFiles({ root });
  for (const relativePath of repositoryCodexHomeRuntimeProbePaths)
    assert.equal(baseFiles.includes(relativePath), true, relativePath);
  assert.equal(
    listActiveFiles({ root }).some((relativePath) => isRepositoryCodexHomePath(relativePath)),
    false,
  );
  assert.throws(
    () => listPortableTransferFiles({ root }),
    /repository-root Codex runtime or cache state/,
  );
  assert.equal(
    (await scanRepositorySecrets({ root, files: baseFiles })).some((finding) =>
      finding.startsWith("auth.json:"),
    ),
    true,
  );
});

test("active and portable inventories classify tracked root runtime before filesystem access", () => {
  const root = temporaryRoot("source-runtime-prefilter-");
  const outside = temporaryRoot("source-runtime-prefilter-outside-");
  write(root, "README.md", "# Active source\n");
  write(root, "sessions/thread.jsonl", "tracked runtime\n");
  initializeGit(root);
  assert.equal(git(root, ["add", "README.md"]).status, 0);
  assert.equal(git(root, ["add", "-f", "sessions/thread.jsonl"]).status, 0);
  rmSync(path.join(root, "sessions"), { recursive: true });
  write(outside, "thread.jsonl", "outside runtime\n");
  symlinkSync(outside, path.join(root, "sessions"), "dir");

  assert.deepEqual(listActiveFiles({ root }), ["README.md"]);
  assert.throws(
    () => listPortableTransferFiles({ root }),
    /repository-root Codex runtime or cache state/,
  );
  assert.equal(readFileSync(path.join(outside, "thread.jsonl"), "utf8"), "outside runtime\n");
});

test("effective ignore validation rejects later runtime and portable overrides", () => {
  const root = temporaryRoot("source-codex-ignore-override-");
  const canonical = readFileSync(path.join(repositoryRoot, ".gitignore"), "utf8");
  write(root, ".gitignore", `${canonical}\n!/auth.json\n/.codex/config.toml\n`);
  write(root, ".codex/config.toml", "portable fixture\n");

  assert.deepEqual(repositoryCodexHomeGitignoreFindings(canonical), []);
  assert.deepEqual(
    repositoryCodexHomeGitignoreFindings(readFileSync(path.join(root, ".gitignore"), "utf8")),
    [],
  );
  assert.match(
    repositoryCodexHomeGitignoreBehaviorFindings({ root }).join("\n"),
    /runtime is not effectively ignored: auth\.json.*portable Codex config is effectively ignored: \.codex\/config\.toml/s,
  );
});

test("root runtime directory rules also ignore same-name symlinks", () => {
  const root = temporaryRoot("source-codex-runtime-symlink-");
  const outside = temporaryRoot("source-codex-runtime-symlink-target-");
  write(root, ".gitignore", readFileSync(path.join(repositoryRoot, ".gitignore"), "utf8"));
  for (const name of repositoryCodexHomeRuntimeDirectoryNames) {
    symlinkSync(outside, path.join(root, name), "dir");
  }
  initializeGit(root);
  for (const name of repositoryCodexHomeRuntimeDirectoryNames) {
    const ignored = git(root, ["check-ignore", "--no-index", "--quiet", "--", name]);
    assert.equal(ignored.status, 0, name);
  }
  const added = git(root, ["add", "-A"]);
  assert.equal(added.status, 0, added.stderr);
  const staged = git(root, ["diff", "--cached", "--name-only"]);
  assert.equal(staged.status, 0, staged.stderr);
  assert.equal(staged.stdout.trim(), ".gitignore");
});

test("Codex runtime names are reserved only at root and remain valid inside product source", () => {
  const root = temporaryRoot("source-profile-inventory-");
  write(root, ".gitignore", readFileSync(path.join(repositoryRoot, ".gitignore"), "utf8"));
  write(root, "README.md", "portable\n");
  for (const name of ["cache", "plugins", "sessions", "skills"]) {
    write(root, `src/${name}/index.ts`, `export const ${name}ProductPath = true;\n`);
  }
  initializeGit(root);
  const added = git(root, ["add", "."]);
  assert.equal(added.status, 0, added.stderr);
  const active = listActiveFiles({ root });
  const portable = listPortableTransferFiles({ root });
  for (const name of ["cache", "plugins", "sessions", "skills"]) {
    const relativePath = `src/${name}/index.ts`;
    assert.equal(isRepositoryCodexHomePath(relativePath), false, relativePath);
    assert.equal(active.includes(relativePath), true, relativePath);
    assert.equal(portable.includes(relativePath), true, relativePath);
  }
});

test("Git inventory errors fail closed instead of exposing ignored files", () => {
  const root = temporaryRoot("source-corrupt-git-");
  write(root, ".gitignore", "private-notes.md\n");
  write(root, "README.md", "public\n");
  write(root, "private-notes.md", "private\n");
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  assert.equal(git(["init", "-q"]).status, 0);
  write(root, ".git/index", "not a git index");

  assert.throws(() => listActiveFiles({ root }), /Git source inventory failed/);
});

test("transfer policy rejects credential stores and private-key paths", () => {
  for (const relativePath of [".npmrc", "certs/private-key.pem"]) {
    const root = temporaryRoot("transfer-policy-");
    write(root, "README.md");
    write(root, relativePath, "synthetic fixture");
    assert.throws(
      () => assertSafeTransferSource({ root }),
      new RegExp(relativePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
});

test("transfer policy permits code ownership names and public certificate material", () => {
  const root = temporaryRoot("transfer-source-names-");
  write(root, "src/private/route.ts", "export const visibility = 'private';\n");
  write(root, "src/secrets/provider.ts", "export const source = 'runtime';\n");
  write(root, "certs/public.pem", "synthetic public certificate fixture\n");
  assert.doesNotThrow(() => assertSafeTransferSource({ root }));
});

test("export staging copies only the canonical portable inventory", () => {
  const source = temporaryRoot("export-source-");
  const stagingParent = temporaryRoot("export-target-");
  write(source, "README.md", "portable\n");
  write(source, "src/index.ts", "export const active = true;\n");
  write(source, "scripts/run.sh", "#!/usr/bin/env bash\nexit 0\n");
  write(source, ".gitignore", readFileSync(path.join(repositoryRoot, ".gitignore"), "utf8"));
  for (const relativePath of [
    "auth.json",
    "sessions/thread.jsonl",
    "plugins/runtime/plugin.json",
    "skills/runtime/SKILL.md",
    "state_1.sqlite",
  ]) {
    write(source, relativePath, "ignored Codex runtime fixture\n");
  }
  write(source, "apps/site/node_modules/pkg/private.txt", "ignored\n");
  write(source, "apps/site/.git/config", "ignored\n");
  write(source, ".codex/runtime/session.json", "ignored\n");
  initializeGit(source);
  const added = git(source, ["add", "."]);
  assert.equal(added.status, 0, added.stderr);

  const target = path.join(stagingParent, "stage");
  stageProjectExport({ sourceRoot: source, targetRoot: target });
  assert.equal(readFileSync(path.join(target, "README.md"), "utf8"), "portable\n");
  assert.equal(lstatSync(path.join(target, "README.md")).mode & 0o777, 0o644);
  assert.equal(lstatSync(path.join(target, "scripts/run.sh")).mode & 0o777, 0o755);
  assert.deepEqual(listActiveFiles({ root: target }), [
    ".gitignore",
    "README.md",
    "scripts/run.sh",
    "src/index.ts",
  ]);
  for (const relativePath of [
    "auth.json",
    "sessions/thread.jsonl",
    "plugins/runtime/plugin.json",
    "skills/runtime/SKILL.md",
    "state_1.sqlite",
  ]) {
    assert.equal(existsSync(path.join(target, ...relativePath.split("/"))), false, relativePath);
  }
});

test("export staging copies legitimate tracked vendor, dist, and build content", () => {
  const source = temporaryRoot("export-tracked-source-");
  const stagingParent = temporaryRoot("export-tracked-target-");
  write(source, ".gitignore", "vendor/\ndist/\nbuild/\n");
  write(source, "vendor/pkg/index.js", "vendored\n");
  write(source, "dist/site/index.html", "built\n");
  write(source, "build/schema.json", "{}\n");
  write(source, "untracked-draft.txt", "local draft\n");
  initializeGit(source);
  const forced = git(source, ["add", "-f", ".gitignore", "vendor", "dist", "build"]);
  assert.equal(forced.status, 0, forced.stderr);

  const target = path.join(stagingParent, "stage");
  stageProjectExport({ sourceRoot: source, targetRoot: target });
  for (const relativePath of ["vendor/pkg/index.js", "dist/site/index.html", "build/schema.json"]) {
    assert.equal(readFileSync(path.join(target, relativePath), "utf8").length > 0, true);
  }
  assert.equal(readFileSync(path.join(target, "src", ".gitkeep"), "utf8"), "");
  assert.equal(existsSync(path.join(target, "untracked-draft.txt")), false);
});

test("portable transfer fails closed for tracked runtime and dependency state", () => {
  const source = temporaryRoot("export-nonportable-source-");
  write(source, ".gitignore", ".codex/runtime/\n.project-state/\nnode_modules/\n");
  write(source, ".codex/runtime/session.json", "local session\n");
  write(source, ".project-state/dependency-update/plan.json", "{}\n");
  write(source, "node_modules/pkg/index.js", "installed dependency\n");
  initializeGit(source);
  const forced = git(source, [
    "add",
    "-f",
    ".gitignore",
    ".codex/runtime",
    ".project-state",
    "node_modules",
  ]);
  assert.equal(forced.status, 0, forced.stderr);

  assert.throws(
    () => listPortableTransferFiles({ root: source }),
    /\.codex\/runtime\/session\.json.*\.project-state\/dependency-update\/plan\.json.*node_modules\/pkg\/index\.js/s,
  );
});

test("Git-less staging rejects repository-root Codex runtime and retains portable .codex files", async () => {
  const cleanStage = temporaryRoot("export-codex-runtime-clean-stage-");
  writePortableCodexFiles(cleanStage);
  const cleanFiles = listStagedTransferFiles({ root: cleanStage });
  for (const relativePath of [
    ".codex/README.md",
    ".codex/config.toml",
    ".codex/hooks.json",
    ".codex/agents/default.toml",
  ]) {
    assert.equal(cleanFiles.includes(relativePath), true, relativePath);
  }

  const unsafeStage = temporaryRoot("export-codex-runtime-unsafe-stage-");
  writePortableCodexFiles(unsafeStage);
  write(unsafeStage, "sessions/private-thread.jsonl", "private runtime fixture\n");
  assert.throws(
    () => listStagedTransferFiles({ root: unsafeStage }),
    /sessions.*repository-root Codex runtime or cache state/s,
  );
  await assert.rejects(
    () => validateStagedProject(unsafeStage),
    /sessions.*repository-root Codex runtime or cache state/s,
  );
});

test("stage validation requires the exact portable Stop hook", async () => {
  const stage = temporaryRoot("export-hook-validation-");
  writePortableCodexFiles(stage);
  write(
    stage,
    ".codex/hooks.json",
    readFileSync(path.join(repositoryRoot, ".codex", "hooks.json"), "utf8").replace(
      '"Stop"',
      '"PostToolUse"',
    ),
  );

  await assert.rejects(
    () => validateStagedProject(stage),
    /hook events must contain exactly these keys: Stop/,
  );
});

test("stage validation requires the portable primary retrieval contract", async () => {
  const missingSkill = temporaryRoot("export-context-contract-missing-");
  writePortableCodexFiles(missingSkill);
  rmSync(path.join(missingSkill, ".agents", "skills", "context-retrieval", "SKILL.md"));
  await assert.rejects(
    () => validateStagedProject(missingSkill),
    /portable context contract is missing \.agents\/skills\/context-retrieval\/SKILL\.md/,
  );

  const weakenedPrimary = temporaryRoot("export-context-contract-primary-");
  writePortableCodexFiles(weakenedPrimary);
  write(
    weakenedPrimary,
    "instructions.md",
    readFileSync(path.join(repositoryRoot, "instructions.md"), "utf8").replaceAll(
      "no reliable exact",
      "after exhaustive exact search",
    ),
  );
  await assert.rejects(
    () => validateStagedProject(weakenedPrimary),
    /instructions\.md to include no reliable exact/,
  );

  const weakenedRole = temporaryRoot("export-context-contract-role-");
  writePortableCodexFiles(weakenedRole);
  write(
    weakenedRole,
    ".codex/agents/explorer.toml",
    readFileSync(path.join(repositoryRoot, ".codex/agents/explorer.toml"), "utf8").replace(
      "context:search",
      "broad file scan",
    ),
  );
  await assert.rejects(
    () => validateStagedProject(weakenedRole),
    /retrieval contract marker context:search/,
  );

  const missingCommand = temporaryRoot("export-context-contract-command-");
  writePortableCodexFiles(missingCommand);
  const packageJson = JSON.parse(readFileSync(path.join(missingCommand, "package.json"), "utf8"));
  delete packageJson.scripts["context:search"];
  write(missingCommand, "package.json", `${JSON.stringify(packageJson, null, 2)}\n`);
  await assert.rejects(
    () => validateStagedProject(missingCommand),
    /package\.json script context:search/,
  );

  const missingWorker = temporaryRoot("export-context-contract-missing-worker-");
  writePortableCodexFiles(missingWorker);
  rmSync(path.join(missingWorker, "scripts/context/context-worker-output.mjs"));
  await assert.rejects(
    () => validateStagedProject(missingWorker),
    /portable context contract is missing scripts\/context\/context-worker-output\.mjs/,
  );

  const weakenedWorker = temporaryRoot("export-context-contract-weakened-worker-");
  writePortableCodexFiles(weakenedWorker);
  write(
    weakenedWorker,
    "scripts/context/context-worker-output.mjs",
    readFileSync(
      path.join(repositoryRoot, "scripts/context/context-worker-output.mjs"),
      "utf8",
    ).replace("sanitizeMultilineForTerminal(output, repositoryRoot)", "String(output)"),
  );
  await assert.rejects(
    () => validateStagedProject(weakenedWorker),
    /scripts\/context\/context-worker-output\.mjs to include sanitizeMultilineForTerminal/,
  );
});

test("stage validation rejects agent state inside a product root", async () => {
  const stage = temporaryRoot("product-boundary-stage-validation-");
  writePortableCodexFiles(stage);
  write(stage, "src/feature/.agents/skills/example/SKILL.md", "agent pollution\n");

  await assert.rejects(
    () => validateStagedProject(stage),
    /src\/feature\/\.agents: agent-only path is forbidden inside product unit src/,
  );
});

test("stage validation sees a copied tracked .env even though the stage has no Git metadata", async () => {
  const source = temporaryRoot("export-secret-source-");
  const stagingParent = temporaryRoot("export-secret-target-");
  write(source, ".gitignore", ".env\n");
  writePortableCodexFiles(source);
  write(source, ".env", `OPENAI_API_KEY=${["sk-", "c".repeat(24)].join("")}\n`);
  initializeGit(source);
  const added = git(source, ["add", "-f", "."]);
  assert.equal(added.status, 0, added.stderr);

  const target = path.join(stagingParent, "stage");
  stageProjectExport({ sourceRoot: source, targetRoot: target });
  for (const relativePath of [
    ".codex/hooks.json",
    "scripts/context/context-worker-output.mjs",
    "scripts/context/refresh-context-index-on-stop.mjs",
    "scripts/context/refresh-context-index-on-stop.sh",
  ]) {
    assert.equal(
      readFileSync(path.join(target, relativePath), "utf8"),
      readFileSync(path.join(source, relativePath), "utf8"),
      relativePath,
    );
  }
  assert.equal(
    lstatSync(path.join(target, "scripts/context/refresh-context-index-on-stop.sh")).mode & 0o777,
    0o755,
  );
  await assert.rejects(() => validateStagedProject(target), /\.env.*environment credential file/s);
});

test("tracked paths cannot escape through a replaced parent symlink", () => {
  const root = temporaryRoot("source-symlink-");
  const outside = temporaryRoot("source-outside-");
  write(root, "packages/lib/index.ts", "inside\n");
  const git = (args) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8", input: "", stdio: "pipe" });
  assert.equal(git(["init", "-q"]).status, 0);
  assert.equal(git(["add", "packages/lib/index.ts"]).status, 0);
  rmSync(path.join(root, "packages"), { recursive: true });
  write(outside, "lib/index.ts", "outside\n");
  symlinkSync(outside, path.join(root, "packages"), "dir");

  assert.throws(() => listActiveFiles({ root }), /symlinked parent/i);
});
