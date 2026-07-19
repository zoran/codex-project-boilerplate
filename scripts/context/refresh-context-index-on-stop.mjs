import { existsSync } from "node:fs";
import { runAsSanitizedContextWorker } from "./context-worker-output.mjs";
import { formatContextError } from "./terminal-output.mjs";

runAsSanitizedContextWorker(import.meta.url);

function reportFailure(error) {
  const detail = formatContextError(error);
  process.stdout.write(
    `${JSON.stringify({
      systemMessage:
        `Automatic context index refresh failed: ${detail}. ` +
        "Run pnpm context:index before relying on semantic retrieval.",
    })}\n`,
  );
}

async function main() {
  try {
    const library = await import("./context-index-lib.mjs");
    if (!existsSync(library.indexDirectory)) return;

    const result = await library.ensureFreshIndex({ repair: true });
    if (!result.manifest || !result.freshness.fresh) {
      throw new Error(
        `Context index is not current after automatic refresh: ${library.describeFreshness(
          result.freshness,
        )}`,
      );
    }
  } catch (error) {
    reportFailure(error);
  }
}

await main();
