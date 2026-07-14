import { rmSync } from "node:fs";
import { formatContextError } from "./terminal-output.mjs";

async function main() {
  const { assertContextIndexOwnership, indexDirectory, withContextRebuildLock } =
    await import("./context-index-lib.mjs");
  await withContextRebuildLock(async () => {
    assertContextIndexOwnership();
    rmSync(indexDirectory, { recursive: true, force: true });
  });
  console.log("Removed generated context index state after acquiring the maintenance lock.");
}

try {
  await main();
} catch (error) {
  console.error(`Context index cleanup failed: ${formatContextError(error)}`);
  process.exitCode = 1;
}
