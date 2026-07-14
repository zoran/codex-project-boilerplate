import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  isRepositoryProcessMarkdownPath,
  listManagedMarkdownFiles,
  strategicDocumentBudgetFailures,
} from "../docs/document-scope.mjs";
import { repositoryRoot } from "../repository/source-inventory.mjs";

const root = repositoryRoot;
const manifestCheck = spawnSync(
  process.execPath,
  ["scripts/docs/ensure-project-manifest.mjs", "--check"],
  { cwd: root, stdio: "inherit" },
);
if (manifestCheck.status !== 0) process.exit(manifestCheck.status ?? 1);

const failures = [];
for (const relativePath of listManagedMarkdownFiles()) {
  const filePath = path.join(root, relativePath);
  const content = readFileSync(filePath, "utf8");
  if (!/^#\s+.+$/m.test(content)) failures.push(`${relativePath}: missing top-level title`);
  if (isRepositoryProcessMarkdownPath(relativePath)) {
    failures.push(
      `${relativePath}: repository process documents are not allowed; keep plans, status, reviews, and handoffs in the conversation`,
    );
  }
  for (const budgetFailure of strategicDocumentBudgetFailures(relativePath, content)) {
    failures.push(`${relativePath}: context budget exceeded (${budgetFailure})`);
  }
  for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const raw = match[1].trim();
    if (/^(?:https?:|mailto:|#)/.test(raw)) continue;
    const targetPart = raw.split("#")[0];
    if (!targetPart) continue;
    const target = path.resolve(path.dirname(filePath), targetPart);
    const relativeTarget = path.relative(root, target);
    if (
      relativeTarget === ".." ||
      relativeTarget.startsWith(".." + path.sep) ||
      path.isAbsolute(relativeTarget)
    ) {
      failures.push(`${relativePath}: link escapes repository: ${raw}`);
    } else if (!existsSync(target)) {
      failures.push(`${relativePath}: broken link ${raw}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Documentation verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("Documentation verification passed without generating project files.");
