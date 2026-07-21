import { runAsSanitizedContextWorker } from "./context-worker-output.mjs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  formatContextError,
  sanitizeForTerminal,
  truncateForTerminal,
} from "./terminal-output.mjs";

function usage() {
  throw new Error('Usage: pnpm context:search -- "query text" [--limit=5]');
}

function parseArgs(args, normalizeCliArgs) {
  let limit = 5;
  const queryParts = [];
  for (const arg of normalizeCliArgs(args)) {
    if (arg.startsWith("--limit=")) {
      const value = arg.slice("--limit=".length);
      if (!/^\d+$/.test(value)) throw new Error(`Invalid context search limit: ${value}`);
      limit = Math.min(Number.parseInt(value, 10), 20);
      if (limit < 1) throw new Error("Context search limit must be at least 1.");
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`Unknown context search argument: ${arg}`);
    queryParts.push(arg);
  }
  const query = queryParts.join(" ").trim();
  if (!query) usage();
  if (query.length > 4096) throw new Error("Context search query exceeds 4096 characters.");
  return { query, limit };
}

function queryTerms(query) {
  return (query.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}_$]+/gu) ?? []).filter(
    (term) => term.length > 1,
  );
}

function snippetFor(result, query) {
  const lines = result.text.split(/\r?\n/);
  const terms = queryTerms(query);
  const bestLine = lines
    .map((line, index) => ({
      index,
      score: terms.reduce(
        (total, term) => total + (line.toLocaleLowerCase("en-US").includes(term) ? 1 : 0),
        0,
      ),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0];
  const start = Math.max(0, (bestLine?.score ?? 0) > 0 ? bestLine.index - 1 : 0);
  return lines
    .slice(start, Math.min(lines.length, start + 3))
    .map((line, offset) => `${result.startLine + start + offset}: ${truncateForTerminal(line)}`)
    .filter((line) => !line.endsWith(": "));
}

export async function runSearch({ query, limit, retry }, library) {
  const ensured = await library.ensureFreshIndex({ repair: true });
  if (!ensured.manifest || !ensured.freshness.fresh) {
    throw new Error(
      `Context index is not usable after repair: ${library.describeFreshness(ensured.freshness)}`,
    );
  }
  if (ensured.rebuilt) {
    console.log(
      `Context index refreshed (${sanitizeForTerminal(
        ensured.initialFreshness.reason,
      )}): ${sanitizeForTerminal(library.describeBuildStats(ensured.buildStats))}`,
    );
  }
  if (library.maintenanceChanged(ensured.maintenance)) {
    console.log(
      `Context index maintenance: ${sanitizeForTerminal(
        library.describeMaintenance(ensured.maintenance),
      )}`,
    );
  }

  let results;
  try {
    results = await library.searchIndex(query, { limit, maintenance: false });
  } catch (error) {
    if (!retry || error instanceof library.ContextDatabaseSafetyError) throw error;
    console.log("Context search access failed; forcing one bounded repair before retry.");
    await library.forceRepairIndex("search access failed after freshness validation");
    return runSearch({ query, limit, retry: false }, library);
  }

  return { results, freshness: ensured.freshness };
}

async function main() {
  const library = await import("./context-index-lib.mjs");
  const { query, limit } = parseArgs(process.argv.slice(2), library.normalizeCliArgs);
  const { results, freshness } = await runSearch({ query, limit, retry: true }, library);
  console.log(`Query: ${truncateForTerminal(query, 500)}`);
  console.log(`Index: ${sanitizeForTerminal(library.describeFreshness(freshness))}`);
  if (results.length === 0) {
    console.log("No context matches found. Use rg for exact strings or broaden the query.");
    return;
  }

  console.log(`Results: ${results.length}`);
  for (const [index, result] of results.entries()) {
    const distance = Number.isFinite(result._distance) ? result._distance.toFixed(3) : "lexical";
    console.log("");
    console.log(
      `${index + 1}. ${sanitizeForTerminal(result.path)}:${result.startLine}-${
        result.endLine
      } hybrid=${result._hybridScore.toFixed(4)} vectorDistance=${distance} lexical=${result._lexicalScore.toFixed(
        3,
      )}${result._exactPhrase ? " exact" : ""}`,
    );
    for (const line of snippetFor(result, query)) console.log(`   ${line}`);
  }
}

const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntryPoint) {
  runAsSanitizedContextWorker(import.meta.url);
  try {
    await main();
  } catch (error) {
    console.error(`Context search failed: ${formatContextError(error)}`);
    process.exitCode = 1;
  }
}
