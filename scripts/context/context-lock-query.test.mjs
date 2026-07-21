import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  embeddingDimensions,
  embeddingRuntimeIdentity,
  inspectModelArtifacts,
  modelRevisionDirectory,
  requiredModelArtifactPaths,
} from "./context-embedding.mjs";
import {
  acquireRebuildLock,
  readLockOwner,
  releaseRebuildLock,
  retireStaleLockIfNeeded,
} from "./context-lock.mjs";
import { chunkFingerprint, createManifest } from "./context-manifest.mjs";
import { ensureOwnedIndexDirectory } from "./context-paths.mjs";
import { rankHybridResults } from "./context-ranking.mjs";
import { discoverSourceFiles } from "./source-policy.mjs";
import {
  explainDenseQueryPlan,
  inspectDatabaseIndices,
  publishIndex,
  queryDatabase,
  verifyDatabaseStructure,
} from "./context-storage.mjs";
import {
  repositoryRoot,
  storageRecord,
  temporaryDirectory,
  write,
} from "./context-regression-helpers.mjs";

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

test("an already-current explicit index operation still performs safe maintenance", async () => {
  const root = temporaryDirectory("context-current-maintenance-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  write(root, "README.md", "# Current context fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });

  const indexDirectory = path.join(root, ".context-index");
  const databasePath = path.join(indexDirectory, "lancedb");
  const manifestPath = path.join(indexDirectory, "manifest.json");
  const modelCachePath = path.join(indexDirectory, "model-cache");
  ensureOwnedIndexDirectory({ repositoryRoot: root, indexDirectory });
  const selectedModelDirectory = modelRevisionDirectory(modelCachePath);
  for (const artifactPath of requiredModelArtifactPaths) {
    write(selectedModelDirectory, artifactPath, `fixture ${artifactPath}\n`);
  }

  const discovered = discoverSourceFiles({ repositoryRoot: root });
  assert.equal(discovered.files.length, 1);
  const [{ content: _content, ...sourceFile }] = discovered.files;
  const chunk = { id: "current-fixture-chunk", embeddingHash: "a".repeat(64) };
  const files = [
    {
      ...sourceFile,
      headings: [],
      symbols: [],
      imports: [],
      chunks: [chunk],
    },
  ];
  const modelArtifacts = inspectModelArtifacts(modelCachePath, { includeHash: true });
  const manifest = createManifest({
    files,
    skippedFiles: discovered.skipped,
    excludedFiles: discovered.excluded,
    chunks: [chunk],
    modelArtifacts,
    runtimeIdentity: embeddingRuntimeIdentity(),
    sourceMode: discovered.sourceMode,
    buildStats: {
      durationMs: 0,
      reusedChunks: 0,
      embeddedChunks: 1,
      embeddedVectors: 1,
      addedFiles: 1,
      changedFiles: 0,
      removedFiles: 0,
      processedFiles: 1,
      databaseModificationOperations: 0,
    },
    databasePath: ".context-index/lancedb",
    tableName: "context_chunks",
  });
  const record = {
    ...storageRecord(0, "Current context fixture", sourceFile.path),
    id: chunk.id,
    contentHash: sourceFile.hash,
    embeddingHash: chunk.embeddingHash,
  };
  await publishIndex({
    indexDirectory,
    databasePath,
    manifestPath,
    tableName: "context_chunks",
    records: [record],
    manifest,
  });

  const staleManifest = path.join(indexDirectory, "manifest.next-50.json");
  writeFileSync(staleManifest, "stale candidate\n");
  const libraryUrl = new URL("./context-index-lib.mjs", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const library = await import(${JSON.stringify(libraryUrl)}); const result = await library.buildIndex(); console.log(JSON.stringify({ databaseMode: result.buildStats.databaseMode, maintenance: result.maintenance }));`,
    ],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CONTEXT_INDEX_TEST_MODE: "1",
        CONTEXT_INDEX_ROOT: root,
        CONTEXT_INDEX_DIRECTORY: indexDirectory,
        CONTEXT_INDEX_OFFLINE: "1",
      },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const lifecycle = JSON.parse(result.stdout.trim());
  assert.equal(lifecycle.databaseMode, "unchanged");
  assert.equal(lifecycle.maintenance.removedManifestGenerations, 1);
  assert.equal(existsSync(staleManifest), false);
  assert.equal(existsSync(databasePath), true);
  assert.equal(existsSync(manifestPath), true);
  assert.equal(existsSync(selectedModelDirectory), true);
});

const semanticAcceptanceCases = [
  {
    query: "choose checks affected by the current edits",
    text: "Adaptive verification decisions route changed paths to bounded validation owners.",
    path: "scripts/verify/adaptive-runner.mjs",
  },
  {
    query: "keep portable project policy separate from mutable repository runtime",
    text: "Generated projects keep portable policy separate from mutable repository-root runtime.",
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
    manifest: {
      stats: { chunks: records.length },
      chunkFingerprint: chunkFingerprint(records),
    },
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

  const logicallyReducedManifest = {
    stats: {
      chunks: 200,
      databaseModificationOperations: 2,
      databaseModificationAffectedRows: 1_301,
      databaseIndexComplete: false,
      vectorIndexEnabled: true,
    },
  };
  const lancedb = await import("@lancedb/lancedb");
  let selectedDb = await lancedb.connect(databasePath);
  let selectedTable = await selectedDb.openTable("context_chunks");
  const versionBeforeReduction = await selectedTable.version();
  await selectedDb.close();
  const reduction = await publishIndex({
    indexDirectory,
    databasePath,
    manifestPath,
    tableName: "context_chunks",
    records: [],
    manifest: logicallyReducedManifest,
    incremental: true,
    replacedPaths: records.slice(200).map((record) => record.path),
  });
  assert.equal(reduction.generationReplaced, false);
  assert.equal(logicallyReducedManifest.stats.databaseModificationOperations, 2);
  assert.equal(logicallyReducedManifest.stats.databaseModificationAffectedRows, 1_301);
  assert.equal(logicallyReducedManifest.stats.databaseIndexComplete, false);
  assert.equal(statSync(databasePath).ino, databaseInode);
  selectedDb = await lancedb.connect(databasePath);
  selectedTable = await selectedDb.openTable("context_chunks");
  assert.ok((await selectedTable.version()) > versionBeforeReduction);
  await selectedDb.close();
  const logicallyReduced = await verifyDatabaseStructure({
    databasePath,
    tableName: "context_chunks",
    manifest: logicallyReducedManifest,
    embeddingDimensions,
    verifyFingerprint: false,
  });
  assert.equal(logicallyReduced.rowCount, 200);

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
