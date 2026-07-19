import { runAsSanitizedContextWorker } from "./context-worker-output.mjs";
import { formatContextError, sanitizeForTerminal } from "./terminal-output.mjs";

runAsSanitizedContextWorker(import.meta.url);

async function main() {
  const { describeFreshness, inspectIndexStatus, normalizeCliArgs } =
    await import("./context-index-lib.mjs");
  const args = normalizeCliArgs(process.argv.slice(2));
  const allowed = new Set(["--no-repair", "--status-only"]);
  const unknown = args.filter((arg) => !allowed.has(arg));
  if (unknown.length > 0) throw new Error(`Unknown context check argument: ${unknown[0]}`);
  const result = await inspectIndexStatus();
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
}

try {
  await main();
} catch (error) {
  console.error(`Context index check failed: ${formatContextError(error)}`);
  process.exitCode = 1;
}
