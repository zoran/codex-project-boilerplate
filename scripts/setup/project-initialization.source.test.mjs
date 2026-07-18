import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { stageProjectExport } from "./stage-project-export.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const temporaryRoots = [];

function temporaryRoot(prefix) {
  const value = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(value);
  return value;
}

function readdirNames(directory) {
  return readdirSync(directory).sort();
}

function textFiles(directory) {
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

function initializeTrackedSource(sourceRoot) {
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

function gitState(sourceRoot) {
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

function assertFormatting(targetRoot) {
  const formatterPath = path.join(root, "node_modules", "prettier", "bin", "prettier.cjs");
  const result = spawnSync(process.execPath, [formatterPath, "--check", "."], {
    cwd: targetRoot,
    encoding: "utf8",
    input: "",
    stdio: "pipe",
  });
  assert.equal(result.status, 0, result.stderr);
}

after(() => {
  for (const temporaryRootPath of temporaryRoots) {
    rmSync(temporaryRootPath, { force: true, recursive: true });
  }
});

test("clean project initialization removes inherited state and source-specific text", () => {
  const outputParent = temporaryRoot("codex-project-create-");
  const sourceStateBefore = gitState(root);
  const script = path.join(
    root,
    ".agents/skills/create-project-from-boilerplate/scripts/create-project-from-boilerplate.mjs",
  );
  const result = spawnSync(
    process.execPath,
    [
      script,
      "--name",
      "Generated Isolation Fixture",
      "--directory",
      "generated-isolation-fixture",
      "--source",
      root,
      "--output-parent",
      outputParent,
      "--include-untracked",
    ],
    { cwd: root, encoding: "utf8", input: "", stdio: "pipe", timeout: 30_000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(gitState(root), sourceStateBefore);
  assert.match(result.stdout, /Source boilerplate state remained unchanged and baseline-clean\./);

  const generated = path.join(outputParent, "generated-isolation-fixture", "code");
  const generatedAgents = readFileSync(path.join(generated, "AGENTS.md"), "utf8");
  const generatedReadme = readFileSync(path.join(generated, "README.md"), "utf8");
  const generatedInstructions = readFileSync(path.join(generated, "instructions.md"), "utf8");
  const generatedManifest = readFileSync(path.join(generated, "docs", "project.md"), "utf8");
  for (const forbidden of [
    ".git",
    ".github",
    ".context-index",
    ".codex/runtime",
    ".project-state",
    "node_modules",
    ".agents/skills/create-project-from-boilerplate",
    "scripts/setup/project-initialization.source.test.mjs",
  ]) {
    assert.equal(existsSync(path.join(generated, forbidden)), false, forbidden);
  }
  assert.deepEqual(readdirNames(path.join(generated, ".codex")), [
    "README.md",
    "agents",
    "config.toml",
  ]);
  assert.deepEqual(readdirNames(path.join(generated, ".codex", "agents")), [
    "default.toml",
    "explorer.toml",
    "worker.toml",
  ]);
  assert.deepEqual(readdirNames(path.join(generated, "src")), [".gitkeep"]);
  assert.equal(readFileSync(path.join(generated, "src", ".gitkeep"), "utf8"), "");
  const packageJson = JSON.parse(readFileSync(path.join(generated, "package.json"), "utf8"));
  assert.equal(packageJson.name, "generated-isolation-fixture");
  assert.equal(packageJson.scripts["codex:start"], "bash scripts/setup/start-codex.sh");
  assert.match(packageJson.scripts.setup, /node scripts\/context\/index-codebase\.mjs --setup$/);
  for (const removedCommand of [
    "boilerplate:reset",
    "docs:sync",
    "goal:close",
    "goal:new",
    "planning:reset",
    "slice:close",
    "slice:new",
  ]) {
    assert.equal(packageJson.scripts[removedCommand], undefined, removedCommand);
  }
  assert.equal(
    readFileSync(path.join(generated, "mise.toml"), "utf8"),
    '[tools]\nnode = "24.18.0"\npnpm = "11.12.0"\n',
  );
  assert.equal(
    readFileSync(path.join(generated, "mise.lock"), "utf8"),
    readFileSync(path.join(root, "mise.lock"), "utf8"),
  );
  assert.match(generatedReadme, /env -u NO_COLOR codex --cd "\$PWD"/);
  assert.match(
    generatedReadme,
    /mise install --locked\nmise exec --locked -- pnpm install --frozen-lockfile --ignore-scripts/,
  );
  assert.match(generatedReadme, /Root `src\/` is the default Product Root/);
  assert.match(
    generatedReadme,
    /creates and validates the local vector space at `\.context-index\/`/,
  );
  assert.match(generatedAgents, /`instructions\.md` owns the complete agent workflow/);
  assert.match(generatedAgents, /Current files and command output outrank remembered context/);
  assert.match(generatedReadme, /## Project Authority/);
  assert.match(generatedInstructions, /single committed workflow authority/);
  assert.match(generatedInstructions, /Documentation has no numeric line or word quota/);
  assert.match(generatedInstructions, /at or below 700 physical lines/);
  assert.match(generatedManifest, /Agent workflow authority: `instructions\.md`/);
  assert.equal(
    [generatedAgents, generatedReadme, generatedInstructions, generatedManifest].filter((content) =>
      content.includes("## Compact Project Memory"),
    ).length,
    1,
  );
  assert.equal(existsSync(path.join(generated, "docs", "planning")), false);
  const projectMarkdown = textFiles(generated)
    .map((filePath) => path.relative(generated, filePath).split(path.sep).join("/"))
    .filter(
      (relativePath) =>
        relativePath.endsWith(".md") &&
        !relativePath.startsWith(".agents/") &&
        !relativePath.startsWith(".codex/"),
    )
    .sort();
  assert.deepEqual(projectMarkdown, [
    "AGENTS.md",
    "README.md",
    "docs/project.md",
    "instructions.md",
  ]);
  const originFiles = textFiles(generated).filter((filePath) =>
    /\bboilerplate\b/i.test(readFileSync(filePath, "utf8")),
  );
  assert.deepEqual(originFiles, []);
});

test("clean project initialization escapes and formats long project names", () => {
  const outputParent = temporaryRoot("long-project-name-");
  const projectName =
    "A [linked project label with many words](https://example.invalid/path) that remains neutral";
  const script = path.join(
    root,
    ".agents/skills/create-project-from-boilerplate/scripts/create-project-from-boilerplate.mjs",
  );
  const result = spawnSync(
    process.execPath,
    [
      script,
      "--name",
      projectName,
      "--directory",
      "long-project-name-fixture",
      "--source",
      root,
      "--output-parent",
      outputParent,
      "--include-untracked",
    ],
    { cwd: root, encoding: "utf8", input: "", stdio: "pipe", timeout: 30_000 },
  );
  assert.equal(result.status, 0, result.stderr);
  const generated = path.join(outputParent, "long-project-name-fixture", "code");
  assert.match(readFileSync(path.join(generated, "README.md"), "utf8"), /^# A \\\[linked/m);
  assertFormatting(generated);
});

test("clean project initialization excludes untracked source drafts by default", () => {
  const sourceParent = temporaryRoot("tracked-project-source-");
  const source = path.join(sourceParent, "source");
  stageProjectExport({ sourceRoot: root, targetRoot: source });
  for (const runtimeContract of [
    "mise.lock",
    "mise.toml",
    "scripts/repository/product-roots.mjs",
    "scripts/repository/product-roots.test.mjs",
    "scripts/web/update-sitemap-lastmod.test.mjs",
  ]) {
    if (!existsSync(path.join(source, runtimeContract))) {
      mkdirSync(path.dirname(path.join(source, runtimeContract)), { recursive: true });
      copyFileSync(path.join(root, runtimeContract), path.join(source, runtimeContract));
    }
  }
  writeFileSync(path.join(source, "docs", "tracked-guide.mdx"), "# Tracked guide\n", "utf8");
  initializeTrackedSource(source);
  const untrackedRuntimeContract = spawnSync(
    "git",
    ["rm", "--cached", "--quiet", "mise.lock", "mise.toml"],
    { cwd: source, encoding: "utf8", input: "", stdio: "pipe" },
  );
  assert.equal(untrackedRuntimeContract.status, 0, untrackedRuntimeContract.stderr);
  const draftPath = path.join(source, "drafts", "untracked.txt");
  mkdirSync(path.dirname(draftPath), { recursive: true });
  writeFileSync(draftPath, "do not transfer this working-tree draft\n", "utf8");

  const outputParent = temporaryRoot("tracked-project-output-");
  const script = path.join(
    root,
    ".agents/skills/create-project-from-boilerplate/scripts/create-project-from-boilerplate.mjs",
  );
  const result = spawnSync(
    process.execPath,
    [
      script,
      "--name",
      "Tracked Snapshot Fixture",
      "--directory",
      "tracked-snapshot-fixture",
      "--source",
      source,
      "--output-parent",
      outputParent,
    ],
    { cwd: root, encoding: "utf8", input: "", stdio: "pipe", timeout: 30_000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    existsSync(
      path.join(outputParent, "tracked-snapshot-fixture", "code", "drafts", "untracked.txt"),
    ),
    false,
  );
  assert.equal(
    existsSync(
      path.join(outputParent, "tracked-snapshot-fixture", "code", "docs", "tracked-guide.mdx"),
    ),
    false,
  );
  assert.equal(
    existsSync(path.join(outputParent, "tracked-snapshot-fixture", "code", "mise.toml")),
    true,
  );
  assert.equal(
    existsSync(path.join(outputParent, "tracked-snapshot-fixture", "code", "mise.lock")),
    true,
  );
});

test("clean project initialization preserves a safe project folder and ends at code", () => {
  const outputParent = temporaryRoot("named-project-output-");
  const script = path.join(
    root,
    ".agents/skills/create-project-from-boilerplate/scripts/create-project-from-boilerplate.mjs",
  );
  const result = spawnSync(
    process.execPath,
    [
      script,
      "--name",
      "NamedProjectFixture",
      "--source",
      root,
      "--output-parent",
      outputParent,
      "--include-untracked",
    ],
    { cwd: root, encoding: "utf8", input: "", stdio: "pipe", timeout: 30_000 },
  );
  assert.equal(result.status, 0, result.stderr);

  const projectRoot = path.join(outputParent, "NamedProjectFixture");
  const generated = path.join(projectRoot, "code");
  assert.deepEqual(readdirNames(projectRoot), ["code"]);
  assert.equal(existsSync(path.join(generated, "package.json")), true);
  assert.equal(
    JSON.parse(readFileSync(path.join(generated, "package.json"), "utf8")).name,
    "namedprojectfixture",
  );
  assert.ok(result.stdout.includes(`Created project: ${generated}`));

  const duplicate = spawnSync(
    process.execPath,
    [
      script,
      "--name",
      "NamedProjectFixture",
      "--source",
      root,
      "--output-parent",
      outputParent,
      "--include-untracked",
    ],
    { cwd: root, encoding: "utf8", input: "", stdio: "pipe", timeout: 30_000 },
  );
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /Target project directory already exists:/);
});

test("clean project initialization refuses a polluted source baseline", () => {
  const sourceParent = temporaryRoot("polluted-project-source-");
  const source = path.join(sourceParent, "source");
  stageProjectExport({ sourceRoot: root, targetRoot: source });
  for (const runtimeContract of ["mise.lock", "mise.toml"]) {
    if (!existsSync(path.join(source, runtimeContract))) {
      copyFileSync(path.join(root, runtimeContract), path.join(source, runtimeContract));
    }
  }
  initializeTrackedSource(source);
  writeFileSync(path.join(source, "docs", "project-context.md"), "# Temporary context\n", "utf8");

  const outputParent = temporaryRoot("polluted-project-output-");
  const script = path.join(
    root,
    ".agents/skills/create-project-from-boilerplate/scripts/create-project-from-boilerplate.mjs",
  );
  const result = spawnSync(
    process.execPath,
    [
      script,
      "--name",
      "PollutedSourceFixture",
      "--source",
      source,
      "--output-parent",
      outputParent,
    ],
    { cwd: root, encoding: "utf8", input: "", stdio: "pipe", timeout: 30_000 },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Source boilerplate baseline is not clean/);
  assert.match(result.stderr, /docs\/project-context\.md/);
  assert.equal(existsSync(path.join(outputParent, "PollutedSourceFixture")), false);
});

test("clean project initialization refuses agent artifacts inside a product root", () => {
  const sourceParent = temporaryRoot("polluted-product-boundary-source-");
  const source = path.join(sourceParent, "source");
  stageProjectExport({ sourceRoot: root, targetRoot: source });
  for (const runtimeContract of ["mise.lock", "mise.toml"]) {
    if (!existsSync(path.join(source, runtimeContract))) {
      copyFileSync(path.join(root, runtimeContract), path.join(source, runtimeContract));
    }
  }
  writeFileSync(path.join(source, "src", "AGENTS.md"), "agent pollution\n", "utf8");
  initializeTrackedSource(source);

  const outputParent = temporaryRoot("polluted-product-boundary-output-");
  const script = path.join(
    root,
    ".agents/skills/create-project-from-boilerplate/scripts/create-project-from-boilerplate.mjs",
  );
  const result = spawnSync(
    process.execPath,
    [
      script,
      "--name",
      "PollutedProductBoundaryFixture",
      "--source",
      source,
      "--output-parent",
      outputParent,
    ],
    { cwd: root, encoding: "utf8", input: "", stdio: "pipe", timeout: 30_000 },
  );
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /src\/AGENTS\.md: agent instruction path is forbidden inside product unit src/,
  );
  assert.equal(existsSync(path.join(outputParent, "PollutedProductBoundaryFixture")), false);
});
