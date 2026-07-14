import { runAsSanitizedContextWorker } from "./context-worker-output.mjs";
import { formatContextError, sanitizeForTerminal } from "./terminal-output.mjs";

runAsSanitizedContextWorker(import.meta.url);

async function main() {
  const {
    describeBuildStats,
    describeFreshness,
    ensureFreshIndex,
    forceRepairIndex,
    inspectIndexStatus,
    normalizeCliArgs,
    verifyUsableIndex,
  } = await import("./context-index-lib.mjs");
  const args = normalizeCliArgs(process.argv.slice(2));
  const allowed = new Set(["--no-repair", "--status-only"]);
  const unknown = args.filter((arg) => !allowed.has(arg));
  if (unknown.length > 0) throw new Error(`Unknown context check argument: ${unknown[0]}`);
  const repair = !args.includes("--no-repair");
  const statusOnly = args.includes("--status-only");
  let result =
    !repair && statusOnly ? await inspectIndexStatus() : await ensureFreshIndex({ repair });

  if (result.rebuilt) {
    console.log(
      `Context index repaired (${sanitizeForTerminal(result.initialFreshness.reason)}): ${sanitizeForTerminal(
        describeBuildStats(result.buildStats),
      )}`,
    );
  }
  console.log(`Context index status: ${sanitizeForTerminal(describeFreshness(result.freshness))}`);

  if (!result.freshness.fresh) {
    const affected = [
      ...result.freshness.missing,
      ...result.freshness.changed,
      ...result.freshness.snapshotChanged,
      ...result.freshness.removed,
    ].slice(0, 20);
    for (const filePath of affected) console.log(`- ${sanitizeForTerminal(filePath)}`);
    if (affected.length >= 20) console.log("- ...");
    process.exitCode = 1;
    return;
  }
  if (statusOnly) return;

  try {
    await verifyUsableIndex(result.manifest);
  } catch (error) {
    if (!repair) throw error;
    const repaired = await forceRepairIndex("vector smoke failed after structural freshness check");
    if (!repaired.freshness.fresh) {
      throw new Error(
        `Forced context repair did not stabilize: ${describeFreshness(repaired.freshness)}`,
      );
    }
    console.log(`Context vector smoke forced a repair: ${describeBuildStats(repaired.buildStats)}`);
    result = { ...result, manifest: repaired.manifest };
    await verifyUsableIndex(result.manifest);
  }
  console.log("Context vector database smoke search passed.");
}

try {
  await main();
} catch (error) {
  console.error(`Context index check failed: ${formatContextError(error)}`);
  process.exitCode = 1;
}
