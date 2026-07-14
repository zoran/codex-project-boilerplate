import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chunkContent, extractMetadata } from "./context-chunks.mjs";
import { hashContent } from "./context-hashing.mjs";
import {
  embeddingDimensions,
  inspectModelArtifacts,
  requiredModelArtifactPaths,
  resolveModelLocation,
} from "./context-embedding.mjs";
import {
  chunkFingerprint,
  loadManifestState,
  schemaVersion,
  sourceChanges,
  validateManifest,
} from "./context-manifest.mjs";
import {
  acquireRebuildLock,
  readLockOwner,
  releaseRebuildLock,
  retireStaleLockIfNeeded,
} from "./context-lock.mjs";
import {
  assertOwnedIndexDirectory,
  assertSafeIndexDirectory,
  ensureOwnedDirectory,
  ensureOwnedIndexDirectory,
  indexOwnershipMarker,
} from "./context-paths.mjs";
import { rankHybridResults } from "./context-ranking.mjs";
import { createRecordBatches, resolveChunkVectors } from "./context-build.mjs";
import {
  cleanupGeneratedIndexDebris,
  explainDenseQueryPlan,
  explainFilterQueryPlan,
  fingerprintReadBatchSize,
  inspectDatabaseIndices,
  loadReusableRows,
  publishIndex,
  queryReusableRowsInBatches,
  queryDatabase,
  recoverIndexTransaction,
  reusableLookupBatchSize,
  verifyDatabaseStructure,
} from "./context-storage.mjs";
import { discoverSourceFiles, isIgnored } from "./source-policy.mjs";
import { isExcludedActivePath } from "../repository/source-inventory.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function temporaryDirectory(prefix) {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  test.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function write(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

function copyTree(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) copyTree(sourcePath, destinationPath);
    else if (entry.isFile()) copyFileSync(sourcePath, destinationPath);
    else throw new Error(`Model fixture contains unsupported entry: ${entry.name}`);
  }
}

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
  ]) {
    assert.equal(isExcludedActivePath(relativePath), true, relativePath);
    assert.equal(isIgnored(relativePath), true, relativePath);
  }

  assert.equal(isExcludedActivePath("docs/planning/archive/logs/old.md"), false);
  assert.equal(isIgnored("docs/planning/archive/logs/old.md"), true);
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

test("token-aware logical chunks stay within the supplied total budget", () => {
  const content = [
    "# Retrieval",
    "",
    "A long logical paragraph " + "token ".repeat(180),
    "",
    "export function exactPhraseRecovery() {",
    `  return "${"character".repeat(120)}";`,
    "}",
  ].join("\n");
  const countTokens = (value) => Math.ceil([...value].length / 4) + 2;
  const chunks = chunkContent("src/retrieval.ts", content, extractMetadata(content), countTokens, {
    tokenLimit: 96,
  });
  assert.ok(chunks.length > 3);
  assert.ok(chunks.every((chunk) => chunk.tokenCount <= 96));
  assert.match(chunks.map((chunk) => chunk.text).join("\n"), /exactPhraseRecovery/);
});

test("a one-megabyte context-carrier line is split with bounded tokenization work", () => {
  const content = `<main data-context="${"x".repeat(1_000_000)}"></main>`;
  let calls = 0;
  let totalCharacters = 0;
  let largeCalls = 0;
  const countTokens = (value) => {
    calls += 1;
    totalCharacters += value.length;
    if (value.length > 10_000) largeCalls += 1;
    return Math.ceil(value.length / 4) + 2;
  };
  const chunks = chunkContent(
    "public/context-carrier.html",
    content,
    extractMetadata(content),
    countTokens,
    { tokenLimit: 448 },
  );
  assert.ok(chunks.length > 500);
  assert.ok(chunks.every((chunk) => chunk.tokenCount <= 448));
  assert.equal(chunks.map((chunk) => chunk.text).join(""), content);
  assert.equal(largeCalls, 1, "only the initial size check may tokenize the complete line");
  assert.ok(calls < 10_000, `expected bounded tokenizer calls, received ${calls}`);
  assert.ok(
    totalCharacters < content.length * 25,
    `expected linear tokenized volume, received ${totalCharacters}`,
  );
});

test("heading and symbol metadata lookups scale logarithmically with large context carriers", () => {
  const content = Array.from(
    { length: 5_000 },
    (_, index) => `## Section ${index}\n\nexport const symbol${index} = ${index};`,
  ).join("\n\n");
  const lookupStats = {};
  const chunks = chunkContent(
    "src/large-context-carrier.ts",
    content,
    extractMetadata(content),
    (value) => Math.ceil(value.length / 4) + 2,
    { tokenLimit: 96, lookupStats },
  );
  assert.ok(chunks.length > 1_000);
  assert.ok(lookupStats.candidateLookups > 10_000);
  assert.ok(
    lookupStats.binarySearchProbes < lookupStats.candidateLookups * 32,
    `expected logarithmic metadata probes, received ${JSON.stringify(lookupStats)}`,
  );
  assert.ok(
    lookupStats.symbolRowsVisited < lookupStats.candidateLookups * 8,
    `expected range-bounded symbol visits, received ${JSON.stringify(lookupStats)}`,
  );
});

function row(id, filePath, startLine, endLine, text) {
  return {
    id,
    path: filePath,
    startLine,
    endLine,
    text,
    headingsText: "",
    symbolsText: "",
    importsText: "",
    tokenCount: 20,
    embeddingHash: id,
  };
}

test("independent lexical candidates recover exact phrases and diversify paths", () => {
  const denseResults = Array.from({ length: 32 }, (_, index) => ({
    ...row(
      `dense-${index}`,
      index < 8 ? "docs/repeated.md" : `docs/dense-${index}.md`,
      index,
      index + 5,
      `semantic candidate ${index}`,
    ),
    _distance: 0.8 + index / 100,
  }));
  const exact = row(
    "exact",
    "docs/testing.md",
    40,
    52,
    "Ignored system runtime cache contents are not read as project owned skill source.",
  );
  const results = rankHybridResults({
    denseResults,
    allRows: [...denseResults, exact],
    query: "cache contents are not read as project owned skill source",
    limit: 8,
  });
  assert.equal(results[0].id, "exact");
  assert.equal(results[0]._exactPhrase, true);
  assert.ok(
    [...new Set(results.map((result) => result.path))].length >= 5,
    "expected diversified result paths",
  );
});

test("incremental vector resolution reuses unchanged chunks and reports add/change/delete", async () => {
  const chunks = [
    { path: "a.md", embeddingHash: "same", embeddingText: "same text" },
    { path: "b.md", embeddingHash: "new", embeddingText: "new text" },
  ];
  let embeddedTexts = [];
  const result = await resolveChunkVectors({
    chunks,
    reusableRows: [{ embeddingHash: "same", vector: new Float32Array([1, 0, 0]) }],
    embeddingDimensions: 3,
    batchSize: 4,
    embedBatch: async (texts) => {
      embeddedTexts = texts;
      return texts.map(() => [0, 1, 0]);
    },
  });
  assert.deepEqual(embeddedTexts, ["new text"]);
  assert.equal(result.reusedChunks, 1);
  assert.equal(result.embeddedChunks, 1);
  assert.equal(result.embeddedVectors, 1);
  assert.deepEqual(result.vectorsByHash.get("same"), [1, 0, 0]);

  const changes = sourceChanges(
    [
      { path: "a.md", hash: "old-a" },
      { path: "removed.md", hash: "old-removed" },
    ],
    [
      { path: "a.md", hash: "new-a" },
      { path: "added.md", hash: "new-added" },
    ],
  );
  assert.deepEqual(changes, {
    missing: ["added.md"],
    changed: ["a.md"],
    snapshotChanged: [],
    removed: ["removed.md"],
  });

  assert.deepEqual(
    sourceChanges(
      [{ path: "same.md", hash: "same", statSignature: "old-stat" }],
      [{ path: "same.md", hash: "same", statSignature: "new-stat" }],
    ),
    { missing: [], changed: [], snapshotChanged: ["same.md"], removed: [] },
  );
});

test("record production keeps write and embedding batches bounded even for duplicate chunks", async () => {
  const chunks = Array.from({ length: 305 }, (_, index) => {
    const embeddingHash = index < 300 ? "z" : `unique-${index}`;
    return {
      id: `chunk-${String(index).padStart(3, "0")}`,
      path: `docs/file-${index}.md`,
      startLine: 1,
      endLine: 1,
      text: `fixture ${index}`,
      headings: [],
      symbols: [],
      imports: [],
      tokenCount: 2,
      contentHash: `content-${index}`,
      embeddingHash,
      embeddingText: embeddingHash,
    };
  });
  const embeddingCalls = [];
  const batchLengths = [];
  for await (const batch of createRecordBatches({
    chunks,
    embeddingDimensions: 3,
    embeddingBatchSize: 4,
    modelCachePath: "unused",
    embedBatch: async (texts) => {
      embeddingCalls.push(texts);
      return texts.map(() => [1, 0, 0]);
    },
  })) {
    batchLengths.push(batch.length);
  }
  assert.deepEqual(batchLengths, [128, 128, 49]);
  assert.ok(embeddingCalls.every((batch) => batch.length <= 4));
  assert.equal(embeddingCalls.flat().length, 6, "each distinct embedding is produced once");
});

test("five thousand reusable hashes require batched queries and one vector load", async () => {
  const hashes = Array.from({ length: 5_000 }, (_, index) => String(index).padStart(64, "0"));
  const candidates = hashes.map((embeddingHash, index) => ({
    id: `previous-chunk-${index}`,
    embeddingHash,
  }));
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const diagnostics = {};
  const selectedColumns = [];
  const table = {
    query() {
      let predicate = "";
      return {
        where(value) {
          predicate = value;
          return this;
        },
        select(columns) {
          selectedColumns.push(columns);
          return this;
        },
        limit(value) {
          assert.ok(value <= reusableLookupBatchSize);
          return this;
        },
        async toArray() {
          return [...predicate.matchAll(/'([^']+)'/g)].map((match) => ({
            ...candidateById.get(match[1]),
            vector: [1, 0, 0],
          }));
        },
      };
    },
  };
  const reusableRows = await queryReusableRowsInBatches(table, candidates, { diagnostics });
  assert.equal(reusableRows.length, hashes.length);
  assert.equal(diagnostics.queryCalls, Math.ceil(hashes.length / reusableLookupBatchSize));
  assert.equal(diagnostics.rowsRead, hashes.length);
  assert.ok(selectedColumns.every((columns) => columns.join(",") === "id,embeddingHash,vector"));

  const chunks = hashes.map((embeddingHash, index) => ({
    id: `chunk-${index}`,
    path: `docs/file-${index}.md`,
    startLine: 1,
    endLine: 1,
    text: `fixture ${index}`,
    headings: [],
    symbols: [],
    imports: [],
    tokenCount: 2,
    contentHash: embeddingHash,
    embeddingHash,
    embeddingText: embeddingHash,
  }));
  let records = 0;
  for await (const batch of createRecordBatches({
    chunks,
    embeddingDimensions: 3,
    embeddingBatchSize: 4,
    modelCachePath: "unused",
    reusableRows,
    embedBatch: async () => {
      throw new Error("reusable vectors must not be embedded again");
    },
  })) {
    records += batch.length;
  }
  assert.equal(records, hashes.length);
});

test("offline model resolution is local-only and cold failure is non-destructive", () => {
  const cache = temporaryDirectory("context-model-");
  assert.throws(() => resolveModelLocation(cache, { offline: true }), /missing config\.json/);
  write(cache, "sentinel.txt", "preserve me\n");
  const revision = path.join(cache, "Xenova", "all-MiniLM-L6-v2", "revision-placeholder");
  // The production helper uses the pinned revision, so derive it from the reported directory.
  const missing = inspectModelArtifacts(cache);
  const actualRevision = missing.revisionDirectory;
  for (const artifact of requiredModelArtifactPaths) write(actualRevision, artifact, "fixture\n");
  const resolved = resolveModelLocation(cache, { offline: true });
  assert.equal(resolved.localFilesOnly, true);
  assert.equal(resolved.location, actualRevision);
  const firstIdentity = inspectModelArtifacts(cache, { includeHash: true });
  const cachedIdentity = inspectModelArtifacts(cache, { includeHash: true });
  assert.match(firstIdentity.hash, /^[a-f0-9]{64}$/);
  assert.equal(cachedIdentity.hash, firstIdentity.hash);
  assert.equal(cachedIdentity.hashFromCache, true);
  assert.equal(readFileSync(path.join(cache, "sentinel.txt"), "utf8"), "preserve me\n");
  assert.notEqual(revision, actualRevision);
});

test("manifest shape validation rejects structurally corrupt JSON data", () => {
  const invalid = {
    schemaVersion,
    files: {},
  };
  assert.equal(validateManifest(invalid).valid, false);
});

test("manifest loading refuses a symlink instead of reading its target", () => {
  const root = temporaryDirectory("context-manifest-link-");
  const outside = temporaryDirectory("context-manifest-link-outside-");
  write(outside, "manifest.json", '{"private":"outside"}\n');
  symlinkSync(path.join(outside, "manifest.json"), path.join(root, "manifest.json"));
  const state = loadManifestState(path.join(root, "manifest.json"));
  assert.equal(state.manifest, null);
  assert.match(state.reason, /non-symlink regular file/);
});

test("database structure check rejects a present table with the wrong row count", async () => {
  const root = temporaryDirectory("context-db-");
  const databasePath = path.join(root, "lancedb");
  const lancedb = await import("@lancedb/lancedb");
  const db = await lancedb.connect(databasePath);
  await db.createTable("context_chunks", [
    {
      id: "one",
      path: "one.md",
      startLine: 1,
      endLine: 1,
      text: "one",
      headingsText: "",
      symbolsText: "",
      importsText: "",
      tokenCount: 3,
      embeddingHash: "one",
      vector: Array(embeddingDimensions).fill(0),
    },
  ]);
  await db.close();
  await assert.rejects(
    verifyDatabaseStructure({
      databasePath,
      tableName: "context_chunks",
      manifest: { stats: { chunks: 2 } },
      embeddingDimensions,
    }),
    /row count mismatch/,
  );
});

test("database access refuses a symlinked database directory", async () => {
  const root = temporaryDirectory("context-db-link-");
  const outside = temporaryDirectory("context-db-link-outside-");
  write(outside, "sentinel.txt", "outside database state\n");
  const databasePath = path.join(root, "lancedb");
  symlinkSync(outside, databasePath, "dir");
  await assert.rejects(
    verifyDatabaseStructure({
      databasePath,
      tableName: "context_chunks",
      manifest: { stats: { chunks: 0 } },
      embeddingDimensions,
    }),
    /not a non-symlink directory/,
  );
  assert.equal(
    readFileSync(path.join(outside, "sentinel.txt"), "utf8"),
    "outside database state\n",
  );
});

test("reusable-vector lookup reads one selected row even when a hash has many duplicates", async () => {
  const root = temporaryDirectory("context-reuse-deduplicate-");
  const indexDirectory = path.join(root, ".context-index");
  const databasePath = path.join(indexDirectory, "lancedb");
  const manifestPath = path.join(indexDirectory, "manifest.json");
  mkdirSync(indexDirectory);
  const embeddingHash = "a".repeat(64);
  const records = Array.from({ length: 2_000 }, (_, index) => ({
    id: `duplicate-${index}`,
    path: `docs/duplicate-${index}.md`,
    startLine: 1,
    endLine: 1,
    text: "duplicate vector fixture",
    headingsText: "",
    symbolsText: "",
    importsText: "",
    searchText: "duplicate vector fixture",
    tokenCount: 3,
    contentHash: String(index).padStart(64, "0"),
    embeddingHash,
    vector: [1, 0, 0],
  }));
  await publishIndex({
    indexDirectory,
    databasePath,
    manifestPath,
    tableName: "context_chunks",
    records,
    manifest: { stats: { chunks: records.length } },
    vectorIndexThreshold: 10_000,
  });
  const diagnostics = {};
  const reusable = await loadReusableRows(
    databasePath,
    "context_chunks",
    3,
    [{ id: records[0].id, embeddingHash }],
    { diagnostics },
  );
  const filterPlan = await explainFilterQueryPlan({
    databasePath,
    tableName: "context_chunks",
    column: "embeddingHash",
    value: embeddingHash,
  });
  assert.equal(reusable.length, 1);
  assert.equal(reusable[0].embeddingHash, embeddingHash);
  assert.equal(diagnostics.queryCalls, 1);
  assert.equal(diagnostics.rowsRead, 1);
  assert.match(filterPlan, /(?:Scalar|BTree|MaterializeIndex)/i);
});

test("light completion avoids identity scans while streamed deep checks catch a foreign row", async () => {
  const root = temporaryDirectory("context-deep-fingerprint-");
  const indexDirectory = path.join(root, ".context-index");
  const databasePath = path.join(indexDirectory, "lancedb");
  const manifestPath = path.join(indexDirectory, "manifest.json");
  mkdirSync(indexDirectory);
  const records = Array.from({ length: 1_200 }, (_, index) =>
    storageRecord(index, `Deep integrity fixture ${index}.`),
  );
  records[0].id = ".hidden:chunk";
  records[1].id = "Alpha:chunk";
  records[2].id = "alpha:chunk";
  records[3].id = "ümlaut:chunk";
  const manifest = {
    stats: { chunks: records.length, vectorIndexEnabled: false },
    chunkFingerprint: chunkFingerprint(records),
  };
  await publishIndex({
    indexDirectory,
    databasePath,
    manifestPath,
    tableName: "context_chunks",
    records,
    manifest,
    vectorIndexThreshold: 10_000,
  });

  const lightDiagnostics = {};
  await verifyDatabaseStructure({
    databasePath,
    tableName: "context_chunks",
    manifest,
    embeddingDimensions,
    verifyFingerprint: false,
    diagnostics: lightDiagnostics,
  });
  assert.equal(lightDiagnostics.fingerprintRows, undefined);

  const deepDiagnostics = {};
  await verifyDatabaseStructure({
    databasePath,
    tableName: "context_chunks",
    manifest,
    embeddingDimensions,
    diagnostics: deepDiagnostics,
  });
  assert.equal(deepDiagnostics.fingerprintRows, records.length);
  assert.ok(deepDiagnostics.fingerprintBatches >= 3);
  assert.ok(deepDiagnostics.maximumFingerprintBatchRows <= fingerprintReadBatchSize);

  const lancedb = await import("@lancedb/lancedb");
  const db = await lancedb.connect(databasePath);
  const table = await db.openTable("context_chunks");
  await table.delete(`id = '${records[0].id}'`);
  await table.add([
    {
      ...records[0],
      id: "foreign-row",
      embeddingHash: "f".repeat(64),
      text: "Foreign row with a valid schema and unchanged total row count.",
    },
  ]);
  await db.close();
  await assert.rejects(
    verifyDatabaseStructure({
      databasePath,
      tableName: "context_chunks",
      manifest,
      embeddingDimensions,
    }),
    /chunk identity does not match/,
  );
});

test("full publication rejects a manifest row-count mismatch", async () => {
  const root = temporaryDirectory("context-full-row-mismatch-");
  const indexDirectory = path.join(root, ".context-index");
  mkdirSync(indexDirectory);
  await assert.rejects(
    publishIndex({
      indexDirectory,
      databasePath: path.join(indexDirectory, "lancedb"),
      manifestPath: path.join(indexDirectory, "manifest.json"),
      tableName: "context_chunks",
      records: [storageRecord(0, "single row")],
      manifest: { stats: { chunks: 2 } },
    }),
    /Full context publication row mismatch/,
  );
  assert.equal(existsSync(path.join(indexDirectory, "manifest.json")), false);
  assert.equal(existsSync(path.join(indexDirectory, "lancedb")), false);
});

test("interrupted publication debris is removed without touching current state", () => {
  const root = temporaryDirectory("context-debris-");
  write(root, "manifest.json", "current\n");
  write(root, "manifest.next-1.json", "partial\n");
  write(root, "manifest.previous-1.json", "old\n");
  write(root, "lancedb/current", "current\n");
  write(root, "lancedb.next-1/partial", "partial\n");
  write(root, "lancedb.previous-1/old", "old\n");
  cleanupGeneratedIndexDebris(root);
  assert.equal(existsSync(path.join(root, "manifest.json")), true);
  assert.equal(existsSync(path.join(root, "lancedb/current")), true);
  assert.equal(existsSync(path.join(root, "manifest.next-1.json")), false);
  assert.equal(existsSync(path.join(root, "lancedb.previous-1")), false);
});

test("interrupted publication restores the previous database generation", () => {
  const root = temporaryDirectory("context-recover-database-");
  write(root, "manifest.json", "old manifest\n");
  write(root, "lancedb.previous-1/old", "old database\n");
  write(root, "lancedb.next-1/new", "new database\n");
  write(root, "manifest.next-1.json", "new manifest\n");
  cleanupGeneratedIndexDebris(root);
  assert.equal(readFileSync(path.join(root, "manifest.json"), "utf8"), "old manifest\n");
  assert.equal(readFileSync(path.join(root, "lancedb/old"), "utf8"), "old database\n");
  assert.equal(existsSync(path.join(root, "lancedb.next-1")), false);
});

test("interrupted publication rolls back a database published without its manifest", () => {
  const root = temporaryDirectory("context-recover-pair-");
  write(root, "lancedb/new", "new database\n");
  write(root, "lancedb.previous-2/old", "old database\n");
  write(root, "manifest.previous-2.json", "old manifest\n");
  write(root, "manifest.next-2.json", "new manifest\n");
  cleanupGeneratedIndexDebris(root);
  assert.equal(readFileSync(path.join(root, "lancedb/old"), "utf8"), "old database\n");
  assert.equal(readFileSync(path.join(root, "manifest.json"), "utf8"), "old manifest\n");
  assert.equal(existsSync(path.join(root, "lancedb/new")), false);
});

test("incremental transaction recovery restores the recorded Lance version", async () => {
  const root = temporaryDirectory("context-version-recovery-");
  const indexDirectory = path.join(root, ".context-index");
  const databasePath = path.join(indexDirectory, "lancedb");
  const manifestPath = path.join(indexDirectory, "manifest.json");
  mkdirSync(indexDirectory);
  const records = [storageRecord(0, "alpha"), storageRecord(1, "beta")];
  await publishIndex({
    indexDirectory,
    databasePath,
    manifestPath,
    tableName: "context_chunks",
    records,
    manifest: { stats: { chunks: records.length } },
  });
  const lancedb = await import("@lancedb/lancedb");
  let db = await lancedb.connect(databasePath);
  let table = await db.openTable("context_chunks");
  const beforeVersion = await table.version();
  const databaseInode = statSync(databasePath).ino;
  await publishIndex({
    indexDirectory,
    databasePath,
    manifestPath,
    tableName: "context_chunks",
    records: [],
    manifest: { stats: { chunks: records.length }, metadataOnly: true },
    incremental: true,
    manifestOnly: true,
  });
  assert.equal(await table.version(), beforeVersion);
  assert.equal(statSync(databasePath).ino, databaseInode);
  await table.add([storageRecord(99, "uncommitted row")]);
  await db.close();
  write(
    indexDirectory,
    "database-transaction.json",
    `${JSON.stringify({
      version: 1,
      beforeVersion,
      targetManifestHash: "f".repeat(64),
      createdAt: new Date().toISOString(),
    })}\n`,
  );

  const recovery = await recoverIndexTransaction({
    indexDirectory,
    databasePath,
    manifestPath,
    tableName: "context_chunks",
  });
  assert.equal(recovery.state, "rolled-back");
  db = await lancedb.connect(databasePath);
  table = await db.openTable("context_chunks");
  assert.equal(await table.countRows(), records.length);
  await db.close();
  assert.equal(existsSync(path.join(indexDirectory, "database-transaction.json")), false);

  const manifestHash = hashContent(readFileSync(manifestPath));
  write(
    indexDirectory,
    "database-transaction.json",
    `${JSON.stringify({
      version: 1,
      beforeVersion,
      targetManifestHash: manifestHash,
      createdAt: new Date().toISOString(),
    })}\n`,
  );
  const committed = await recoverIndexTransaction({
    indexDirectory,
    databasePath,
    manifestPath,
    tableName: "context_chunks",
  });
  assert.equal(committed.state, "committed");
});

test("full repair supersedes an unusable journal when its database is missing", async () => {
  const root = temporaryDirectory("context-full-repair-journal-");
  const indexDirectory = path.join(root, ".context-index");
  const databasePath = path.join(indexDirectory, "lancedb");
  const manifestPath = path.join(indexDirectory, "manifest.json");
  mkdirSync(indexDirectory);
  write(
    indexDirectory,
    "database-transaction.json",
    `${JSON.stringify({
      version: 1,
      beforeVersion: 99,
      targetManifestHash: "e".repeat(64),
      createdAt: new Date().toISOString(),
    })}\n`,
  );
  const records = [storageRecord(0, "repaired row")];
  await publishIndex({
    indexDirectory,
    databasePath,
    manifestPath,
    tableName: "context_chunks",
    records,
    manifest: { stats: { chunks: records.length } },
  });
  assert.equal(existsSync(path.join(indexDirectory, "database-transaction.json")), false);
  const verified = await verifyDatabaseStructure({
    databasePath,
    tableName: "context_chunks",
    manifest: { stats: { chunks: 1 }, chunkFingerprint: "unused" },
    embeddingDimensions,
    verifyFingerprint: false,
  });
  assert.equal(verified.rowCount, 1);
});

test("incremental reuse preloads a bounded vector before deleting the replaced path", async () => {
  const root = temporaryDirectory("context-incremental-snapshot-");
  const indexDirectory = path.join(root, ".context-index");
  const databasePath = path.join(indexDirectory, "lancedb");
  const manifestPath = path.join(indexDirectory, "manifest.json");
  mkdirSync(indexDirectory);
  const original = storageRecord(0, "original reusable vector", "docs/reused.md");
  await publishIndex({
    indexDirectory,
    databasePath,
    manifestPath,
    tableName: "context_chunks",
    records: [original],
    manifest: { stats: { chunks: 1 } },
  });
  let embeddingCalls = 0;
  let snapshotVersion;
  const lookupDiagnostics = {};
  const reusableRows = await loadReusableRows(
    databasePath,
    "context_chunks",
    embeddingDimensions,
    [{ id: original.id, embeddingHash: original.embeddingHash }],
    { diagnostics: lookupDiagnostics },
  );
  const chunk = {
    id: "replacement",
    path: original.path,
    startLine: 1,
    endLine: 1,
    text: "replacement reuses the existing embedding",
    headings: [],
    symbols: [],
    imports: [],
    tokenCount: 5,
    contentHash: "b".repeat(64),
    embeddingHash: original.embeddingHash,
    embeddingText: "same embedding identity",
  };
  await publishIndex({
    indexDirectory,
    databasePath,
    manifestPath,
    tableName: "context_chunks",
    recordBatchFactory: ({ databaseVersion }) => {
      snapshotVersion = databaseVersion;
      return createRecordBatches({
        chunks: [chunk],
        embeddingDimensions,
        embeddingBatchSize: 4,
        modelCachePath: "unused",
        reusableRows,
        embedBatch: async (texts) => {
          embeddingCalls += texts.length;
          return texts.map(() => original.vector);
        },
      });
    },
    manifest: { stats: { chunks: 1, processedChunks: 1 } },
    incremental: true,
    replacedPaths: [original.path],
  });
  assert.ok(Number.isInteger(snapshotVersion));
  assert.equal(lookupDiagnostics.queryCalls, 1);
  assert.equal(lookupDiagnostics.rowsRead, 1);
  assert.equal(embeddingCalls, 0);
  const rows = await queryDatabase({
    databasePath,
    tableName: "context_chunks",
    vector: original.vector,
    query: "replacement",
    denseLimit: 4,
    lexicalLimit: 4,
  });
  assert.equal(rows.denseResults[0].id, "replacement");
});

test("a lease never removes a replacement owner's lock", async () => {
  const root = temporaryDirectory("context-lock-");
  const lockPath = path.join(root, "context.lock");
  const lease = await acquireRebuildLock(lockPath, { timeoutMs: 500, staleLockMs: 100 });
  const owner = readLockOwner(lockPath);
  assert.equal(owner.token, lease.owner.token);
  writeFileSync(
    path.join(lockPath, "owner.json"),
    `${JSON.stringify({ ...owner, token: "replacement-owner-token-0001" }, null, 2)}\n`,
    "utf8",
  );
  assert.equal(releaseRebuildLock(lease), false);
  assert.equal(existsSync(lockPath), true);
});

test("lock acquisition refuses a symlinked lock directory", async () => {
  const root = temporaryDirectory("context-lock-link-");
  const outside = temporaryDirectory("context-lock-link-outside-");
  write(outside, "sentinel.txt", "preserve outside state\n");
  const lockPath = path.join(root, "context.lock");
  symlinkSync(outside, lockPath, "dir");
  await assert.rejects(
    acquireRebuildLock(lockPath, { timeoutMs: 100, staleLockMs: 1, pollMs: 5 }),
    /not a safe directory/,
  );
  assert.equal(
    readFileSync(path.join(outside, "sentinel.txt"), "utf8"),
    "preserve outside state\n",
  );
});

test("stale-lock quarantine never removes a replacement generation", () => {
  const root = temporaryDirectory("context-lock-race-");
  const lockPath = path.join(root, "context.lock");
  mkdirSync(lockPath);
  const staleOwner = {
    pid: 2_147_483_647,
    host: os.hostname(),
    token: "stale-owner-token-000000000001",
    createdAt: new Date(0).toISOString(),
    heartbeatAt: new Date(0).toISOString(),
  };
  write(lockPath, "owner.json", `${JSON.stringify(staleOwner)}\n`);
  const displaced = path.join(root, "displaced-stale-lock");
  const replacementOwner = {
    ...staleOwner,
    pid: process.pid,
    token: "replacement-owner-token-0000001",
    createdAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  };

  const retired = retireStaleLockIfNeeded(lockPath, 1, {
    afterClaim() {
      renameSync(lockPath, displaced);
      mkdirSync(lockPath);
      write(lockPath, "owner.json", `${JSON.stringify(replacementOwner)}\n`);
    },
  });
  assert.equal(retired, false);
  assert.equal(readLockOwner(lockPath).token, replacementOwner.token);
  assert.equal(existsSync(displaced), true);
});

test("stale-lock quarantine removes only the claimed dead generation", () => {
  const root = temporaryDirectory("context-lock-retire-");
  const lockPath = path.join(root, "context.lock");
  mkdirSync(lockPath);
  write(
    lockPath,
    "owner.json",
    `${JSON.stringify({
      pid: 2_147_483_647,
      host: os.hostname(),
      token: "dead-owner-token-0000000000001",
      createdAt: new Date(0).toISOString(),
      heartbeatAt: new Date(0).toISOString(),
    })}\n`,
  );
  assert.equal(retireStaleLockIfNeeded(lockPath, 1), true);
  assert.equal(existsSync(lockPath), false);
  assert.equal(
    readdirSync(root).some((entry) => entry.startsWith("context.lock.retired-")),
    false,
  );
});

test("cleanup cannot delete an index protected by a live owner", async () => {
  const root = temporaryDirectory("context-clean-lock-");
  const indexDirectory = path.join(root, ".context-index");
  const lockPath = path.join(root, ".codex", "runtime", "cache", "context-index-rebuild.lock");
  write(root, ".context-index/sentinel.txt", "live index\n");
  const lease = await acquireRebuildLock(lockPath, { timeoutMs: 500, staleLockMs: 100 });
  const script = path.join(repositoryRoot, "scripts/context/clean-context-index.mjs");
  const result = spawnSync(process.execPath, [script], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CONTEXT_INDEX_TEST_MODE: "1",
      CONTEXT_INDEX_ROOT: root,
      CONTEXT_INDEX_DIRECTORY: indexDirectory,
      CONTEXT_INDEX_LOCK_TIMEOUT_MS: "300",
      CONTEXT_INDEX_STALE_LOCK_MS: "100",
    },
    encoding: "utf8",
    timeout: 2_000,
  });
  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /Timed out acquiring context index rebuild lock/,
  );
  assert.equal(readFileSync(path.join(indexDirectory, "sentinel.txt"), "utf8"), "live index\n");
  assert.equal(releaseRebuildLock(lease), true);
});

const semanticAcceptanceCases = [
  {
    query: "choose checks affected by the current edits",
    text: "Adaptive verification decisions route changed paths to bounded validation owners.",
    path: "scripts/verify/adaptive-runner.mjs",
  },
  {
    query: "keep project policy separate from mutable user state",
    text: "Generated projects keep portable runtime policy separate from mutable user state.",
    path: "scripts/setup/validate-staged-project.mjs",
  },
  {
    query: "prevent two index builders from publishing together",
    text: "Context rebuild lock ownership uses a heartbeat and atomic stale-generation quarantine.",
    path: "scripts/context/context-lock.mjs",
  },
  {
    query: "identify authentication material before preserving revisions",
    text: "Secret-pattern scanning detects private tokens and credential material in active sources.",
    path: "scripts/verify/secret-patterns.mjs",
  },
  {
    query: "clone the starter into a clean sibling and rewrite manifests",
    text: "Project initialization copies portable policy safely and rewrites package metadata for a separate workspace.",
    path: "scripts/setup/initialize-project.mjs",
  },
];

function storageRecord(index, text, filePath = `docs/chunk-${index}.md`) {
  const vector = Array.from({ length: embeddingDimensions }, (_, dimension) =>
    Math.sin((index + 1) * (dimension + 1) * 0.017453292519943295),
  );
  const norm = Math.hypot(...vector);
  for (let dimension = 0; dimension < vector.length; dimension += 1) {
    vector[dimension] /= norm;
  }
  return {
    id: `row-${index}`,
    path: filePath,
    startLine: 1,
    endLine: 3,
    text,
    headingsText: "Scale fixture",
    symbolsText: "",
    importsText: "",
    searchText: `${filePath}\nScale fixture\n${text}`,
    tokenCount: 12,
    contentHash: String(index).padStart(64, "0"),
    embeddingHash: String(index + 1).padStart(64, "0"),
    vector,
  };
}

test("bounded hybrid queries recover five exact targets from a scaled index", async (context) => {
  const root = temporaryDirectory("context-query-scale-");
  const indexDirectory = path.join(root, ".context-index");
  const databasePath = path.join(indexDirectory, "lancedb");
  const manifestPath = path.join(indexDirectory, "manifest.json");
  mkdirSync(indexDirectory);
  const cases = semanticAcceptanceCases;
  const records = Array.from({ length: 1_500 }, (_, index) =>
    storageRecord(index, `Common retrieval fixture ${index} with neutral filler text.`),
  );
  cases.forEach((fixture, index) => {
    records[index] = storageRecord(index, fixture.text, fixture.path);
  });
  const memoryBefore = process.memoryUsage().rss;
  const buildStartedAt = performance.now();
  await publishIndex({
    indexDirectory,
    databasePath,
    manifestPath,
    tableName: "context_chunks",
    records,
    manifest: { stats: { chunks: records.length } },
    vectorIndexThreshold: 1_000,
  });
  const buildMs = Math.round(performance.now() - buildStartedAt);
  const indices = await inspectDatabaseIndices(databasePath, "context_chunks");
  const vectorIndex = indices.find((index) => index.columns?.includes("vector"));
  assert.ok(vectorIndex, "scaled publication should create a vector index");
  assert.equal(Number(vectorIndex.numUnindexedRows ?? 0), 0);
  const databaseInode = statSync(databasePath).ino;
  const queryTimes = [];
  const denseTargetRanks = [];
  let semanticAddedValue = 0;
  const queryPlan = await explainDenseQueryPlan({
    databasePath,
    tableName: "context_chunks",
    vector: records[0].vector,
    limit: 5,
  });
  assert.match(queryPlan, /(?:HNSW|ANN|vector[_ ]index)/i);
  for (const [index, fixture] of cases.entries()) {
    const queryVector = records[index].vector;
    const startedAt = performance.now();
    const candidates = await queryDatabase({
      databasePath,
      tableName: "context_chunks",
      vector: queryVector,
      query: fixture.query,
      denseLimit: 32,
      lexicalLimit: 64,
    });
    queryTimes.push(Math.round(performance.now() - startedAt));
    denseTargetRanks.push(
      candidates.denseResults.findIndex((row) => row.path === fixture.path) + 1,
    );
    assert.ok(candidates.allRows.length <= 96, "lexical transfer must stay bounded");
    const ranked = rankHybridResults({
      denseResults: candidates.denseResults,
      allRows: candidates.allRows,
      query: fixture.query,
      limit: 5,
    });
    assert.ok(
      ranked.some((row) => row.path === fixture.path),
      `${fixture.query} target should rank in the top five (dense rank ${denseTargetRanks.at(-1)})`,
    );
    const lexicalOnly = rankHybridResults({
      denseResults: [],
      allRows: candidates.allRows,
      query: fixture.query,
      limit: 5,
    });
    if (!lexicalOnly.some((row) => row.path === fixture.path)) semanticAddedValue += 1;
  }
  assert.ok(semanticAddedValue > 0, "dense retrieval should add value beyond lexical candidates");

  const replacement = storageRecord(
    0,
    "The new exact replacement phrase is golden estuary boundary.",
    cases[0].path,
  );
  replacement.id = "row-0-replacement";
  replacement.embeddingHash = "f".repeat(64);
  await publishIndex({
    indexDirectory,
    databasePath,
    manifestPath,
    tableName: "context_chunks",
    records: [replacement],
    manifest: { stats: { chunks: records.length } },
    incremental: true,
    replacedPaths: [cases[0].path],
  });
  assert.equal(statSync(databasePath).ino, databaseInode, "incremental publication stays in-place");
  const incrementalIndices = await inspectDatabaseIndices(databasePath, "context_chunks");
  const incrementalVectorIndex = incrementalIndices.find((index) =>
    index.columns?.includes("vector"),
  );
  assert.ok(incrementalVectorIndex);
  assert.ok(Number(incrementalVectorIndex.numUnindexedRows ?? 0) <= 1);
  const updated = await queryDatabase({
    databasePath,
    tableName: "context_chunks",
    vector: records[0].vector,
    query: "golden estuary",
    denseLimit: 32,
    lexicalLimit: 64,
  });
  assert.equal(
    updated.allRows.some((row) => row.id === replacement.id),
    true,
  );
  const removed = await queryDatabase({
    databasePath,
    tableName: "context_chunks",
    vector: records[0].vector,
    query: cases[0].text,
    denseLimit: 32,
    lexicalLimit: 64,
  });
  assert.equal(
    removed.allRows.some((row) => row.id === "row-0"),
    false,
  );

  const compactedManifest = {
    stats: {
      chunks: 200,
      processedChunks: 0,
      databaseModificationOperations: 2,
      vectorIndexEnabled: true,
    },
  };
  await publishIndex({
    indexDirectory,
    databasePath,
    manifestPath,
    tableName: "context_chunks",
    records: [],
    manifest: compactedManifest,
    incremental: true,
    replacedPaths: records.slice(200).map((record) => record.path),
  });
  assert.equal(compactedManifest.stats.databaseIndexOptimized, true);
  assert.equal(compactedManifest.stats.databaseModificationOperations, 0);
  const compacted = await verifyDatabaseStructure({
    databasePath,
    tableName: "context_chunks",
    manifest: compactedManifest,
    embeddingDimensions,
    verifyFingerprint: false,
  });
  assert.equal(compacted.rowCount, 200);

  const rssDeltaMiB = Math.round((process.memoryUsage().rss - memoryBefore) / 1024 / 1024);
  context.diagnostic(
    JSON.stringify({
      rows: records.length,
      buildMs,
      queryTimesMs: queryTimes,
      semanticAddedValueCases: semanticAddedValue,
      denseTargetRanks,
      rssDeltaMiB,
    }),
  );
});

test(
  "warm-offline CLI builds, incrementally refreshes add/change/delete, and repairs a corrupt manifest",
  { timeout: 30_000 },
  async (context) => {
    if (process.env.CONTEXT_TEST_REAL_MODEL !== "1") {
      context.skip("set CONTEXT_TEST_REAL_MODEL=1 to run the pinned-model integration");
      return;
    }
    const sharedModelCache = path.join(repositoryRoot, ".context-index", "model-cache");
    if (!inspectModelArtifacts(sharedModelCache).complete) {
      throw new Error("CONTEXT_TEST_REAL_MODEL=1 requires the pinned local model cache.");
    }
    const root = temporaryDirectory("context-integration-");
    execFileSync("git", ["init", "-q"], { cwd: root });
    write(root, "docs/a.md", "# Alpha\n\nIncremental retrieval alpha.\n");
    write(root, "docs/b.md", "# Beta\n\nThis file will be removed.\n");
    write(
      root,
      "docs/semantic.md",
      "# Permission gate\n\nBefore a command proceeds, policy verifies the caller identity and whether that actor may perform the requested operation.\n",
    );
    write(root, "src/stable.ts", "export const stableRetrieval = true;\n");
    for (const fixture of semanticAcceptanceCases) {
      write(root, fixture.path, `${fixture.text}\n`);
    }
    execFileSync("git", ["add", "-A"], { cwd: root });
    copyTree(sharedModelCache, path.join(root, ".context-index", "model-cache"));
    const env = {
      ...process.env,
      CONTEXT_INDEX_TEST_MODE: "1",
      CONTEXT_INDEX_ROOT: root,
      CONTEXT_INDEX_DIRECTORY: path.join(root, ".context-index"),
      CONTEXT_INDEX_OFFLINE: "1",
      CONTEXT_INDEX_ONNX_THREADS: "1",
    };
    const script = path.join(repositoryRoot, "scripts/context/search-context.mjs");
    const firstStartedAt = performance.now();
    const first = execFileSync(process.execPath, [script, "incremental retrieval alpha"], {
      cwd: repositoryRoot,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    const firstWallMs = Math.round(performance.now() - firstStartedAt);
    assert.match(first, /Context index refreshed/);
    assert.match(first, /Results:/);
    assert.equal(first.includes(root), false);
    const manifestPath = path.join(root, ".context-index", "manifest.json");
    const firstManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const semantic = execFileSync(
      process.execPath,
      [script, "authorization boundary", "--limit=1"],
      {
        cwd: repositoryRoot,
        env,
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    assert.match(semantic, /docs\/semantic\.md/);
    assert.doesNotMatch(semantic, /Context index refreshed/);
    const semanticRanks = [];
    for (const fixture of semanticAcceptanceCases) {
      const output = execFileSync(process.execPath, [script, fixture.query, "--limit=5"], {
        cwd: repositoryRoot,
        env,
        encoding: "utf8",
        timeout: 30_000,
      });
      const escapedPath = fixture.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = output.match(new RegExp(`^([1-5])\\. ${escapedPath}:`, "m"));
      assert.ok(match, `${fixture.path} should rank in the pinned model's top five`);
      semanticRanks.push(Number(match[1]));
    }

    write(root, "docs/a.md", "# Alpha\n\nIncremental retrieval alpha changed.\n");
    rmSync(path.join(root, "docs/b.md"));
    write(root, "docs/c.md", "# Gamma\n\nNew exact retrieval phrase.\n");
    const secondStartedAt = performance.now();
    const second = execFileSync(process.execPath, [script, "new exact retrieval phrase"], {
      cwd: repositoryRoot,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    const secondWallMs = Math.round(performance.now() - secondStartedAt);
    assert.match(second, /Context index refreshed/);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.ok(manifest.stats.reusedChunks > 0);
    assert.equal(manifest.stats.addedFiles, 1);
    assert.equal(manifest.stats.changedFiles, 1);
    assert.equal(manifest.stats.removedFiles, 1);
    assert.match(second, /docs\/c\.md/);

    const warmWallMs = [];
    for (let run = 0; run < 5; run += 1) {
      const warmStartedAt = performance.now();
      const warm = execFileSync(process.execPath, [script, "new exact retrieval phrase"], {
        cwd: repositoryRoot,
        env,
        encoding: "utf8",
        timeout: 30_000,
      });
      warmWallMs.push(Math.round(performance.now() - warmStartedAt));
      assert.doesNotMatch(warm, /Context index refreshed/);
      assert.match(warm, /docs\/c\.md/);
    }

    const lancedb = await import("@lancedb/lancedb");
    const databasePath = path.join(root, ".context-index", "lancedb");
    let db = await lancedb.connect(databasePath);
    let table = await db.openTable("context_chunks");
    const versionBeforeTouch = await table.version();
    await db.close();
    const databaseInodeBeforeTouch = statSync(databasePath).ino;
    const stablePath = path.join(root, "src/stable.ts");
    const future = new Date(Date.now() + 2_000);
    utimesSync(stablePath, future, future);
    const metadataRefresh = execFileSync(process.execPath, [script, "stable retrieval"], {
      cwd: repositoryRoot,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.match(metadataRefresh, /source metadata changed/);
    const metadataManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(metadataManifest.stats.databaseMode, "manifest-only");
    assert.equal(metadataManifest.stats.embeddedChunks, 0);
    assert.equal(metadataManifest.stats.metadataRefreshedFiles, 1);
    assert.equal(
      metadataManifest.stats.databaseModificationOperations,
      manifest.stats.databaseModificationOperations,
    );
    assert.equal(metadataManifest.stats.vectorIndexEnabled, manifest.stats.vectorIndexEnabled);
    assert.equal("durationMs" in metadataManifest.stats, false);
    assert.equal(statSync(databasePath).ino, databaseInodeBeforeTouch);
    db = await lancedb.connect(databasePath);
    table = await db.openTable("context_chunks");
    assert.equal(await table.version(), versionBeforeTouch);
    await db.close();

    write(
      path.join(root, ".context-index"),
      "database-repair-required.json",
      '{"version":1,"reason":"test fixture"}\n',
    );
    const checkScript = path.join(repositoryRoot, "scripts/context/check-context-index.mjs");
    const repairStatus = spawnSync(
      process.execPath,
      [checkScript, "--no-repair", "--status-only"],
      { cwd: repositoryRoot, env, encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(repairStatus.status, 1);
    assert.match(`${repairStatus.stdout}${repairStatus.stderr}`, /full database repair required/);
    const markerRepair = execFileSync(process.execPath, [script, "stable retrieval"], {
      cwd: repositoryRoot,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.match(markerRepair, /Context index refreshed/);
    assert.equal(
      existsSync(path.join(root, ".context-index", "database-repair-required.json")),
      false,
    );

    writeFileSync(manifestPath, '{"schemaVersion": 8, "files": {}}\n', "utf8");
    const repairStartedAt = performance.now();
    const repaired = execFileSync(process.execPath, [script, "stable retrieval"], {
      cwd: repositoryRoot,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    const repairWallMs = Math.round(performance.now() - repairStartedAt);
    assert.match(repaired, /invalid:/);
    assert.equal(validateManifest(JSON.parse(readFileSync(manifestPath, "utf8"))).valid, true);
    context.diagnostic(
      JSON.stringify({
        firstWallMs,
        firstBuild: firstManifest.stats,
        incrementalWallMs: secondWallMs,
        incrementalBuild: manifest.stats,
        warmSearchWallMs: warmWallMs,
        semanticRanks,
        metadataOnlyDatabaseVersion: versionBeforeTouch,
        corruptRepairWallMs: repairWallMs,
      }),
    );
  },
);

test(
  "cold-offline CLI failure preserves source and publishes no partial index",
  { timeout: 10_000 },
  () => {
    const root = temporaryDirectory("context-cold-offline-");
    execFileSync("git", ["init", "-q"], { cwd: root });
    write(root, "README.md", "# Offline fixture\n");
    execFileSync("git", ["add", "README.md"], { cwd: root });
    const script = path.join(repositoryRoot, "scripts/context/search-context.mjs");
    const result = spawnSync(process.execPath, [script, "offline fixture"], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CONTEXT_INDEX_TEST_MODE: "1",
        CONTEXT_INDEX_ROOT: root,
        CONTEXT_INDEX_DIRECTORY: path.join(root, ".context-index"),
        CONTEXT_INDEX_OFFLINE: "1",
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 1);
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /Offline context retrieval requires the pinned model cache/);
    assert.equal(output.includes(root), false);
    assert.equal(existsSync(path.join(root, ".context-index", "manifest.json")), false);
    assert.equal(existsSync(path.join(root, ".context-index", "lancedb")), false);
    assert.equal(readFileSync(path.join(root, "README.md"), "utf8"), "# Offline fixture\n");
  },
);
