import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { chunkContent, extractMetadata } from "./context-chunks.mjs";
import { compareManifest, sourceChanges } from "./context-manifest.mjs";
import { rankHybridResults } from "./context-ranking.mjs";
import {
  createRecordBatches,
  incrementalAffectedRowCount,
  resolveChunkVectors,
} from "./context-build.mjs";
import { indexedContentImplementationFiles } from "./context-embedding.mjs";
import { queryReusableRowsInBatches, reusableLookupBatchSize } from "./context-storage.mjs";
import { temporaryDirectory, write } from "./context-regression-helpers.mjs";

test("the context runtime fingerprint covers every extracted storage owner", () => {
  assert.equal(Object.isFrozen(indexedContentImplementationFiles), true);
  assert.ok(indexedContentImplementationFiles.includes("context-storage.mjs"));
  assert.ok(indexedContentImplementationFiles.includes("context-database.mjs"));
});

test("classification-only changes require a manifest refresh without a content rebuild", () => {
  const root = temporaryDirectory("context-classification-change-");
  const databasePath = path.join(root, "lancedb");
  const tablePath = path.join(databasePath, "context_chunks.lance");
  write(root, "lancedb/context_chunks.lance/sentinel", "database fixture\n");
  const manifest = {
    files: [],
    skippedFiles: [],
    excludedFiles: [],
    runtimeIdentity: { fingerprint: "runtime" },
    modelArtifacts: { signature: "model" },
    sourcePolicy: { sourceMode: "git-tracked-plus-untracked" },
  };
  const freshness = compareManifest({
    manifestState: { manifest, reason: "" },
    databasePath,
    tablePath,
    runtimeIdentity: manifest.runtimeIdentity,
    modelArtifacts: { complete: true, signature: "model" },
    currentSources: {
      files: [],
      skipped: [],
      excluded: [{ path: "src/app.min.js", reason: "minified artifact" }],
      sourceMode: "git-tracked-plus-untracked",
    },
  });
  assert.equal(freshness.fresh, false);
  assert.equal(freshness.reason, "source classification changed");
  assert.equal(freshness.classificationsChanged, true);
});

test("incremental affected-row accounting includes added, replaced, and deleted chunks", () => {
  const previousFiles = [
    { path: "change.md", chunks: [{}, {}] },
    { path: "delete.md", chunks: [{}, {}, {}] },
  ];
  const changes = {
    missing: ["add.md"],
    changed: ["change.md"],
    removed: ["delete.md"],
  };
  assert.equal(incrementalAffectedRowCount(previousFiles, changes, 6), 11);
  assert.equal(
    incrementalAffectedRowCount(previousFiles, { missing: [], changed: [], removed: [] }, 0),
    0,
  );
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
