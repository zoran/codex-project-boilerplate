import assert from "node:assert/strict";
import "./project-generator-state.test.mjs";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { supportedCodexStartCommand } from "../context/portable-context-contract.mjs";
import {
  repositoryCodexHomeGitignoreFindings,
  repositoryCodexHomeRuntimeProbePaths,
} from "../repository/source-inventory.mjs";
import { stageProjectExport } from "./stage-project-export.mjs";
import {
  assertGeneratedProjectQuality,
  cleanupTemporaryRoots,
  gitState,
  initializeTrackedSource,
  readdirNames,
  root,
  runProjectGenerator,
  temporaryRoot,
  textFiles,
} from "./project-initialization-test-helpers.mjs";

after(cleanupTemporaryRoots);

test("clean project initialization removes inherited state and source-specific text", () => {
  const outputParent = temporaryRoot("codex-project-create-");
  const sourceStateBefore = gitState(root);
  const result = runProjectGenerator([
    "--name",
    "Generated Isolation Fixture",
    "--directory",
    "generated-isolation-fixture",
    "--source",
    root,
    "--output-parent",
    outputParent,
    "--include-untracked",
  ]);
  assert.equal(result.status, 0, result.stderr);
  for (const localValue of [root, outputParent]) {
    assert.equal(`${result.stdout}${result.stderr}`.includes(localValue), false, localValue);
  }
  assert.deepEqual(gitState(root), sourceStateBefore);
  assert.match(result.stdout, /Source boilerplate state remained unchanged and baseline-clean\./);

  const generated = path.join(outputParent, "generated-isolation-fixture", "code");
  const generatedAgents = readFileSync(path.join(generated, "AGENTS.md"), "utf8");
  const generatedReadme = readFileSync(path.join(generated, "README.md"), "utf8");
  const generatedInstructions = readFileSync(path.join(generated, "instructions.md"), "utf8");
  const generatedManifest = readFileSync(path.join(generated, "docs", "project.md"), "utf8");
  const generatedContextIndex = readFileSync(
    path.join(generated, "docs", "context-index.md"),
    "utf8",
  );
  const generatedRetrievalSkill = path.join(generated, ".agents/skills/context-retrieval/SKILL.md");
  const generatedRetrievalMetadata = path.join(
    generated,
    ".agents/skills/context-retrieval/agents/openai.yaml",
  );
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
    "hooks.json",
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
  assert.equal(
    packageJson.scripts["context:check"],
    "node scripts/context/check-context-index.mjs",
  );
  assert.equal(packageJson.scripts["context:index"], "node scripts/context/index-codebase.mjs");
  assert.equal(packageJson.scripts["context:search"], "node scripts/context/search-context.mjs");
  assert.equal(
    packageJson.scripts["goal:new"],
    "node scripts/goals/goal-publication-precondition.mjs",
  );
  for (const removedCommand of [
    "boilerplate:reset",
    "docs:sync",
    "goal:close",
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
  for (const content of [
    generatedAgents,
    generatedReadme,
    generatedInstructions,
    generatedManifest,
  ]) {
    assert.equal(content.includes(supportedCodexStartCommand), true);
  }
  assert.match(generatedManifest, /hash-trusted project\s+Stop hook refreshes/);
  assert.match(generatedReadme, /isolates\s+mutable Codex state in this root/);
  assert.match(
    generatedReadme,
    /mise install --locked\nmise exec --locked -- pnpm install --frozen-lockfile --ignore-scripts/,
  );
  assert.match(generatedReadme, /Root `src\/` is the default Product Root/);
  assert.match(
    generatedReadme,
    /creates and validates the local vector space at `\.context-index\/`/,
  );
  assert.match(generatedReadme, /Stop hook refreshes changed indexed sources incrementally/);
  assert.match(generatedReadme, /trust a new or changed hook definition locally with\s+`\/hooks`/);
  assert.equal(
    readFileSync(path.join(generated, ".codex", "hooks.json"), "utf8"),
    readFileSync(path.join(root, ".codex", "hooks.json"), "utf8"),
  );
  assert.equal(
    existsSync(path.join(generated, "scripts/context/refresh-context-index-on-stop.sh")),
    true,
  );
  assert.equal(
    existsSync(path.join(generated, "scripts/context/refresh-context-index-on-stop.mjs")),
    true,
  );
  assert.equal(existsSync(path.join(generated, "scripts/setup/codex-launcher.test.mjs")), true);
  assert.equal(
    existsSync(path.join(generated, "scripts/setup/setup-regression-fixtures.mjs")),
    true,
  );
  assert.equal(
    existsSync(path.join(generated, "scripts/setup/project-initialization-test-helpers.mjs")),
    false,
  );
  const generatedContextWorker = readFileSync(
    path.join(generated, "scripts/context/context-worker-output.mjs"),
    "utf8",
  );
  assert.match(generatedContextWorker, /sanitizeMultilineForTerminal\(output, repositoryRoot\)/);
  assert.match(generatedContextWorker, /stdio: "pipe"/);
  assert.equal(existsSync(path.join(generated, "scripts/verify/format-project.mjs")), true);
  assert.equal(existsSync(path.join(generated, "scripts/context/terminal-output.test.mjs")), true);
  assert.equal(existsSync(path.join(generated, "scripts/context/context-maintenance.mjs")), true);
  assert.equal(
    existsSync(path.join(generated, "scripts/context/context-maintenance-safety.mjs")),
    true,
  );
  assert.equal(
    existsSync(path.join(generated, "scripts/context/context-maintenance.test.mjs")),
    true,
  );
  const generatedRuntimeSources = textFiles(path.join(generated, "scripts", "context")).filter(
    (filePath) => filePath.endsWith(".mjs") && !filePath.endsWith(".test.mjs"),
  );
  const optimizeMethodPattern = new RegExp(`\\.${["opt", "imize"].join("")}\\s*\\(`, "u");
  assert.equal(
    generatedRuntimeSources.some((filePath) =>
      optimizeMethodPattern.test(readFileSync(filePath, "utf8")),
    ),
    false,
  );
  const generatedStoragePath = path.join(generated, "scripts/context/context-storage.mjs");
  const generatedStorage = readFileSync(generatedStoragePath, "utf8");
  writeFileSync(
    generatedStoragePath,
    `${generatedStorage}\nasync function unsafe(table) { await table.optimize(); }\n`,
    "utf8",
  );
  const unsafeRuntimeVerification = spawnSync(
    process.execPath,
    [path.join(generated, "scripts/verify/repository-smoke.mjs")],
    { cwd: generated, encoding: "utf8", input: "", stdio: "pipe" },
  );
  assert.equal(unsafeRuntimeVerification.status, 1);
  assert.match(unsafeRuntimeVerification.stderr, /unsafe in-place maintenance/);
  writeFileSync(generatedStoragePath, generatedStorage, "utf8");
  assert.equal(existsSync(path.join(generated, "scripts/verify/image-assets.mjs")), true);
  assert.equal(existsSync(path.join(generated, "scripts/verify/image-assets.test.mjs")), true);
  assert.equal(
    existsSync(path.join(generated, "scripts/deps/dependency-owner-normalization.test.mjs")),
    true,
  );
  assert.equal(
    existsSync(path.join(generated, "scripts/goals/goal-publication-precondition.mjs")),
    true,
  );
  assert.match(generatedAgents, /`instructions\.md` owns the complete agent workflow/);
  assert.match(generatedAgents, /Current files and command output outrank remembered context/);
  for (const content of [generatedAgents, generatedInstructions]) {
    assert.match(content, /no reliable exact\s+anchor/);
    assert.match(content, /cross-file\s+relationships/);
    assert.match(content, /read\s+every matched source/);
    assert.match(content, /failed `rg` attempt is not\s+required/);
    assert.match(content, /whole-repository course check/i);
    assert.match(content, /every significant implementation milestone/);
    assert.match(content, /pnpm goal:new/);
    assert.match(content, /pre-descent mask/);
    assert.match(content, /pushes\s+the\s+current\s+branch/);
  }
  assert.match(
    generatedReadme,
    /semantic search is the normal early discovery route|Use.*early for broad/s,
  );
  for (const filePath of [generatedRetrievalSkill, generatedRetrievalMetadata]) {
    const stats = lstatSync(filePath);
    assert.equal(stats.isFile(), true);
    assert.equal(stats.isSymbolicLink(), false);
  }
  assert.equal(
    readFileSync(generatedRetrievalSkill, "utf8"),
    readFileSync(path.join(root, ".agents/skills/context-retrieval/SKILL.md"), "utf8"),
  );
  assert.equal(
    readFileSync(generatedRetrievalMetadata, "utf8"),
    readFileSync(path.join(root, ".agents/skills/context-retrieval/agents/openai.yaml"), "utf8"),
  );
  assert.match(readFileSync(generatedRetrievalMetadata, "utf8"), /allow_implicit_invocation: true/);
  for (const role of ["default", "explorer", "worker"]) {
    const roleContent = readFileSync(
      path.join(generated, ".codex", "agents", `${role}.toml`),
      "utf8",
    );
    assert.match(roleContent, /context:search/, role);
    assert.match(roleContent, /matched source/, role);
    assert.match(roleContent, /whole-repository course check/, role);
    assert.match(roleContent, /context recovery/, role);
    assert.match(roleContent, /every significant (?:implementation|discovery) milestone/, role);
    assert.match(roleContent, /do not commit or push/, role);
  }
  assert.match(generatedReadme, /## Project Authority/);
  assert.match(generatedInstructions, /single committed workflow authority/);
  assert.match(generatedInstructions, /Documentation has no numeric line or word quota/);
  assert.match(generatedInstructions, /at or below 700 physical lines/);
  assert.match(generatedManifest, /Agent workflow authority: `instructions\.md`/);
  assert.match(generatedManifest, /whole-repository course checks/i);
  assert.match(generatedManifest, /every significant implementation milestone/);
  assert.match(generatedManifest, /pnpm goal:new/);
  assert.match(generatedManifest, /pre-descent mask/);
  assert.match(generatedManifest, /pushes\s+the\s+current\s+branch/);
  assert.match(generatedContextIndex, /opportunistic maintenance/i);
  assert.match(generatedContextIndex, /strictly read-only/i);
  assert.match(generatedContextIndex, /source classifications/i);
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
    "docs/context-index.md",
    "docs/project.md",
    "instructions.md",
  ]);
  const originFiles = textFiles(generated).filter((filePath) =>
    /\bboilerplate\b/i.test(readFileSync(filePath, "utf8")),
  );
  assert.deepEqual(originFiles, []);

  const generatedGitignore = readFileSync(path.join(generated, ".gitignore"), "utf8");
  assert.equal(generatedGitignore, readFileSync(path.join(root, ".gitignore"), "utf8"));
  assert.deepEqual(repositoryCodexHomeGitignoreFindings(generatedGitignore), []);
  for (const relativePath of repositoryCodexHomeRuntimeProbePaths) {
    const target = path.join(generated, ...relativePath.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "generated-project Codex runtime fixture\n", "utf8");
  }
  const initialized = spawnSync("git", ["init", "-q"], {
    cwd: generated,
    encoding: "utf8",
    input: "",
    stdio: "pipe",
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  for (const relativePath of repositoryCodexHomeRuntimeProbePaths) {
    const ignored = spawnSync(
      "git",
      ["check-ignore", "--no-index", "--quiet", "--", relativePath],
      {
        cwd: generated,
        encoding: "utf8",
        input: "",
        stdio: "pipe",
      },
    );
    assert.equal(ignored.status, 0, relativePath);
  }
  const addedGenerated = spawnSync("git", ["add", "-A"], {
    cwd: generated,
    encoding: "utf8",
    input: "",
    stdio: "pipe",
  });
  assert.equal(addedGenerated.status, 0, addedGenerated.stderr);
  for (const relativePath of repositoryCodexHomeRuntimeProbePaths) {
    const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", relativePath], {
      cwd: generated,
      encoding: "utf8",
      input: "",
      stdio: "pipe",
    });
    assert.equal(tracked.status, 1, relativePath);
  }
  for (const relativePath of [
    ".codex/README.md",
    ".codex/config.toml",
    ".codex/hooks.json",
    ".codex/agents/default.toml",
  ]) {
    const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", relativePath], {
      cwd: generated,
      encoding: "utf8",
      input: "",
      stdio: "pipe",
    });
    assert.equal(tracked.status, 0, relativePath);
  }

  const generatedRemote = path.join(outputParent, "generated-goal-remote.git");
  assert.equal(
    spawnSync("git", ["init", "--bare", "-q", generatedRemote], {
      cwd: outputParent,
      encoding: "utf8",
      input: "",
      stdio: "pipe",
    }).status,
    0,
  );
  for (const [key, value] of [
    ["user.name", "Generated Goal Test"],
    ["user.email", "generated-goal@example.invalid"],
  ]) {
    const configured = spawnSync("git", ["config", key, value], {
      cwd: generated,
      encoding: "utf8",
      input: "",
      stdio: "pipe",
    });
    assert.equal(configured.status, 0, configured.stderr);
  }
  for (const args of [
    ["commit", "-q", "-m", "initial generated project"],
    ["remote", "add", "origin", generatedRemote],
    ["push", "-q", "-u", "origin", "HEAD"],
  ]) {
    const published = spawnSync("git", args, {
      cwd: generated,
      encoding: "utf8",
      input: "",
      stdio: "pipe",
    });
    assert.equal(published.status, 0, published.stderr);
  }
  const goalGate = path.join(generated, "scripts/goals/goal-publication-precondition.mjs");
  const ready = spawnSync(process.execPath, [goalGate], {
    cwd: outputParent,
    encoding: "utf8",
    input: "",
    stdio: "pipe",
  });
  assert.equal(ready.status, 0, ready.stderr);
  assert.match(ready.stdout, /publication precondition passed/i);
  assert.equal(`${ready.stdout}${ready.stderr}`.includes(generated), false);

  writeFileSync(path.join(generated, "src", ".gitkeep"), "unpublished completion\n", "utf8");
  for (const args of [
    ["add", "src/.gitkeep"],
    ["commit", "-q", "-m", "unpublished goal completion"],
  ]) {
    const committed = spawnSync("git", args, {
      cwd: generated,
      encoding: "utf8",
      input: "",
      stdio: "pipe",
    });
    assert.equal(committed.status, 0, committed.stderr);
  }
  const blocked = spawnSync(process.execPath, [goalGate], {
    cwd: generated,
    encoding: "utf8",
    input: "",
    stdio: "pipe",
  });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /ahead 1, behind 0/i);
  assert.equal(`${blocked.stdout}${blocked.stderr}`.includes(generated), false);
  const republished = spawnSync("git", ["push", "-q"], {
    cwd: generated,
    encoding: "utf8",
    input: "",
    stdio: "pipe",
  });
  assert.equal(republished.status, 0, republished.stderr);
  assert.equal(spawnSync(process.execPath, [goalGate], { cwd: generated }).status, 0);
});

test("clean project initialization escapes and formats long project names", () => {
  const outputParent = temporaryRoot("long-project-name-");
  const projectName =
    "A [linked project label with many words](https://example.invalid/path) that remains neutral";
  const result = runProjectGenerator([
    "--name",
    projectName,
    "--directory",
    "long-project-name-fixture",
    "--source",
    root,
    "--output-parent",
    outputParent,
    "--include-untracked",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const generated = path.join(outputParent, "long-project-name-fixture", "code");
  assert.match(readFileSync(path.join(generated, "README.md"), "utf8"), /^# A \\\[linked/m);
  assertGeneratedProjectQuality(generated);
});

test("clean project initialization excludes untracked source drafts by default", () => {
  const sourceParent = temporaryRoot("tracked-project-source-");
  const source = path.join(sourceParent, "source");
  stageProjectExport({ sourceRoot: root, targetRoot: source });
  for (const runtimeContract of [
    ".codex/hooks.json",
    "mise.lock",
    "mise.toml",
    "scripts/context/portable-context-contract.mjs",
    "scripts/context/context-maintenance-safety.mjs",
    "scripts/context/context-publication-policy.mjs",
    "scripts/context/refresh-context-index-on-stop.mjs",
    "scripts/context/refresh-context-index-on-stop.sh",
    "scripts/context/terminal-output.test.mjs",
    "scripts/deps/dependency-owner-normalization.test.mjs",
    "scripts/goals/goal-publication-precondition.mjs",
    "scripts/goals/goal-publication-precondition.test.mjs",
    "scripts/repository/product-roots.mjs",
    "scripts/repository/product-roots.test.mjs",
    "scripts/repository/stable-file-snapshot.test.mjs",
    "scripts/setup/codex-launcher.test.mjs",
    "scripts/setup/setup-regression-fixtures.mjs",
    "scripts/verify/format-project.mjs",
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
  const result = runProjectGenerator([
    "--name",
    "Tracked Snapshot Fixture",
    "--directory",
    "tracked-snapshot-fixture",
    "--source",
    source,
    "--output-parent",
    outputParent,
  ]);
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
  assert.equal(
    existsSync(
      path.join(
        outputParent,
        "tracked-snapshot-fixture",
        "code",
        "scripts/deps/dependency-owner-normalization.test.mjs",
      ),
    ),
    true,
  );
});

test("clean project initialization preserves a safe project folder and ends at code", () => {
  const outputParent = temporaryRoot("named-project-output-");
  const projectArgs = [
    "--name",
    "NamedProjectFixture",
    "--source",
    root,
    "--output-parent",
    outputParent,
    "--include-untracked",
  ];
  const result = runProjectGenerator(projectArgs);
  assert.equal(result.status, 0, result.stderr);

  const projectRoot = path.join(outputParent, "NamedProjectFixture");
  const generated = path.join(projectRoot, "code");
  assert.deepEqual(readdirNames(projectRoot), ["code"]);
  assert.equal(existsSync(path.join(generated, "package.json")), true);
  assert.equal(
    JSON.parse(readFileSync(path.join(generated, "package.json"), "utf8")).name,
    "namedprojectfixture",
  );
  assert.match(result.stdout, /Created the project successfully/);
  assert.equal(`${result.stdout}${result.stderr}`.includes(generated), false);
  assert.equal(`${result.stdout}${result.stderr}`.includes(outputParent), false);

  const duplicate = runProjectGenerator(projectArgs);
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /Target project directory already exists\./);
  assert.equal(`${duplicate.stdout}${duplicate.stderr}`.includes(projectRoot), false);
  assert.equal(`${duplicate.stdout}${duplicate.stderr}`.includes(outputParent), false);

  const missingSource = path.join(outputParent, "synthetic-secret-source-path");
  const missing = runProjectGenerator([
    "--name",
    "Missing Source Fixture",
    "--source",
    missingSource,
  ]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Missing required source repository/);
  assert.equal(`${missing.stdout}${missing.stderr}`.includes(missingSource), false);
});

test("clean project initialization refuses a polluted source baseline", () => {
  const sourceParent = temporaryRoot("polluted-project-source-");
  const source = path.join(sourceParent, "source");
  stageProjectExport({ sourceRoot: root, targetRoot: source });
  for (const runtimeContract of [
    ".codex/hooks.json",
    "mise.lock",
    "mise.toml",
    "scripts/context/refresh-context-index-on-stop.mjs",
    "scripts/context/refresh-context-index-on-stop.sh",
    "scripts/verify/format-project.mjs",
  ]) {
    if (!existsSync(path.join(source, runtimeContract))) {
      copyFileSync(path.join(root, runtimeContract), path.join(source, runtimeContract));
    }
  }
  initializeTrackedSource(source);
  writeFileSync(path.join(source, "docs", "project-context.md"), "# Temporary context\n", "utf8");

  const outputParent = temporaryRoot("polluted-project-output-");
  const result = runProjectGenerator([
    "--name",
    "PollutedSourceFixture",
    "--source",
    source,
    "--output-parent",
    outputParent,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Source boilerplate baseline is not clean/);
  assert.match(result.stderr, /docs\/project-context\.md/);
  assert.equal(existsSync(path.join(outputParent, "PollutedSourceFixture")), false);
});

test("clean project initialization refuses agent artifacts inside a product root", () => {
  const sourceParent = temporaryRoot("polluted-product-boundary-source-");
  const source = path.join(sourceParent, "source");
  stageProjectExport({ sourceRoot: root, targetRoot: source });
  for (const runtimeContract of [
    ".codex/hooks.json",
    "mise.lock",
    "mise.toml",
    "scripts/context/refresh-context-index-on-stop.mjs",
    "scripts/context/refresh-context-index-on-stop.sh",
    "scripts/verify/format-project.mjs",
  ]) {
    if (!existsSync(path.join(source, runtimeContract))) {
      copyFileSync(path.join(root, runtimeContract), path.join(source, runtimeContract));
    }
  }
  writeFileSync(path.join(source, "src", "AGENTS.md"), "agent pollution\n", "utf8");
  initializeTrackedSource(source);

  const outputParent = temporaryRoot("polluted-product-boundary-output-");
  const result = runProjectGenerator([
    "--name",
    "PollutedProductBoundaryFixture",
    "--source",
    source,
    "--output-parent",
    outputParent,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /src\/AGENTS\.md: agent instruction path is forbidden inside product unit src/,
  );
  assert.equal(existsSync(path.join(outputParent, "PollutedProductBoundaryFixture")), false);
});
