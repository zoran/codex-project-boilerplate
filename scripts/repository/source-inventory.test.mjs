import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  listActiveFiles,
  listPortableTransferFiles,
  listRepositoryFiles,
  repositoryRoot,
} from "./source-inventory.mjs";
import { assertSafeTransferSource } from "./validate-transfer-source.mjs";
import { stageProjectExport } from "../setup/stage-project-export.mjs";
import { validateStagedProject } from "../setup/validate-staged-project.mjs";

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
  for (const name of ["default", "explorer", "worker"]) {
    write(
      targetRoot,
      `.codex/agents/${name}.toml`,
      readFileSync(path.join(repositoryRoot, ".codex", "agents", `${name}.toml`), "utf8"),
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

after(() => {
  for (const root of temporaryRoots) rmSync(root, { force: true, recursive: true });
});

test("active inventory excludes generated and runtime directories at every depth", () => {
  const root = temporaryRoot("source-inventory-");
  write(root, "README.md");
  write(root, ".codex/config.toml");
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
    ".gitignore",
    "README.md",
    "apps/site/src/index.ts",
  ]);
});

test("base and portable inventories retain tracked environment, vendor, dist, and build files", () => {
  const root = temporaryRoot("source-profile-inventory-");
  write(root, ".gitignore", ".env\nvendor/\ndist/\nbuild/\n");
  write(root, "README.md", "portable\n");
  write(root, ".env", "synthetic fixture\n");
  write(root, "vendor/pkg/index.js", "vendored\n");
  write(root, "dist/site/index.html", "built site\n");
  write(root, "build/schema/output.json", "{}\n");
  initializeGit(root);
  assert.equal(git(root, ["add", ".gitignore", "README.md"]).status, 0);
  const forced = git(root, [
    "add",
    "-f",
    ".env",
    "vendor/pkg/index.js",
    "dist/site/index.html",
    "build/schema/output.json",
  ]);
  assert.equal(forced.status, 0, forced.stderr);

  assert.deepEqual(listRepositoryFiles({ root }), [
    ".env",
    ".gitignore",
    "README.md",
    "build/schema/output.json",
    "dist/site/index.html",
    "vendor/pkg/index.js",
  ]);
  assert.deepEqual(listActiveFiles({ root }), [".gitignore", "README.md"]);
  assert.deepEqual(listPortableTransferFiles({ root }), [
    ".env",
    ".gitignore",
    "README.md",
    "build/schema/output.json",
    "dist/site/index.html",
    "vendor/pkg/index.js",
  ]);
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
  write(source, ".gitignore", "node_modules/\n.git/\n.codex/runtime/\n.context-index/\n");
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

test("the copied stage is the authoritative secret-scan boundary", async () => {
  const stage = temporaryRoot("export-stage-validation-");
  writePortableCodexFiles(stage);
  write(stage, "README.md", `staged ${["sk-", "a".repeat(24)].join("")}\n`);

  await assert.rejects(() => validateStagedProject(stage), /potential secret material/i);
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
  const added = git(source, ["add", "-f", ".gitignore", ".codex", ".env"]);
  assert.equal(added.status, 0, added.stderr);

  const target = path.join(stagingParent, "stage");
  stageProjectExport({ sourceRoot: source, targetRoot: target });
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
