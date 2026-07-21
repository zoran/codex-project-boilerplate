import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  embeddingRuntimeIdentity,
  inspectModelArtifacts,
  modelRevisionDirectory,
  requiredModelArtifactPaths,
} from "./context-embedding.mjs";
import { createManifest } from "./context-manifest.mjs";
import { ensureOwnedIndexDirectory } from "./context-paths.mjs";
import { runSearch } from "./search-context.mjs";
import { discoverSourceFiles } from "./source-policy.mjs";
import { publishIndex } from "./context-storage.mjs";
import {
  repositoryRoot,
  storageRecord,
  temporaryDirectory,
  write,
} from "./context-regression-helpers.mjs";

function environmentSnapshot(names) {
  return new Map(names.map((name) => [name, process.env[name]]));
}

function restoreEnvironment(snapshot) {
  for (const [name, value] of snapshot) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function treeSnapshot(root) {
  const snapshot = [];
  const pending = [{ absolutePath: root, relativePath: "" }];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current.absolutePath, { withFileTypes: true })) {
      const relativePath = current.relativePath
        ? `${current.relativePath}/${entry.name}`
        : entry.name;
      const absolutePath = path.join(current.absolutePath, entry.name);
      const stats = lstatSync(absolutePath, { bigint: true });
      const record = {
        path: relativePath,
        type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
        bytes: stats.size.toString(),
        modified: stats.mtimeNs.toString(),
        changed: stats.ctimeNs.toString(),
      };
      if (entry.isDirectory()) pending.push({ absolutePath, relativePath });
      else if (entry.isFile()) {
        record.hash = createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
      }
      snapshot.push(record);
    }
  }
  return snapshot.sort((left, right) => left.path.localeCompare(right.path));
}

async function currentIndexFixture() {
  const root = temporaryDirectory("context-read-only-status-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  write(root, "README.md", "# Read-only status fixture\n");
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
  const [{ content: _content, ...sourceFile }] = discovered.files;
  const chunk = { id: "status-fixture-chunk", embeddingHash: "a".repeat(64) };
  const files = [{ ...sourceFile, headings: [], symbols: [], imports: [], chunks: [chunk] }];
  const manifest = createManifest({
    files,
    skippedFiles: discovered.skipped,
    excludedFiles: discovered.excluded,
    chunks: [chunk],
    modelArtifacts: inspectModelArtifacts(modelCachePath, { includeHash: true }),
    runtimeIdentity: embeddingRuntimeIdentity(),
    sourceMode: discovered.sourceMode,
    buildStats: {
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
  await publishIndex({
    indexDirectory,
    databasePath,
    manifestPath,
    tableName: "context_chunks",
    records: [
      {
        ...storageRecord(0, "Read-only status fixture", sourceFile.path),
        id: chunk.id,
        contentHash: sourceFile.hash,
        embeddingHash: chunk.embeddingHash,
      },
    ],
    manifest,
  });
  return { databasePath, indexDirectory, manifestPath, root };
}

test("high-level semantic search performs maintenance before its bounded query", async () => {
  const root = temporaryDirectory("context-search-maintenance-");
  const indexDirectory = path.join(root, ".context-index");
  ensureOwnedIndexDirectory({ repositoryRoot: root, indexDirectory });
  mkdirSync(path.join(indexDirectory, "lancedb", "context_chunks.lance"), { recursive: true });
  const staleCandidate = path.join(indexDirectory, "manifest.next-49.json");
  writeFileSync(staleCandidate, "stale candidate\n");
  const environment = environmentSnapshot([
    "CONTEXT_INDEX_DIRECTORY",
    "CONTEXT_INDEX_ROOT",
    "CONTEXT_INDEX_TEST_MODE",
  ]);
  process.env.CONTEXT_INDEX_TEST_MODE = "1";
  process.env.CONTEXT_INDEX_ROOT = root;
  process.env.CONTEXT_INDEX_DIRECTORY = indexDirectory;
  try {
    const libraryUrl = new URL("./context-index-lib.mjs", import.meta.url);
    libraryUrl.searchParams.set("fixture", `${Date.now()}-${Math.random()}`);
    const library = await import(libraryUrl.href);
    const row = {
      id: "maintenance-result",
      path: "docs/maintenance.md",
      startLine: 1,
      endLine: 2,
      text: "Maintenance runs before semantic retrieval.",
      headingsText: "Maintenance",
      symbolsText: "",
      importsText: "",
      _distance: 0.1,
    };
    const results = await library.searchIndex("maintenance retrieval", {
      limit: 1,
      embedQuery: async () => [[1, 0, 0]],
      querySelectedDatabase: async () => {
        assert.equal(existsSync(staleCandidate), false);
        return { denseResults: [row], allRows: [row] };
      },
    });
    assert.equal(results[0].path, row.path);
    assert.equal(existsSync(staleCandidate), false);
    assert.equal(existsSync(path.join(indexDirectory, "model-cache")), false);
  } finally {
    restoreEnvironment(environment);
  }
});

test("search command reports one sanitized maintenance summary and preserves results", async () => {
  const output = [];
  const originalLog = console.log;
  console.log = (...values) => output.push(values.join(" "));
  try {
    const row = { id: "result", path: "docs/result.md", text: "result" };
    const result = await runSearch(
      { query: "bounded result", limit: 1, retry: true },
      {
        describeBuildStats: () => "unused",
        describeFreshness: () => "current",
        describeMaintenance: () => "removed 1 validated stale artifact(s)",
        ensureFreshIndex: async () => ({
          manifest: {},
          freshness: { fresh: true },
          initialFreshness: { reason: "current" },
          rebuilt: false,
          maintenance: { removedManifestGenerations: 1 },
        }),
        forceRepairIndex: () => assert.fail("fresh search must not repair"),
        maintenanceChanged: () => true,
        searchIndex: async (_query, options) => {
          assert.equal(options.maintenance, false);
          return [row];
        },
      },
    );
    assert.deepEqual(result.results, [row]);
    assert.deepEqual(output, ["Context index maintenance: removed 1 validated stale artifact(s)"]);
  } finally {
    console.log = originalLog;
  }
});

test("search never downgrades a database path safety failure to corruption repair", async () => {
  class FixtureDatabaseSafetyError extends Error {}
  const failure = new FixtureDatabaseSafetyError("unsafe selected database path");
  await assert.rejects(
    runSearch(
      { query: "safe boundary", limit: 1, retry: true },
      {
        ContextDatabaseSafetyError: FixtureDatabaseSafetyError,
        ensureFreshIndex: async () => ({
          manifest: { stats: { chunks: 1 } },
          freshness: { fresh: true },
          rebuilt: false,
          maintenance: {},
        }),
        searchIndex: async () => {
          throw failure;
        },
        forceRepairIndex: () => assert.fail("safety errors must not trigger database repair"),
        maintenanceChanged: () => false,
      },
    ),
    (error) => error === failure,
  );
});

test("every context check mode preserves a valid database and transaction journal", async () => {
  const fixture = await currentIndexFixture();
  const lancedb = await import("@lancedb/lancedb");
  let database = await lancedb.connect(fixture.databasePath);
  let table = await database.openTable("context_chunks");
  const selectedVersion = await table.version();
  await database.close();
  const journalPath = path.join(fixture.indexDirectory, "database-transaction.json");
  write(
    fixture.indexDirectory,
    "database-transaction.json",
    `${JSON.stringify({
      version: 1,
      beforeVersion: selectedVersion,
      targetManifestHash: "f".repeat(64),
      createdAt: new Date().toISOString(),
    })}\n`,
  );
  const beforeTree = treeSnapshot(fixture.indexDirectory);
  const beforeManifest = readFileSync(fixture.manifestPath);
  const beforeJournal = readFileSync(journalPath);
  const checkScript = path.join(repositoryRoot, "scripts/context/check-context-index.mjs");
  for (const args of [[], ["--no-repair"], ["--status-only"], ["--no-repair", "--status-only"]]) {
    const result = spawnSync(process.execPath, [checkScript, ...args], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CONTEXT_INDEX_TEST_MODE: "1",
        CONTEXT_INDEX_ROOT: fixture.root,
        CONTEXT_INDEX_DIRECTORY: fixture.indexDirectory,
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /interrupted context index state requires maintenance/);
    assert.deepEqual(readFileSync(fixture.manifestPath), beforeManifest);
    assert.deepEqual(readFileSync(journalPath), beforeJournal);
    assert.deepEqual(treeSnapshot(fixture.indexDirectory), beforeTree);
    assert.equal(existsSync(path.join(fixture.root, ".codex", "runtime")), false);
    database = await lancedb.connect(fixture.databasePath);
    table = await database.openTable("context_chunks");
    assert.equal(await table.version(), selectedVersion);
    await database.close();
  }
});
