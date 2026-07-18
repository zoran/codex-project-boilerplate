import { existsSync, lstatSync } from "node:fs";
import { createChunkFingerprintAccumulator } from "./context-manifest.mjs";

if (!process.env.RUST_LOG) process.env.RUST_LOG = "error";

let lancedbPromise;

export const reusableLookupBatchSize = 200;
export const fingerprintReadBatchSize = 512;

export async function getLanceDb() {
  lancedbPromise ??= import("@lancedb/lancedb");
  return lancedbPromise;
}

export async function withDatabase(databasePath, action) {
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

export function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function batches(values, size = 200) {
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
