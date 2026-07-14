import { createReadStream } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { listRepositoryFiles, repositoryRoot } from "../repository/source-inventory.mjs";
import { sensitivePathReason } from "../repository/sensitive-paths.mjs";
import { createSecretContentScanner } from "./secret-content-scan.mjs";

export async function scanRepositorySecrets({ root = repositoryRoot, files } = {}) {
  const findings = [];
  const repositoryFiles = files ?? listRepositoryFiles({ root });
  for (const relativePath of repositoryFiles) {
    const pathReason = sensitivePathReason(relativePath);
    if (pathReason) findings.push(`${relativePath}: ${pathReason}`);

    const scanner = createSecretContentScanner();
    const absolutePath = path.join(root, ...relativePath.split("/"));
    for await (const chunk of createReadStream(absolutePath)) scanner.write(chunk);
    for (const label of scanner.findings()) findings.push(`${relativePath}: ${label}`);
  }
  return findings;
}

async function main() {
  const findings = await scanRepositorySecrets();
  if (findings.length > 0) {
    console.error("Potential secret or sensitive path detected:");
    for (const finding of findings) console.error(`- ${finding}`);
    process.exitCode = 1;
    return;
  }
  console.log("Secret scan passed.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Secret scan failed: ${error.message}`);
    process.exitCode = 1;
  });
}
