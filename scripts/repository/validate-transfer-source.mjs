import process from "node:process";
import { fileURLToPath } from "node:url";
import { listPortableTransferFiles, repositoryRoot } from "./source-inventory.mjs";
import { sensitivePathReason } from "./sensitive-paths.mjs";

export function sensitiveTransferFindings({ root = repositoryRoot, files } = {}) {
  const findings = [];
  const transferFiles = files ?? listPortableTransferFiles({ root });
  for (const relativePath of transferFiles) {
    const reason = sensitivePathReason(relativePath);
    if (reason) findings.push({ path: relativePath, reason });
  }
  return findings;
}

export function assertSafeTransferSource(options = {}) {
  const findings = sensitiveTransferFindings(options);
  if (findings.length === 0) return;
  throw new Error(
    [
      "Refusing to copy/export sensitive repository paths:",
      ...findings.map((finding) => `- ${finding.path} (${finding.reason})`),
    ].join("\n"),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    assertSafeTransferSource();
    console.log("Transfer source policy passed.");
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
