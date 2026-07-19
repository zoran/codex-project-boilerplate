import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { listActiveFiles, repositoryRoot } from "../repository/source-inventory.mjs";

const batchSize = 200;

export function projectFormatFiles(root = repositoryRoot) {
  return listActiveFiles({ root });
}

export function runProjectPrettier(mode, { root = repositoryRoot } = {}) {
  if (!new Set(["--check", "--write"]).has(mode)) {
    throw new Error("Project formatter mode must be --check or --write.");
  }
  const prettierPath = path.join(root, "node_modules", "prettier", "bin", "prettier.cjs");
  const files = projectFormatFiles(root);
  for (let offset = 0; offset < files.length; offset += batchSize) {
    const batch = files.slice(offset, offset + batchSize);
    const result = spawnSync(
      process.execPath,
      [prettierPath, mode, "--ignore-unknown", "--", ...batch],
      { cwd: root, stdio: "inherit" },
    );
    if (result.error) throw new Error(`Project formatter failed to start: ${result.error.message}`);
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

function main() {
  const args = process.argv.slice(2).filter((argument) => argument !== "--");
  if (args.length !== 1) {
    throw new Error("Usage: node scripts/verify/format-project.mjs <--check|--write>");
  }
  process.exitCode = runProjectPrettier(args[0]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
