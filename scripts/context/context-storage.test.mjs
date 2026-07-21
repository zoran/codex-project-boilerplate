import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRecordBatches } from "./context-build.mjs";
import {
  embeddingDimensions,
  inspectModelArtifacts,
  requiredModelArtifactPaths,
  resolveModelLocation,
} from "./context-embedding.mjs";
import { hashContent } from "./context-hashing.mjs";
import {
  chunkFingerprint,
  loadManifestState,
  schemaVersion,
  validateManifest,
} from "./context-manifest.mjs";
import {
  cleanupGeneratedIndexDebris,
  explainFilterQueryPlan,
  fingerprintReadBatchSize,
  inspectDatabaseIndices,
  loadReusableRows,
  publishIndex,
  queryDatabase,
  recoverIndexTransaction,
  verifyDatabaseStructure,
} from "./context-storage.mjs";
import { storageRecord, temporaryDirectory, write } from "./context-regression-helpers.mjs";

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
    manifest: { stats: { chunks: records.length }, chunkFingerprint: chunkFingerprint(records) },
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

test("full replacement reports cleanup of the previous selected generation", async () => {
  const root = temporaryDirectory("context-full-maintenance-summary-");
  const indexDirectory = path.join(root, ".context-index");
  const databasePath = path.join(indexDirectory, "lancedb");
  const manifestPath = path.join(indexDirectory, "manifest.json");
  mkdirSync(indexDirectory);
  const firstManifest = {
    stats: {
      chunks: 1,
      databaseModificationOperations: 8,
      databaseModificationAffectedRows: 21,
      databaseIndexComplete: false,
    },
    chunkFingerprint: chunkFingerprint([storageRecord(0, "first generation")]),
  };
  await publishIndex({
    indexDirectory,
    databasePath,
    manifestPath,
    tableName: "context_chunks",
    records: [storageRecord(0, "first generation")],
    manifest: firstManifest,
  });

  const replacementManifest = {
    stats: {
      chunks: 1,
      databaseModificationOperations: 20,
      databaseModificationAffectedRows: 100_000,
      databaseIndexComplete: false,
    },
    chunkFingerprint: chunkFingerprint([storageRecord(1, "replacement generation")]),
  };
  const replacement = await publishIndex({
    indexDirectory,
    databasePath,
    manifestPath,
    tableName: "context_chunks",
    records: [storageRecord(1, "replacement generation")],
    manifest: replacementManifest,
  });

  assert.equal(replacement.generationReplaced, true);
  assert.equal(replacementManifest.stats.databaseModificationOperations, 0);
  assert.equal(replacementManifest.stats.databaseModificationAffectedRows, 0);
  assert.equal(replacementManifest.stats.databaseIndexComplete, true);
  assert.equal(replacement.maintenance.removedDatabaseGenerations, 1);
  assert.equal(replacement.maintenance.removedManifestGenerations, 1);
  assert.deepEqual(
    (
      await queryDatabase({
        databasePath,
        tableName: "context_chunks",
        vector: storageRecord(1, "replacement generation").vector,
        query: "replacement generation",
        denseLimit: 4,
        lexicalLimit: 4,
      })
    ).denseResults.map((row) => row.id),
    ["row-1"],
  );
  const indices = await inspectDatabaseIndices(databasePath, "context_chunks");
  for (const column of ["embeddingHash", "id", "path", "searchText"]) {
    assert.equal(
      indices.some((index) => index.columns?.includes(column)),
      true,
      column,
    );
  }
  const lancedb = await import("@lancedb/lancedb");
  let db = await lancedb.connect(databasePath);
  let table = await db.openTable("context_chunks");
  const versionBeforeMaintenance = await table.version();
  await db.close();
  cleanupGeneratedIndexDebris(indexDirectory);
  db = await lancedb.connect(databasePath);
  table = await db.openTable("context_chunks");
  assert.equal(await table.version(), versionBeforeMaintenance);
  await db.close();
});

test("failed generation switching restores the complete previous selected pair", async () => {
  const root = temporaryDirectory("context-full-switch-rollback-");
  const indexDirectory = path.join(root, ".context-index");
  const databasePath = path.join(indexDirectory, "lancedb");
  const manifestPath = path.join(indexDirectory, "manifest.json");
  mkdirSync(indexDirectory);
  const previousRecord = storageRecord(0, "previous selected generation");
  await publishIndex({
    indexDirectory,
    databasePath,
    manifestPath,
    tableName: "context_chunks",
    records: [previousRecord],
    manifest: {
      stats: { chunks: 1 },
      chunkFingerprint: chunkFingerprint([previousRecord]),
    },
  });
  const previousManifest = readFileSync(manifestPath, "utf8");
  const candidateRecord = storageRecord(1, "candidate generation");
  await assert.rejects(
    publishIndex({
      indexDirectory,
      databasePath,
      manifestPath,
      tableName: "context_chunks",
      records: [candidateRecord],
      manifest: {
        stats: { chunks: 1 },
        chunkFingerprint: chunkFingerprint([candidateRecord]),
      },
      testHooks: {
        afterCandidateDatabasePublished() {
          throw new Error("interrupted after candidate database publication");
        },
      },
    }),
    /interrupted after candidate database publication/,
  );
  assert.equal(readFileSync(manifestPath, "utf8"), previousManifest);
  const selected = await queryDatabase({
    databasePath,
    tableName: "context_chunks",
    vector: previousRecord.vector,
    query: "previous selected generation",
    denseLimit: 4,
    lexicalLimit: 4,
  });
  assert.equal(selected.denseResults[0].id, previousRecord.id);
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
  const metadataManifest = {
    stats: {
      chunks: records.length,
      databaseModificationOperations: 7,
      databaseModificationAffectedRows: 19,
      databaseIndexComplete: false,
      vectorIndexEnabled: false,
    },
    metadataOnly: true,
  };
  await publishIndex({
    indexDirectory,
    databasePath,
    manifestPath,
    tableName: "context_chunks",
    records,
    manifest: { stats: { chunks: records.length }, chunkFingerprint: chunkFingerprint(records) },
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
    manifest: metadataManifest,
    incremental: true,
    manifestOnly: true,
  });
  assert.equal(await table.version(), beforeVersion);
  assert.equal(statSync(databasePath).ino, databaseInode);
  assert.equal(metadataManifest.stats.databaseModificationOperations, 7);
  assert.equal(metadataManifest.stats.databaseModificationAffectedRows, 19);
  assert.equal(metadataManifest.stats.databaseIndexComplete, false);
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
    manifest: { stats: { chunks: records.length }, chunkFingerprint: chunkFingerprint(records) },
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
    manifest: { stats: { chunks: 1 }, chunkFingerprint: chunkFingerprint([original]) },
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
