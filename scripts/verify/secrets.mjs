import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  activeSourcePathClassification,
  isPrivateCodexRuntimePath,
  listRepositoryPathInventory,
  repositoryRoot,
} from "../repository/source-inventory.mjs";
import { sensitivePathReason } from "../repository/sensitive-paths.mjs";
import { scanStableRepositoryFile } from "../repository/stable-file-snapshot.mjs";
import { formatContextError, sanitizeMultilineForTerminal } from "../context/terminal-output.mjs";
import { createSecretContentScanner } from "./secret-content-scan.mjs";

export async function scanRepositorySecrets({ root = repositoryRoot, files } = {}) {
  const findings = [];
  const repositoryFiles = files ?? listRepositoryPathInventory({ root }).paths;
  for (const relativePath of repositoryFiles) {
    const activeClassification = activeSourcePathClassification(relativePath);
    if (activeClassification?.code === "unsafe-path") {
      throw new Error("Secret scan refused an unsafe repository-relative path.");
    }
    const pathReason = sensitivePathReason(relativePath);
    if (isPrivateCodexRuntimePath(relativePath)) {
      findings.push(`${relativePath}: ${pathReason ?? activeClassification.reason}`);
      continue;
    }

    const scanner = createSecretContentScanner();
    try {
      scanStableRepositoryFile({
        repositoryRoot: root,
        relativePath,
        onChunk: (chunk) => scanner.write(chunk),
      });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (pathReason) findings.push(`${relativePath}: ${pathReason}`);
    for (const label of scanner.findings()) findings.push(`${relativePath}: ${label}`);
  }
  return findings;
}

async function main() {
  const findings = await scanRepositorySecrets();
  if (findings.length > 0) {
    console.error("Potential secret or sensitive path detected:");
    for (const finding of findings) {
      console.error(`- ${sanitizeMultilineForTerminal(finding, repositoryRoot)}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("Secret scan passed.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Secret scan failed: ${formatContextError(error, repositoryRoot)}`);
    process.exitCode = 1;
  });
}
