import { runAsSanitizedContextWorker } from "./context-worker-output.mjs";
import { formatContextError, sanitizeForTerminal } from "./terminal-output.mjs";

runAsSanitizedContextWorker(import.meta.url);

async function main() {
  const {
    buildIndex,
    describeBuildStats,
    describeFreshness,
    describeMaintenance,
    indexDirectory,
    normalizeCliArgs,
    maintenanceChanged,
    relativeFromRoot,
    verifyUsableIndex,
  } = await import("./context-index-lib.mjs");
  const args = normalizeCliArgs(process.argv.slice(2));
  const unknown = args.filter((arg) => !["--full", "--setup"].includes(arg));
  if (unknown.length > 0) throw new Error(`Unknown context index argument: ${unknown[0]}`);
  const forceFull = args.includes("--full");
  const setupMode = args.includes("--setup");
  const result = await buildIndex({
    forceFull,
    reason: forceFull
      ? "manual full rebuild requested"
      : setupMode
        ? "project setup requested vector-space bootstrap"
        : "manual incremental rebuild requested",
  });
  console.log(
    `Context index updated: ${sanitizeForTerminal(describeBuildStats(result.buildStats))}`,
  );
  if (maintenanceChanged(result.maintenance)) {
    console.log(
      `Context index maintenance: ${sanitizeForTerminal(describeMaintenance(result.maintenance))}`,
    );
  }
  console.log(`Context index status: ${sanitizeForTerminal(describeFreshness(result.freshness))}`);
  if (!result.freshness.fresh) {
    throw new Error(`Context index is not current: ${describeFreshness(result.freshness)}`);
  }
  await verifyUsableIndex();
  const vectorSpacePath = `${relativeFromRoot(indexDirectory).replace(/\/$/, "")}/`;
  console.log(
    `Context vector space ready: ${sanitizeForTerminal(vectorSpacePath)} (database and smoke search verified).`,
  );
}

try {
  await main();
} catch (error) {
  console.error(`Context index build failed: ${formatContextError(error)}`);
  process.exitCode = 1;
}
