import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { assertPortableContextContract } from "../context/portable-context-contract.mjs";
import { formatContextError } from "../context/terminal-output.mjs";
import { listStagedTransferFiles } from "../repository/source-inventory.mjs";
import { assertSafeTransferSource } from "../repository/validate-transfer-source.mjs";
import { scanRepositorySecrets } from "../verify/secrets.mjs";
import { productSourceBoundaryFindings } from "../verify/path-hygiene.mjs";
import { validateCodexConfig } from "./validate-codex-config.mjs";

const modulePath = fileURLToPath(import.meta.url);

function directoryIdentity(stats) {
  return `${stats.dev}:${stats.ino}`;
}

function fileIdentity(stats) {
  return [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs, stats.nlink].join(":");
}

function bindStageRoot(candidate) {
  try {
    const stats = lstatSync(candidate, { bigint: true });
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error("unsafe root");
    return {
      identity: directoryIdentity(stats),
      root: realpathSync(candidate),
    };
  } catch {
    throw new Error("Staged project root must be a stable non-symlink directory.");
  }
}

function assertStageRootBinding(binding) {
  try {
    const stats = lstatSync(binding.root, { bigint: true });
    const validatorStats = lstatSync(binding.validatorPath, { bigint: true });
    if (
      stats.isSymbolicLink() ||
      !stats.isDirectory() ||
      directoryIdentity(stats) !== binding.identity ||
      realpathSync(binding.root) !== binding.root ||
      validatorStats.isSymbolicLink() ||
      !validatorStats.isFile() ||
      fileIdentity(validatorStats) !== binding.validatorIdentity ||
      realpathSync(binding.validatorPath) !== binding.validatorPath
    ) {
      throw new Error("changed binding");
    }
  } catch {
    throw new Error("Staged project root identity changed during validation.");
  }
}

function resolveOwnedStagedProjectRoot(invokedScriptPath) {
  try {
    const scriptStats = lstatSync(invokedScriptPath, { bigint: true });
    if (scriptStats.isSymbolicLink() || !scriptStats.isFile() || scriptStats.nlink !== 1n) {
      throw new Error("unsafe validator");
    }
    const canonicalScript = realpathSync(invokedScriptPath);
    if (canonicalScript !== realpathSync(modulePath)) throw new Error("wrong validator");
    const rootBinding = bindStageRoot(path.resolve(path.dirname(invokedScriptPath), "..", ".."));
    if (
      canonicalScript !== path.join(rootBinding.root, "scripts/setup/validate-staged-project.mjs")
    ) {
      throw new Error("validator outside root");
    }
    const binding = Object.freeze({
      ...rootBinding,
      validatorIdentity: fileIdentity(scriptStats),
      validatorPath: canonicalScript,
    });
    assertStageRootBinding(binding);
    return binding;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Staged project root")) throw error;
    throw new Error("Staged project validator is not safely bound to its own project root.");
  }
}

async function validateBoundStagedProject(binding) {
  assertStageRootBinding(binding);
  validateCodexConfig(binding.root);
  assertStageRootBinding(binding);
  assertPortableContextContract({ repositoryRoot: binding.root });
  assertStageRootBinding(binding);
  const boundaryFindings = productSourceBoundaryFindings({ repositoryRoot: binding.root });
  if (boundaryFindings.length > 0) {
    throw new Error(
      [
        "Staged project violates the Product Roots contract:",
        ...boundaryFindings.map((item) => `- ${item}`),
      ].join("\n"),
    );
  }
  assertStageRootBinding(binding);
  const files = listStagedTransferFiles({ root: binding.root });
  assertSafeTransferSource({ root: binding.root, files });
  assertStageRootBinding(binding);
  const findings = await scanRepositorySecrets({ root: binding.root, files });
  assertStageRootBinding(binding);
  if (findings.length > 0) {
    throw new Error(
      [
        "Staged project contains potential secret material:",
        ...findings.map((item) => `- ${item}`),
      ].join("\n"),
    );
  }
}

async function main() {
  if (process.argv.length !== 2) {
    throw new Error("Usage: node scripts/setup/validate-staged-project.mjs");
  }
  const binding = resolveOwnedStagedProjectRoot(process.argv[1]);
  await validateBoundStagedProject(binding);
  console.log("Staged project policy, path, and secret validation passed.");
}

main().catch((error) => {
  console.error(`Staged project validation failed: ${formatContextError(error)}`);
  process.exitCode = 1;
});
