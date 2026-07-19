import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  assertOwnedIndexDirectory,
  assertSafeIndexDirectory,
  ensureOwnedDirectory,
  ensureOwnedIndexDirectory,
  indexOwnershipMarker,
} from "./context-paths.mjs";
import { discoverSourceFiles, isIgnored } from "./source-policy.mjs";
import {
  isExcludedActivePath,
  repositoryCodexHomeRuntimeProbePaths,
} from "../repository/source-inventory.mjs";
import { repositoryRoot, temporaryDirectory, write } from "./context-regression-helpers.mjs";

test("source discovery includes broad active Git text and excludes unsafe state", () => {
  const root = temporaryDirectory("context-source-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  write(root, ".gitignore", "ignored/\n");
  write(root, "src/index.ts", "export const active = true;\n");
  write(root, "index.html", "<!doctype html><title>Active</title>\n");
  write(root, "tsconfig.json", '{"compilerOptions": {}}\n');
  write(root, "tests/retrieval.test.mjs", "export const covered = true;\n");
  write(root, "scripts/verify/secret-patterns.mjs", "export const secretPattern = /token/;\n");
  write(root, "apps/api/auth.ts", "export function authenticate() { return true; }\n");
  write(
    root,
    "docs/project-context.md",
    "# Project Context\n\n## Goal\n\nKeep current work aligned with the manifest.\n",
  );
  write(
    root,
    ".agents/skills/example/scripts/run.mjs",
    "export function runExample() { return true; }\n",
  );
  write(root, ".agents/skills/example/references/guide.md", "# Guide\n\nReference text.\n");
  write(root, ".agents/skills/example/agents/openai.yaml", "name: example\n");
  write(root, "docs/planning/archive/old.md", "# Archived\n");
  write(root, "docs/history/session.md", "# Session history\n");
  write(root, "docs/research.md", "# Product research\n");
  write(root, "PROJECT_PLAN.md", "# Project plan\n");
  write(root, ".context-index/manifest.json", "{}\n");
  write(root, ".codex/config.toml", "sandbox_mode = 'danger-full-access'\n");
  for (const relativePath of repositoryCodexHomeRuntimeProbePaths) {
    write(root, relativePath, "repository-root Codex runtime fixture\n");
  }
  write(root, "credentials/prod.txt", "private material\n");
  write(root, "id_ed25519", "private key material\n");
  write(root, "ignored/ignored.ts", "export const ignored = true;\n");
  write(root, "src/weird\nname.ts", "export const newlineName = true;\n");
  const outside = path.join(root, "..", `${path.basename(root)}-outside.txt`);
  writeFileSync(outside, "outside\n", "utf8");
  test.after(() => rmSync(outside, { force: true }));
  symlinkSync(outside, path.join(root, "src", "outside-link.ts"));
  execFileSync("git", ["add", "-A"], { cwd: root });
  write(root, "tests/untracked.test.mjs", "export const untracked = true;\n");

  const discovered = discoverSourceFiles({ repositoryRoot: root });
  const indexed = new Set(discovered.files.map((file) => file.path));
  for (const required of [
    "src/index.ts",
    "index.html",
    "tsconfig.json",
    "tests/retrieval.test.mjs",
    "tests/untracked.test.mjs",
    "scripts/verify/secret-patterns.mjs",
    "apps/api/auth.ts",
    "docs/project-context.md",
    "docs/research.md",
    ".agents/skills/example/scripts/run.mjs",
    ".agents/skills/example/references/guide.md",
    "src/weird\nname.ts",
  ]) {
    assert.equal(indexed.has(required), true, `expected ${JSON.stringify(required)} to be indexed`);
  }
  for (const excluded of [
    ".agents/skills/example/agents/openai.yaml",
    "docs/planning/archive/old.md",
    "docs/history/session.md",
    "PROJECT_PLAN.md",
    ".context-index/manifest.json",
    ".codex/config.toml",
    "credentials/prod.txt",
    "id_ed25519",
    "ignored/ignored.ts",
    "src/outside-link.ts",
    ...repositoryCodexHomeRuntimeProbePaths,
  ]) {
    assert.equal(indexed.has(excluded), false, `expected ${excluded} to be excluded`);
  }
  assert.equal(
    discovered.skipped.some((entry) => entry.path === "src/outside-link.ts"),
    true,
  );
  assert.throws(
    () => discoverSourceFiles({ repositoryRoot: root, maxTotalSourceBytes: 16 }),
    /exceeds 16 bytes/,
  );
});

test("context eligibility never weakens the canonical active-path exclusions", () => {
  for (const relativePath of [
    ".codex/runtime/session.json",
    "apps/site/node_modules/pkg/index.js",
    "packages/lib/dist/index.js",
    "settings.local",
    ...repositoryCodexHomeRuntimeProbePaths,
  ]) {
    assert.equal(isExcludedActivePath(relativePath), true, relativePath);
    assert.equal(isIgnored(relativePath), true, relativePath);
  }

  assert.equal(isExcludedActivePath("docs/planning/archive/logs/old.md"), false);
  assert.equal(isIgnored("docs/planning/archive/logs/old.md"), true);
});

test("sanitized context workers redact both output streams and native paths", () => {
  const root = temporaryDirectory("context-worker-output-");
  const outside = temporaryDirectory("context-worker-outside-");
  const script = path.join(root, "scripts", "context", "worker-fixture.mjs");
  const workerModule = pathToFileURL(
    path.join(repositoryRoot, "scripts", "context", "context-worker-output.mjs"),
  ).href;
  write(
    root,
    "scripts/context/worker-fixture.mjs",
    [
      `import { runAsSanitizedContextWorker } from ${JSON.stringify(workerModule)};`,
      "runAsSanitizedContextWorker(import.meta.url);",
      `console.log(${JSON.stringify(`worker stdout ${root}/private`)});`,
      `console.error(${JSON.stringify(
        `[fixture WARN lance::dataset::write::insert] No existing dataset at ${root}/lancedb, it will be created`,
      )});`,
      `console.error(${JSON.stringify(`worker stderr ${outside}/private \u001b[31mred\u001b[0m`)});`,
      `console.error(${JSON.stringify(`prefix collision ${root}-private/secret-name/file.txt`)});`,
      `console.error(${JSON.stringify(
        `control path \u001b[31m${outside}/private workspace/secret-name/file.txt\u001b[0m`,
      )});`,
    ].join("\n"),
  );

  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
    timeout: 2_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /worker stdout \.\/private/);
  assert.match(result.stderr, /worker stderr <local-path>/);
  assert.doesNotMatch(result.stderr, /No existing dataset/);
  assert.equal(`${result.stdout}${result.stderr}`.includes(root), false);
  assert.equal(`${result.stdout}${result.stderr}`.includes(outside), false);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /secret-name|private workspace/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /\u001b/);
});

test("source discovery refuses a tracked file behind a replaced parent symlink", () => {
  const root = temporaryDirectory("context-source-parent-link-");
  const outside = temporaryDirectory("context-source-parent-outside-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  write(root, "packages/lib/index.ts", "export const inside = true;\n");
  execFileSync("git", ["add", "packages/lib/index.ts"], { cwd: root });
  rmSync(path.join(root, "packages"), { recursive: true });
  write(outside, "lib/index.ts", "export const outside = 'private';\n");
  symlinkSync(outside, path.join(root, "packages"), "dir");

  const discovered = discoverSourceFiles({ repositoryRoot: root });
  assert.equal(
    discovered.files.some((file) => file.path === "packages/lib/index.ts"),
    false,
  );
  assert.equal(
    discovered.skipped.some(
      (entry) =>
        entry.path === "packages/lib/index.ts" && entry.reason === "has a symbolic-link parent",
    ),
    true,
  );
});

test("source snapshots avoid rereading unchanged files at representative scale", (context) => {
  const root = temporaryDirectory("context-source-scale-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (let index = 0; index < 600; index += 1) {
    write(
      root,
      `src/file-${String(index).padStart(4, "0")}.ts`,
      `export const value${index} = ${index};\n`,
    );
  }
  execFileSync("git", ["add", "-A"], { cwd: root });

  const coldStartedAt = performance.now();
  const cold = discoverSourceFiles({ repositoryRoot: root });
  const coldMs = Math.round(performance.now() - coldStartedAt);
  const warmStartedAt = performance.now();
  const warm = discoverSourceFiles({ repositoryRoot: root, previousFiles: cold.files });
  const warmMs = Math.round(performance.now() - warmStartedAt);
  assert.equal(cold.filesRead, 600);
  assert.ok(cold.bytesRead > 0);
  assert.equal(warm.filesRead, 0);
  assert.equal(warm.bytesRead, 0);
  assert.equal(warm.reusedFiles, 600);

  write(root, "src/file-0042.ts", "export const value42 = 4200;\n");
  const changed = discoverSourceFiles({ repositoryRoot: root, previousFiles: cold.files });
  assert.equal(changed.filesRead, 1);
  assert.equal(changed.reusedFiles, 599);
  context.diagnostic(JSON.stringify({ files: 600, coldMs, warmMs, warmBytesRead: warm.bytesRead }));
});

test("index paths are strict project descendants with no symlink traversal", () => {
  const root = temporaryDirectory("context-owned-path-");
  const outside = temporaryDirectory("context-owned-outside-");
  write(root, "src/.gitkeep", "");
  write(root, "pnpm-workspace.yaml", "packages:\n  - 'apps/*'\n");
  write(root, "apps/web/package.json", '{"name":"web"}\n');
  write(root, "apps/web/src/index.ts", "export const web = true;\n");
  write(root, "settings.gradle.kts", 'include(":app")\n');
  write(root, "app/build.gradle.kts", "plugins {}\n");
  write(root, "app/src/main/AndroidManifest.xml", "<manifest />\n");
  const owned = ensureOwnedDirectory({
    repositoryRoot: root,
    configuredPath: path.join(root, ".context-index"),
    label: "Context index directory",
  });
  assert.equal(owned, path.join(root, ".context-index"));
  assert.throws(() => assertSafeIndexDirectory(root, root), /strict descendant/);
  assert.throws(() => assertSafeIndexDirectory(root, outside), /strict descendant/);
  assert.throws(
    () => assertSafeIndexDirectory(root, path.join(root, "src", "vector-space")),
    /overlap product root src/,
  );
  assert.throws(
    () => assertSafeIndexDirectory(root, path.join(root, "apps", "web", "vector-space")),
    /overlap product root apps\/web/,
  );
  assert.throws(
    () => assertSafeIndexDirectory(root, path.join(root, "app", "generated-index")),
    /overlap product root app/,
  );
  symlinkSync(outside, path.join(root, "linked"));
  assert.throws(
    () => assertSafeIndexDirectory(root, path.join(root, "linked", "index")),
    /traverses symbolic link/,
  );
});

test("cleanup refuses an external configured index and preserves its contents", () => {
  const root = temporaryDirectory("context-clean-root-");
  const outside = temporaryDirectory("context-clean-outside-");
  write(outside, "sentinel.txt", "do not delete\n");
  const script = path.join(repositoryRoot, "scripts/context/clean-context-index.mjs");
  const result = spawnSync(process.execPath, [script], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CONTEXT_INDEX_TEST_MODE: "1",
      CONTEXT_INDEX_ROOT: root,
      CONTEXT_INDEX_DIRECTORY: outside,
    },
    encoding: "utf8",
    timeout: 2_000,
  });
  assert.equal(result.status, 1);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /strict descendant/);
  assert.equal(output.includes(outside), false);
  assert.equal(readFileSync(path.join(outside, "sentinel.txt"), "utf8"), "do not delete\n");
});

test("normal context commands cannot be redirected to another project or model cache", () => {
  const script = path.join(repositoryRoot, "scripts/context/check-context-index.mjs");
  const outsideProject = temporaryDirectory("context-isolation-outside-project-");
  write(outsideProject, "sentinel.txt", "outside project\n");
  const redirectedEnvironment = { ...process.env, CONTEXT_INDEX_ROOT: outsideProject };
  delete redirectedEnvironment.CONTEXT_INDEX_TEST_MODE;
  const redirected = spawnSync(process.execPath, [script, "--status-only"], {
    cwd: repositoryRoot,
    env: redirectedEnvironment,
    encoding: "utf8",
    timeout: 2_000,
  });
  assert.equal(redirected.status, 1);
  assert.match(`${redirected.stdout}${redirected.stderr}`, /CONTEXT_INDEX_ROOT is test-only/);
  assert.equal(
    readFileSync(path.join(outsideProject, "sentinel.txt"), "utf8"),
    "outside project\n",
  );

  const redirectedDirectoryEnvironment = {
    ...process.env,
    CONTEXT_INDEX_DIRECTORY: path.join(repositoryRoot, "another-context-index"),
  };
  delete redirectedDirectoryEnvironment.CONTEXT_INDEX_TEST_MODE;
  const redirectedDirectory = spawnSync(process.execPath, [script, "--status-only"], {
    cwd: repositoryRoot,
    env: redirectedDirectoryEnvironment,
    encoding: "utf8",
    timeout: 2_000,
  });
  assert.equal(redirectedDirectory.status, 1);
  assert.match(
    `${redirectedDirectory.stdout}${redirectedDirectory.stderr}`,
    /CONTEXT_INDEX_DIRECTORY is test-only; project context state is fixed at \.context-index/,
  );

  const root = temporaryDirectory("context-isolation-root-");
  const externalCache = temporaryDirectory("context-isolation-cache-");
  const cacheTargets = [
    externalCache,
    path.join(root, ".codex", "runtime"),
    path.join(root, "src"),
  ];
  for (const target of cacheTargets) {
    write(target, "sentinel.txt", "isolated cache boundary\n");
    const result = spawnSync(process.execPath, [script, "--status-only"], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CONTEXT_INDEX_TEST_MODE: "1",
        CONTEXT_INDEX_ROOT: root,
        CONTEXT_INDEX_MODEL_CACHE: target,
      },
      encoding: "utf8",
      timeout: 2_000,
    });
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}${result.stderr}`, /CONTEXT_INDEX_MODEL_CACHE is unsupported/);
    assert.equal(
      readFileSync(path.join(target, "sentinel.txt"), "utf8"),
      "isolated cache boundary\n",
    );
  }
});

test("cleanup refuses Codex runtime and active source directories", () => {
  const script = path.join(repositoryRoot, "scripts/context/clean-context-index.mjs");
  for (const relativeDirectory of [".codex/runtime", "src"]) {
    const root = temporaryDirectory("context-clean-owned-state-");
    write(root, `${relativeDirectory}/sentinel.txt`, "preserve project state\n");
    const target = path.join(root, relativeDirectory);
    const result = spawnSync(process.execPath, [script], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CONTEXT_INDEX_TEST_MODE: "1",
        CONTEXT_INDEX_ROOT: root,
        CONTEXT_INDEX_DIRECTORY: target,
      },
      encoding: "utf8",
      timeout: 2_000,
    });
    assert.equal(result.status, 1, relativeDirectory);
    assert.equal(
      readFileSync(path.join(target, "sentinel.txt"), "utf8"),
      "preserve project state\n",
    );
  }
});

test("a dedicated index receives an ownership marker and custom index state is excluded", () => {
  const root = temporaryDirectory("context-index-owner-");
  const indexDirectory = path.join(root, "generated-context");
  ensureOwnedIndexDirectory({ repositoryRoot: root, indexDirectory });
  assert.equal(existsSync(path.join(indexDirectory, indexOwnershipMarker)), true);

  const previousDirectory = process.env.CONTEXT_INDEX_DIRECTORY;
  const previousTestMode = process.env.CONTEXT_INDEX_TEST_MODE;
  process.env.CONTEXT_INDEX_TEST_MODE = "1";
  process.env.CONTEXT_INDEX_DIRECTORY = indexDirectory;
  try {
    assert.equal(isIgnored("generated-context/manifest.json", { repositoryRoot: root }), true);
  } finally {
    if (previousDirectory === undefined) delete process.env.CONTEXT_INDEX_DIRECTORY;
    else process.env.CONTEXT_INDEX_DIRECTORY = previousDirectory;
    if (previousTestMode === undefined) delete process.env.CONTEXT_INDEX_TEST_MODE;
    else process.env.CONTEXT_INDEX_TEST_MODE = previousTestMode;
  }
});

test("an existing custom directory cannot be adopted as generated index state", () => {
  const root = temporaryDirectory("context-index-existing-custom-");
  const productDirectory = path.join(root, "src");
  mkdirSync(productDirectory);
  assert.throws(
    () => ensureOwnedIndexDirectory({ repositoryRoot: root, indexDirectory: productDirectory }),
    /cannot overlap product root src/,
  );
  assert.equal(existsSync(path.join(productDirectory, indexOwnershipMarker)), false);

  const emptyDirectory = path.join(root, "existing-custom-index");
  mkdirSync(emptyDirectory);
  assert.throws(
    () => ensureOwnedIndexDirectory({ repositoryRoot: root, indexDirectory: emptyDirectory }),
    /Existing custom context index directory has no ownership marker/,
  );
  assert.equal(existsSync(path.join(emptyDirectory, indexOwnershipMarker)), false);

  const generated = path.join(root, "generated-context");
  ensureOwnedIndexDirectory({ repositoryRoot: root, indexDirectory: generated });
  symlinkSync(root, path.join(generated, "model-cache"));
  assert.throws(
    () =>
      assertOwnedIndexDirectory({
        repositoryRoot: root,
        indexDirectory: generated,
        allowMissing: false,
      }),
    /non-index content/,
  );
});

test("read-only status on a missing index creates no runtime or index state", () => {
  const root = temporaryDirectory("context-status-root-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  write(root, "README.md", "# Status fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  const script = path.join(repositoryRoot, "scripts/context/check-context-index.mjs");
  const result = spawnSync(process.execPath, [script, "--no-repair", "--status-only"], {
    cwd: repositoryRoot,
    env: { ...process.env, CONTEXT_INDEX_TEST_MODE: "1", CONTEXT_INDEX_ROOT: root },
    encoding: "utf8",
    timeout: 2_000,
  });
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /Context index status: missing/);
  assert.equal(existsSync(path.join(root, ".context-index")), false);
  assert.equal(existsSync(path.join(root, ".codex", "runtime")), false);
});
