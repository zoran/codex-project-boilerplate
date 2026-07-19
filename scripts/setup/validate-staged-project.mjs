import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { assertPortableContextContract } from "../context/portable-context-contract.mjs";
import { listStagedTransferFiles } from "../repository/source-inventory.mjs";
import { assertSafeTransferSource } from "../repository/validate-transfer-source.mjs";
import { scanRepositorySecrets } from "../verify/secrets.mjs";
import { productSourceBoundaryFindings } from "../verify/path-hygiene.mjs";
import { validateCodexConfig } from "./validate-codex-config.mjs";

export async function validateStagedProject(stageRoot) {
  const absoluteRoot = path.resolve(stageRoot);
  const stats = lstatSync(absoluteRoot);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("Staged project root must be a non-symlink directory.");
  }
  const root = realpathSync(absoluteRoot);
  validateCodexConfig(root);
  assertPortableContextContract({ repositoryRoot: root });
  const boundaryFindings = productSourceBoundaryFindings({ repositoryRoot: root });
  if (boundaryFindings.length > 0) {
    throw new Error(
      [
        "Staged project violates the Product Roots contract:",
        ...boundaryFindings.map((item) => `- ${item}`),
      ].join("\n"),
    );
  }
  const files = listStagedTransferFiles({ root });
  assertSafeTransferSource({ root, files });
  const findings = await scanRepositorySecrets({ root, files });
  if (findings.length > 0) {
    throw new Error(
      [
        "Staged project contains potential secret material:",
        ...findings.map((item) => `- ${item}`),
      ].join("\n"),
    );
  }
  return { root };
}

async function main() {
  const args = process.argv.slice(2).filter((argument) => argument !== "--");
  if (args.length !== 1) {
    throw new Error("Usage: node scripts/setup/validate-staged-project.mjs <stage-root>");
  }
  await validateStagedProject(args[0]);
  console.log("Staged project policy, path, and secret validation passed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Staged project validation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
