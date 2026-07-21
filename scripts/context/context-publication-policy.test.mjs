import assert from "node:assert/strict";
import test from "node:test";
import { createManifest, validateManifest } from "./context-manifest.mjs";
import {
  databaseGenerationReplacementRequired,
  databaseReplacementAffectedRowThreshold,
  databaseReplacementOperationThreshold,
} from "./context-publication-policy.mjs";

test("manifest schema validates publication counters and complete-index state", () => {
  const chunk = { id: "manifest-chunk", embeddingHash: "a".repeat(64) };
  const manifest = createManifest({
    files: [
      {
        path: "README.md",
        hash: "b".repeat(64),
        statSignature: "c".repeat(64),
        bytes: 10,
        lineCount: 1,
        headings: [],
        symbols: [],
        imports: [],
        chunks: [chunk],
      },
    ],
    skippedFiles: [],
    excludedFiles: [],
    chunks: [chunk],
    modelArtifacts: { hash: "d".repeat(64), signature: "model", files: [] },
    runtimeIdentity: { fingerprint: "runtime" },
    sourceMode: "git-tracked",
    buildStats: {
      databaseModificationOperations: 0,
      databaseModificationAffectedRows: 0,
      databaseIndexComplete: true,
      vectorIndexEnabled: false,
    },
    databasePath: ".context-index/lancedb",
    tableName: "context_chunks",
  });
  assert.equal(validateManifest(manifest).valid, true);
  for (const [field, value] of [
    ["databaseModificationOperations", -1],
    ["databaseModificationAffectedRows", -1],
    ["databaseIndexComplete", "true"],
    ["vectorIndexEnabled", 1],
  ]) {
    assert.equal(
      validateManifest({ ...manifest, stats: { ...manifest.stats, [field]: value } }).valid,
      false,
      field,
    );
  }
});

test("database replacement thresholds include an anticipated source publication", () => {
  const below = {
    stats: {
      databaseModificationOperations: databaseReplacementOperationThreshold - 1,
      databaseModificationAffectedRows: databaseReplacementAffectedRowThreshold - 1,
    },
  };
  assert.equal(databaseGenerationReplacementRequired(below), false);
  assert.equal(databaseGenerationReplacementRequired(below, { additionalOperations: 1 }), true);
  assert.equal(databaseGenerationReplacementRequired(below, { additionalAffectedRows: 1 }), true);
  assert.equal(
    databaseGenerationReplacementRequired({
      stats: {
        databaseModificationOperations: databaseReplacementOperationThreshold,
        databaseModificationAffectedRows: 0,
      },
    }),
    true,
  );
  assert.equal(
    databaseGenerationReplacementRequired({
      stats: {
        databaseModificationOperations: 0,
        databaseModificationAffectedRows: databaseReplacementAffectedRowThreshold,
      },
    }),
    true,
  );
});
