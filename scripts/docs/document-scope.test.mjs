import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isManagedMarkdownPath,
  isRepositoryProcessMarkdownPath,
  listManagedMarkdownFiles,
  projectContextPath,
  projectManifestPath,
  strategicDocumentBudgetFailures,
} from "./document-scope.mjs";

test("sync and verification scope includes Markdown in arbitrary active project roots", () => {
  for (const relativePath of [
    "README.md",
    "docs/guide.mdx",
    "src/README.md",
    "tools/generator/README.md",
    "examples/site/guide.md",
    "modules/domain/notes.md",
  ]) {
    assert.equal(isManagedMarkdownPath(relativePath), true, relativePath);
  }
});

test("runtime-managed skill and Codex Markdown stays outside project documentation scope", () => {
  assert.equal(isManagedMarkdownPath(".agents/skills/example/SKILL.md"), false);
  assert.equal(isManagedMarkdownPath(".codex/README.md"), false);
});

test("repository process documents are distinguishable from durable product documentation", () => {
  for (const relativePath of [
    "docs/planning/current-goal.md",
    "docs/tasks/feature.md",
    "docs/final-audit.md",
    "docs/archive/completed-context.md",
    "docs/history/session.md",
    "PROJECT_PLAN.md",
    "notes/reviews/final-audit.md",
  ]) {
    assert.equal(isRepositoryProcessMarkdownPath(relativePath), true, relativePath);
  }
  for (const relativePath of [
    "docs/project.md",
    "docs/project-context.md",
    "docs/api.md",
    "docs/audit-log-api.md",
    "docs/operations.md",
    "docs/release-handoff.md",
    "docs/research.md",
    "docs/status-endpoint.md",
    "docs/task-api.md",
  ]) {
    assert.equal(isRepositoryProcessMarkdownPath(relativePath), false, relativePath);
  }
});

test("always-read strategic context has a hard context-window budget", () => {
  assert.deepEqual(
    strategicDocumentBudgetFailures(projectManifestPath, "# Project Manifest\n"),
    [],
  );
  assert.deepEqual(strategicDocumentBudgetFailures(projectContextPath, "# Project Context\n"), []);
  assert.match(
    strategicDocumentBudgetFailures(projectManifestPath, `${"word ".repeat(701)}\n`).join("\n"),
    /701 words; maximum is 700/,
  );
  assert.match(
    strategicDocumentBudgetFailures(projectContextPath, `${"line\n".repeat(81)}`).join("\n"),
    /81 lines; maximum is 80/,
  );
  assert.deepEqual(
    strategicDocumentBudgetFailures(projectContextPath, `${"line\n".repeat(80)}`),
    [],
  );
  assert.deepEqual(
    strategicDocumentBudgetFailures(projectManifestPath, `${"line\n".repeat(100)}`),
    [],
  );
  assert.match(
    strategicDocumentBudgetFailures(projectManifestPath, `${"line\n".repeat(101)}`).join("\n"),
    /101 lines; maximum is 100/,
  );
});

test("canonical active inventory feeds the shared Markdown scope", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "document-scope-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(path.join(root, ".agents", "skills", "fixture"), { recursive: true });
  writeFileSync(path.join(root, "README.md"), "# Root\n", "utf8");
  writeFileSync(path.join(root, "src", "README.md"), "# Source\n", "utf8");
  writeFileSync(path.join(root, "src", "notes.txt"), "not Markdown\n", "utf8");
  writeFileSync(path.join(root, ".agents", "skills", "fixture", "SKILL.md"), "# Skill\n", "utf8");
  assert.deepEqual(listManagedMarkdownFiles({ root }), ["README.md", "src/README.md"]);
});
