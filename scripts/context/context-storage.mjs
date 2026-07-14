import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { hashContent } from "./context-hashing.mjs";
import { createChunkFingerprintAccumulator } from "./context-manifest.mjs";

if (!process.env.RUST_LOG) process.env.RUST_LOG = "error";

let lancedbPromise;
export const defaultVectorIndexThreshold = 1_000;
export const reusableLookupBatchSize = 200;
export const fingerprintReadBatchSize = 512;
const transactionFileName = "database-transaction.json";
const repairMarkerFileName = "database-repair-required.json";

function transactionPathFor(indexDirectory) {
  return path.join(indexDirectory, transactionFileName);
}

function repairMarkerPathFor(indexDirectory) {
  return path.join(indexDirectory, repairMarkerFileName);
}

export function cleanupGeneratedIndexDebris(indexDirectory) {
  if (!existsSync(indexDirectory)) return;
  const entries = readdirSync(indexDirectory, { withFileTypes: true });
  const canonicalDatabase = path.join(indexDirectory, "lancedb");
  const canonicalManifest = path.join(indexDirectory, "manifest.json");

  if (!existsSync(canonicalDatabase) || !existsSync(canonicalManifest)) {
    const groups = new Map();
    for (const entry of entries) {
      const match =
        entry.name.match(/^(lancedb)\.(next|previous)-(.+)$/) ??
        entry.name.match(/^(manifest)\.(next|previous)-(.+)\.json$/);
      if (!match) continue;
      const [, kind, generation, suffix] = match;
      if (
        (kind === "lancedb" && !entry.isDirectory()) ||
        (kind === "manifest" && !entry.isFile())
      ) {
        continue;
      }
      const group = groups.get(suffix) ?? { suffix, modifiedAt: 0 };
      group[`${kind}.${generation}`] = path.join(indexDirectory, entry.name);
      group.modifiedAt = Math.max(
        group.modifiedAt,
        statSync(path.join(indexDirectory, entry.name)).mtimeMs,
      );
      groups.set(suffix, group);
    }
    const recovery = [...groups.values()]
      .filter((group) => group["lancedb.previous"] || group["manifest.previous"])
      .sort((left, right) => right.modifiedAt - left.modifiedAt)[0];
    if (recovery) {
      const previousDatabase = recovery["lancedb.previous"];
      const previousManifest = recovery["manifest.previous"];
      if (existsSync(canonicalDatabase) && !existsSync(canonicalManifest) && previousDatabase) {
        rmSync(canonicalDatabase, { recursive: true, force: true });
      }
      if (!existsSync(canonicalDatabase) && previousDatabase) {
        renameSync(previousDatabase, canonicalDatabase);
      }
      if (!existsSync(canonicalManifest) && previousManifest) {
        renameSync(previousManifest, canonicalManifest);
      }
    }
  }

  for (const entry of readdirSync(indexDirectory, { withFileTypes: true })) {
    if (!/^(?:lancedb|manifest)\.(?:next|previous)-/.test(entry.name)) continue;
    rmSync(path.join(indexDirectory, entry.name), { recursive: entry.isDirectory(), force: true });
  }
}

async function getLanceDb() {
  lancedbPromise ??= import("@lancedb/lancedb");
  return lancedbPromise;
}

async function withDatabase(databasePath, action) {
  if (existsSync(databasePath)) {
    const stats = lstatSync(databasePath);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("Context database path is not a non-symlink directory.");
    }
  }
  const lancedb = await getLanceDb();
  const db = await lancedb.connect(databasePath);
  try {
    const stats = lstatSync(databasePath);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("Context database path changed to an unsafe location.");
    }
    return await action(db);
  } finally {
    await db.close();
  }
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function batches(values, size = 200) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

export async function queryReusableRowsInBatches(
  table,
  candidates,
  { databaseVersion, diagnostics, batchSize = reusableLookupBatchSize } = {},
) {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error("Reusable context lookup batch size must be a positive integer.");
  }
  if (Number.isInteger(databaseVersion)) await table.checkout(databaseVersion);
  const rowsByHash = new Map();
  const candidateByHash = new Map();
  for (const candidate of candidates) {
    if (
      typeof candidate?.id === "string" &&
      candidate.id.length > 0 &&
      typeof candidate.embeddingHash === "string" &&
      !candidateByHash.has(candidate.embeddingHash)
    ) {
      candidateByHash.set(candidate.embeddingHash, candidate);
    }
  }
  for (const group of batches([...candidateByHash.values()], batchSize)) {
    if (diagnostics) diagnostics.queryCalls = Number(diagnostics.queryCalls ?? 0) + 1;
    const results = await table
      .query()
      .where(`id IN (${group.map((candidate) => sqlString(candidate.id)).join(", ")})`)
      .select(["id", "embeddingHash", "vector"])
      .limit(group.length)
      .toArray();
    if (diagnostics) {
      diagnostics.rowsRead = Number(diagnostics.rowsRead ?? 0) + results.length;
      diagnostics.maximumRowsPerQuery = Math.max(
        Number(diagnostics.maximumRowsPerQuery ?? 0),
        results.length,
      );
    }
    const requestedById = new Map(group.map((candidate) => [candidate.id, candidate]));
    for (const row of results) {
      const expected = requestedById.get(row.id);
      if (expected?.embeddingHash === row.embeddingHash && !rowsByHash.has(row.embeddingHash)) {
        rowsByHash.set(row.embeddingHash, row);
      }
    }
  }
  return [...rowsByHash.values()];
}

export async function loadReusableRows(
  databasePath,
  tableName,
  embeddingDimensions,
  candidates = [],
  { databaseVersion, diagnostics } = {},
) {
  if (candidates.length === 0) return [];
  if (!existsSync(databasePath)) return [];
  return withDatabase(databasePath, async (db) => {
    const table = await db.openTable(tableName);
    const rows = await queryReusableRowsInBatches(table, candidates, {
      databaseVersion,
      diagnostics,
    });
    return rows
      .map((row) => ({ ...row, vector: Array.from(row.vector ?? []) }))
      .filter(
        (row) =>
          typeof row.embeddingHash === "string" &&
          row.vector.length === embeddingDimensions &&
          row.vector.every((value) => typeof value === "number" && Number.isFinite(value)),
      );
  });
}

async function streamChunkFingerprint(table, expectedRows, diagnostics) {
  const fingerprint = createChunkFingerprintAccumulator();
  let cursor;
  let rowsRead = 0;
  while (true) {
    const query = table.query();
    if (cursor) {
      query.where(
        `(id > ${sqlString(cursor.id)}) OR (id = ${sqlString(cursor.id)} AND embeddingHash > ${sqlString(cursor.embeddingHash)})`,
      );
    }
    if (diagnostics) {
      diagnostics.fingerprintQueries = Number(diagnostics.fingerprintQueries ?? 0) + 1;
    }
    const rows = await query
      .select(["id", "embeddingHash"])
      .orderBy([
        { columnName: "id", ascending: true },
        { columnName: "embeddingHash", ascending: true },
      ])
      .limit(fingerprintReadBatchSize)
      .toArray({ maxBatchLength: fingerprintReadBatchSize });
    if (rows.length === 0) break;
    if (diagnostics) {
      diagnostics.fingerprintBatches = Number(diagnostics.fingerprintBatches ?? 0) + 1;
      diagnostics.fingerprintRows = Number(diagnostics.fingerprintRows ?? 0) + rows.length;
      diagnostics.maximumFingerprintBatchRows = Math.max(
        Number(diagnostics.maximumFingerprintBatchRows ?? 0),
        rows.length,
      );
    }
    for (const row of rows) {
      if (
        typeof row.id !== "string" ||
        row.id.length === 0 ||
        typeof row.embeddingHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(row.embeddingHash)
      ) {
        throw new Error("Context vector database contains an invalid chunk identity.");
      }
      fingerprint.update(row);
    }
    rowsRead += rows.length;
    cursor = rows.at(-1);
    if (rows.length < fingerprintReadBatchSize) break;
  }
  if (rowsRead !== expectedRows) {
    throw new Error(
      `Context vector database chunk identity scan mismatch: expected ${expectedRows}, received ${rowsRead}.`,
    );
  }
  return fingerprint.digest();
}

export async function verifyDatabaseStructure({
  databasePath,
  tableName,
  manifest,
  embeddingDimensions,
  verifyFingerprint = true,
  diagnostics,
}) {
  if (!existsSync(databasePath)) throw new Error("Context vector database is missing.");
  return withDatabase(databasePath, async (db) => {
    const table = await db.openTable(tableName);
    const rowCount = await table.countRows();
    const schema = String(await table.schema());
    if (rowCount !== manifest.stats.chunks) {
      throw new Error(
        `Context vector database row count mismatch: manifest=${manifest.stats.chunks}, table=${rowCount}.`,
      );
    }
    if (!schema.includes(`FixedSizeList[${embeddingDimensions}]`)) {
      throw new Error(
        `Context vector database schema does not contain ${embeddingDimensions}D vectors.`,
      );
    }
    for (const requiredColumn of [
      "embeddingHash",
      "id",
      "path",
      "searchText",
      "text",
      "tokenCount",
    ]) {
      if (!schema.includes(requiredColumn)) {
        throw new Error(`Context vector database schema is missing ${requiredColumn}.`);
      }
    }
    const indices = await table.listIndices();
    const searchIndex = indices.find(
      (index) => index.indexType === "FTS" && index.columns?.includes("searchText"),
    );
    if (!searchIndex) throw new Error("Context vector database is missing its full-text index.");
    const vectorIndex = indices.find((index) => index.columns?.includes("vector"));
    if (manifest.stats.vectorIndexEnabled && !vectorIndex) {
      throw new Error("Context vector database is missing its expected vector index.");
    }
    for (const scalarColumn of ["embeddingHash", "id", "path"]) {
      if (!indices.some((index) => index.columns?.includes(scalarColumn))) {
        throw new Error(`Context vector database is missing its ${scalarColumn} scalar index.`);
      }
    }
    if (verifyFingerprint) {
      const databaseFingerprint = await streamChunkFingerprint(table, rowCount, diagnostics);
      if (databaseFingerprint !== manifest.chunkFingerprint) {
        throw new Error("Context vector database chunk identity does not match the manifest.");
      }
    }
    return { rowCount, schema, indices };
  });
}

export async function inspectDatabaseIndices(databasePath, tableName) {
  return withDatabase(databasePath, async (db) => {
    const table = await db.openTable(tableName);
    return table.listIndices();
  });
}

export async function explainDenseQueryPlan({ databasePath, tableName, vector, limit = 8 }) {
  return withDatabase(databasePath, async (db) => {
    const table = await db.openTable(tableName);
    return table
      .vectorSearch(vector)
      .ef(Math.max(512, limit * 16))
      .refineFactor(10)
      .limit(limit)
      .explainPlan(true);
  });
}

export async function explainFilterQueryPlan({ databasePath, tableName, column, value }) {
  return withDatabase(databasePath, async (db) => {
    const table = await db.openTable(tableName);
    return table
      .query()
      .where(`${column} = ${sqlString(value)}`)
      .limit(1)
      .explainPlan(true);
  });
}

export async function queryDatabase({
  databasePath,
  tableName,
  vector,
  query,
  denseLimit,
  lexicalLimit,
}) {
  return withDatabase(databasePath, async (db) => {
    const lancedb = await getLanceDb();
    const table = await db.openTable(tableName);
    const columns = [
      "id",
      "path",
      "startLine",
      "endLine",
      "text",
      "headingsText",
      "symbolsText",
      "importsText",
      "tokenCount",
      "embeddingHash",
    ];
    const dense = table
      .vectorSearch(vector)
      .ef(Math.max(512, denseLimit * 16))
      .refineFactor(10)
      .select([...columns, "_distance"])
      .limit(denseLimit)
      .toArray();
    const lexical = query
      ? table
          .query()
          .fullTextSearch(
            new lancedb.MatchQuery(query, "searchText", { operator: lancedb.Operator.Or }),
            { columns: "searchText" },
          )
          .select([...columns, "_score"])
          .limit(lexicalLimit)
          .toArray()
      : Promise.resolve([]);
    const phrase = query?.includes(" ")
      ? table
          .query()
          .fullTextSearch(new lancedb.PhraseQuery(query, "searchText"), {
            columns: "searchText",
          })
          .select([...columns, "_score"])
          .limit(Math.max(8, Math.floor(lexicalLimit / 2)))
          .toArray()
      : Promise.resolve([]);
    const [denseResults, lexicalResults, phraseResults] = await Promise.all([
      dense,
      lexical,
      phrase,
    ]);
    const allRows = [
      ...new Map([...phraseResults, ...lexicalResults].map((row) => [row.id, row])).values(),
    ];
    return { denseResults, allRows };
  });
}

function safeRename(source, destination) {
  if (existsSync(source)) renameSync(source, destination);
}

function manifestText(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function writeTemporaryManifest(temporaryManifestPath, manifest) {
  const content = manifestText(manifest);
  writeFileSync(temporaryManifestPath, content, { encoding: "utf8", mode: 0o600 });
  return content;
}

function safeManifestHash(manifestPath) {
  try {
    const stats = lstatSync(manifestPath);
    if (stats.isSymbolicLink() || !stats.isFile()) return null;
    return hashContent(readFileSync(manifestPath));
  } catch {
    return null;
  }
}

function readTransaction(transactionPath) {
  if (!existsSync(transactionPath)) return null;
  const stats = lstatSync(transactionPath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error("Context database transaction journal is not a safe regular file.");
  }
  let transaction;
  try {
    transaction = JSON.parse(readFileSync(transactionPath, "utf8"));
  } catch {
    throw new Error("Context database transaction journal is not valid JSON.");
  }
  if (
    transaction?.version !== 1 ||
    !Number.isInteger(transaction.beforeVersion) ||
    transaction.beforeVersion < 1 ||
    typeof transaction.targetManifestHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(transaction.targetManifestHash)
  ) {
    throw new Error("Context database transaction journal is malformed.");
  }
  return transaction;
}

async function restoreTableVersion(databasePath, tableName, beforeVersion) {
  await withDatabase(databasePath, async (db) => {
    const table = await db.openTable(tableName);
    const versions = await table.listVersions();
    if (!versions.some((version) => version.version === beforeVersion)) {
      throw new Error(`Context database rollback version ${beforeVersion} is unavailable.`);
    }
    await table.checkout(beforeVersion);
    await table.restore();
  });
}

export async function recoverIndexTransaction({
  indexDirectory,
  databasePath,
  manifestPath,
  tableName,
}) {
  const transactionPath = transactionPathFor(indexDirectory);
  const transaction = readTransaction(transactionPath);
  if (!transaction) return { recovered: false, state: "none" };
  if (safeManifestHash(manifestPath) === transaction.targetManifestHash) {
    rmSync(transactionPath, { force: true });
    return { recovered: true, state: "committed" };
  }
  await restoreTableVersion(databasePath, tableName, transaction.beforeVersion);
  rmSync(transactionPath, { force: true });
  return { recovered: true, state: "rolled-back" };
}

export function indexRepairRequired(indexDirectory) {
  const markerPath = repairMarkerPathFor(indexDirectory);
  if (!existsSync(markerPath)) return false;
  const stats = lstatSync(markerPath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error("Context database repair marker is not a safe regular file.");
  }
  return true;
}

export function markIndexTransactionForRepair(indexDirectory) {
  const transactionPath = transactionPathFor(indexDirectory);
  const markerPath = repairMarkerPathFor(indexDirectory);
  if (indexRepairRequired(indexDirectory)) {
    rmSync(transactionPath, { force: true });
    return false;
  }
  if (existsSync(transactionPath)) {
    const stats = lstatSync(transactionPath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error("Context database transaction journal is not a safe regular file.");
    }
    renameSync(transactionPath, markerPath);
  } else {
    writeFileSync(
      markerPath,
      `${JSON.stringify({
        version: 1,
        reason: "transaction rollback unavailable",
        createdAt: new Date().toISOString(),
      })}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  }
  return true;
}

function clearIndexRepairMarker(indexDirectory) {
  rmSync(repairMarkerPathFor(indexDirectory), { force: true });
}

async function* recordBatchSource(records, recordBatches, batchSize = 256) {
  if (recordBatches) {
    for await (const batch of recordBatches) {
      if (batch.length > 0) yield batch;
    }
    return;
  }
  for (const batch of batches(records ?? [], batchSize)) yield batch;
}

async function addRecordBatches(table, source) {
  for await (const batch of source) await table.add(batch);
}

function hasIndex(indices, column, type) {
  return indices.some(
    (index) => index.columns?.includes(column) && (!type || index.indexType === type),
  );
}

async function publishManifestOnly({ manifestPath, temporaryManifestPath, manifest }) {
  try {
    writeTemporaryManifest(temporaryManifestPath, manifest);
    renameSync(temporaryManifestPath, manifestPath);
    return { optimizedIndex: false };
  } finally {
    rmSync(temporaryManifestPath, { force: true });
  }
}

async function publishIncrementally({
  indexDirectory,
  databasePath,
  manifestPath,
  temporaryManifestPath,
  tableName,
  records,
  recordBatches,
  recordBatchFactory,
  manifest,
  replacedPaths,
  vectorIndexThreshold,
}) {
  const transactionPath = transactionPathFor(indexDirectory);
  await recoverIndexTransaction({ indexDirectory, databasePath, manifestPath, tableName });
  let beforeVersion;
  let journalWritten = false;
  let optimizedIndex = false;
  try {
    await withDatabase(databasePath, async (db) => {
      const lancedb = await getLanceDb();
      const table = await db.openTable(tableName);
      beforeVersion = await table.version();
      const indices = await table.listIndices();
      const searchIndex = indices.find(
        (index) => index.indexType === "FTS" && index.columns?.includes("searchText"),
      );
      const targetRows = manifest.stats.chunks;
      const currentRows = await table.countRows();
      const replacedPathGroups = batches([...new Set(replacedPaths)]);
      let replacedRows = 0;
      for (const paths of replacedPathGroups) {
        replacedRows += await table.countRows(`path IN (${paths.map(sqlString).join(", ")})`);
      }
      const unindexedRows = Number(searchIndex?.numUnindexedRows ?? 0);
      const estimatedUnindexedRows =
        unindexedRows +
        replacedRows +
        Number(manifest.stats.processedChunks ?? records?.length ?? 0);
      const operations = Number(manifest.stats.databaseModificationOperations ?? 0);
      const shouldOptimize =
        operations >= 20 ||
        estimatedUnindexedRows >= 100_000 ||
        (Math.max(currentRows, targetRows) >= vectorIndexThreshold &&
          estimatedUnindexedRows / Math.max(currentRows, targetRows) > 0.25);
      const vectorIndexExists = hasIndex(indices, "vector");
      const shouldCreateVectorIndex = !vectorIndexExists && targetRows >= vectorIndexThreshold;
      manifest.stats.vectorIndexEnabled = vectorIndexExists || shouldCreateVectorIndex;
      manifest.stats.databaseIndexOptimized = shouldOptimize;
      if (shouldOptimize) manifest.stats.databaseModificationOperations = 0;
      const targetManifest = writeTemporaryManifest(temporaryManifestPath, manifest);
      writeFileSync(
        transactionPath,
        `${JSON.stringify({
          version: 1,
          beforeVersion,
          targetManifestHash: hashContent(targetManifest),
          createdAt: new Date().toISOString(),
        })}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      journalWritten = true;

      for (const paths of replacedPathGroups) {
        await table.delete(`path IN (${paths.map(sqlString).join(", ")})`);
      }
      const batchesForVersion = recordBatchFactory
        ? recordBatchFactory({ databaseVersion: beforeVersion })
        : recordBatches;
      await addRecordBatches(table, recordBatchSource(records, batchesForVersion));
      if (shouldCreateVectorIndex) {
        await table.createIndex("vector", {
          config: lancedb.Index.hnswSq({
            distanceType: "l2",
            numPartitions: 1,
            m: 32,
            efConstruction: 400,
          }),
        });
      }
      if (shouldOptimize) {
        await table.optimize();
        optimizedIndex = true;
      }
      const rowCount = await table.countRows();
      if (rowCount !== targetRows) {
        throw new Error(
          `Incremental context publication row mismatch: expected ${targetRows}, received ${rowCount}.`,
        );
      }
    });
    renameSync(temporaryManifestPath, manifestPath);
    rmSync(transactionPath, { force: true });
    return { optimizedIndex };
  } catch (error) {
    if (journalWritten && Number.isInteger(beforeVersion)) {
      try {
        await restoreTableVersion(databasePath, tableName, beforeVersion);
        rmSync(transactionPath, { force: true });
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Context incremental publication failed and its version rollback did not complete.",
        );
      }
    }
    throw error;
  } finally {
    rmSync(temporaryManifestPath, { force: true });
  }
}

async function publishFull({
  indexDirectory,
  databasePath,
  manifestPath,
  tableName,
  records,
  recordBatches,
  recordBatchFactory,
  manifest,
  vectorIndexThreshold,
}) {
  const suffix = `${process.pid}-${Date.now()}`;
  const temporaryDatabasePath = path.join(indexDirectory, `lancedb.next-${suffix}`);
  const previousDatabasePath = path.join(indexDirectory, `lancedb.previous-${suffix}`);
  const temporaryManifestPath = path.join(indexDirectory, `manifest.next-${suffix}.json`);
  const previousManifestPath = path.join(indexDirectory, `manifest.previous-${suffix}.json`);
  let movedDatabase = false;
  let movedManifest = false;
  let publishedDatabase = false;
  let publishedManifest = false;
  try {
    const source = recordBatchSource(
      records,
      recordBatchFactory ? recordBatchFactory({ databaseVersion: undefined }) : recordBatches,
    );
    const iterator = source[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done || first.value.length === 0) {
      throw new Error("Context index cannot publish an empty record stream.");
    }
    await withDatabase(temporaryDatabasePath, async (db) => {
      const lancedb = await getLanceDb();
      const table = await db.createTable(tableName, first.value, { mode: "overwrite" });
      await addRecordBatches(table, { [Symbol.asyncIterator]: () => iterator });
      await table.createIndex("searchText", {
        config: lancedb.Index.fts({ withPosition: true, lowercase: true }),
      });
      for (const scalarColumn of ["embeddingHash", "id", "path"]) {
        await table.createIndex(scalarColumn, { config: lancedb.Index.btree() });
      }
      const rowCount = await table.countRows();
      if (rowCount !== manifest.stats.chunks) {
        throw new Error(
          `Full context publication row mismatch: expected ${manifest.stats.chunks}, received ${rowCount}.`,
        );
      }
      if (rowCount >= vectorIndexThreshold) {
        await table.createIndex("vector", {
          config: lancedb.Index.hnswSq({
            distanceType: "l2",
            numPartitions: 1,
            m: 32,
            efConstruction: 400,
          }),
        });
        manifest.stats.vectorIndexEnabled = true;
      } else manifest.stats.vectorIndexEnabled = false;
    });
    manifest.stats.databaseIndexOptimized = false;
    writeTemporaryManifest(temporaryManifestPath, manifest);
    if (existsSync(databasePath)) {
      renameSync(databasePath, previousDatabasePath);
      movedDatabase = true;
    }
    if (existsSync(manifestPath)) {
      renameSync(manifestPath, previousManifestPath);
      movedManifest = true;
    }
    renameSync(temporaryDatabasePath, databasePath);
    publishedDatabase = true;
    renameSync(temporaryManifestPath, manifestPath);
    publishedManifest = true;
    rmSync(previousDatabasePath, { recursive: true, force: true });
    rmSync(previousManifestPath, { force: true });
    return { optimizedIndex: false };
  } catch (error) {
    if (publishedDatabase) rmSync(databasePath, { recursive: true, force: true });
    if (publishedManifest) rmSync(manifestPath, { force: true });
    if (movedDatabase) safeRename(previousDatabasePath, databasePath);
    if (movedManifest) safeRename(previousManifestPath, manifestPath);
    throw error;
  } finally {
    rmSync(temporaryDatabasePath, { recursive: true, force: true });
    rmSync(temporaryManifestPath, { force: true });
    cleanupGeneratedIndexDebris(indexDirectory);
  }
}

export async function publishIndex({
  indexDirectory,
  databasePath,
  manifestPath,
  tableName,
  records,
  recordBatches,
  recordBatchFactory,
  manifest,
  incremental = false,
  manifestOnly = false,
  replacedPaths = [],
  vectorIndexThreshold = defaultVectorIndexThreshold,
}) {
  let repairRequired = indexRepairRequired(indexDirectory);
  if (repairRequired && (incremental || manifestOnly)) {
    throw new Error("Context database requires a full repair before incremental publication.");
  }
  if (existsSync(databasePath) && !repairRequired) {
    try {
      await recoverIndexTransaction({ indexDirectory, databasePath, manifestPath, tableName });
    } catch (error) {
      if (incremental || manifestOnly) throw error;
      markIndexTransactionForRepair(indexDirectory);
      repairRequired = true;
    }
  } else if (!incremental && !manifestOnly && existsSync(transactionPathFor(indexDirectory))) {
    markIndexTransactionForRepair(indexDirectory);
    repairRequired = true;
  }
  cleanupGeneratedIndexDebris(indexDirectory);
  const temporaryManifestPath = path.join(
    indexDirectory,
    `manifest.next-${process.pid}-${Date.now()}.json`,
  );
  rmSync(temporaryManifestPath, { force: true });
  if (manifestOnly) {
    return publishManifestOnly({ manifestPath, temporaryManifestPath, manifest });
  }
  if (incremental) {
    return publishIncrementally({
      indexDirectory,
      databasePath,
      manifestPath,
      temporaryManifestPath,
      tableName,
      records,
      recordBatches,
      recordBatchFactory,
      manifest,
      replacedPaths,
      vectorIndexThreshold,
    });
  }
  const publication = await publishFull({
    indexDirectory,
    databasePath,
    manifestPath,
    tableName,
    records,
    recordBatches,
    recordBatchFactory,
    manifest,
    vectorIndexThreshold,
  });
  if (repairRequired) clearIndexRepairMarker(indexDirectory);
  return publication;
}
