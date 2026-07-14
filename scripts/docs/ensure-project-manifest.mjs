import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { projectManifestPath, strategicDocumentBudgetFailures } from "./document-scope.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifestPath = path.join(root, ...projectManifestPath.split("/"));
const checkOnly = process.argv.includes("--check");
const leanSections = [
  "Definition",
  "Users And Outcome",
  "Scope",
  "System Shape",
  "Constraints And Decisions",
  "Maintenance",
];

const defaultManifest = `# Project Manifest

This is the concise central source of truth for product intent, scope, system shape, and durable
decisions.

## Definition

No product has been defined yet.

## Users And Outcome

- Target users: pending.
- Problem and desired outcome: pending.
- Success evidence: pending.

## Scope

- In scope: pending.
- Non-goals: do not infer a runtime, provider, deployment target, data model, or trust boundary.

## System Shape

- Key domains and boundaries: pending.
- External systems and data flows: pending.
- Runtime and delivery shape: pending.

## Constraints And Decisions

- Keep the project neutral until requirements justify durable decisions.

## Maintenance

Update existing entries before implementation depends on changed project intent or constraints.
Keep active truth only; do not append history or task state.
`;

function hasSections(content, sections) {
  return sections.every((section) => content.includes(`## ${section}`));
}

if (!existsSync(manifestPath)) {
  if (checkOnly) {
    console.error("Project Manifest is missing: docs/project.md");
    process.exit(1);
  }
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, defaultManifest, "utf8");
  console.log("Created docs/project.md Project Manifest.");
  process.exit(0);
}

const current = readFileSync(manifestPath, "utf8");
const failures = [];
if (!current.startsWith("# Project Manifest\n")) {
  failures.push("docs/project.md must start with # Project Manifest");
}
if (!hasSections(current, leanSections)) {
  failures.push("docs/project.md must use the current concise manifest sections");
}
for (const budgetFailure of strategicDocumentBudgetFailures(projectManifestPath, current)) {
  failures.push(`docs/project.md exceeds its always-read context budget (${budgetFailure})`);
}

if (failures.length > 0) {
  console.error("Project Manifest verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("Project Manifest is current.");
