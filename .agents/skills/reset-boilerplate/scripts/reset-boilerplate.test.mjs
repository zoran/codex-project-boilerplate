import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "reset-boilerplate.mjs");

function write(root, relativePath, content = "fixture\n") {
  const filePath = path.join(root, ...relativePath.split("/"));
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

function run(root, args = []) {
  return spawnSync(process.execPath, [script, "--root", root, ...args], {
    encoding: "utf8",
    input: "",
    stdio: "pipe",
  });
}

test("reset removes process state while preserving the index and repository-root Codex runtime", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "reset-boilerplate-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  write(root, "package.json", '{"name":"codex-project"}\n');
  write(root, ".agents/skills/reset-boilerplate/SKILL.md", "# Fixture\n");
  write(root, "docs/project.md", "# Project Manifest\n");
  write(root, "docs/planning/current-goal.md", "# Current Goal\n");
  write(root, "notes/reviews/final-audit.md", "# Final Audit\n");
  write(root, "scripts/planning/create-goal.mjs", "export {};\n");
  write(root, ".project-state/dependency-update/plan.json", "{}\n");
  write(root, ".context-index/manifest.json", "{}\n");
  write(root, "dist/exports/project.tar.gz", "generated\n");
  write(root, ".codex/history.jsonl", "preserve me\n");
  write(root, "auth.json", "project auth fixture\n");
  write(root, "history.jsonl", "project history fixture\n");
  write(root, "sessions/thread.jsonl", "project session fixture\n");
  write(root, "state_1.sqlite", "project database fixture\n");
  write(root, "src/index.ts", "export const product = true;\n");

  const preview = run(root);
  assert.equal(preview.status, 1);
  assert.match(preview.stdout, /docs\/planning/);
  assert.match(preview.stdout, /notes\/reviews\/final-audit\.md/);
  assert.doesNotMatch(preview.stdout, /\.context-index/);
  for (const runtimePath of ["auth.json", "history.jsonl", "sessions", "state_1.sqlite"]) {
    assert.doesNotMatch(preview.stdout, new RegExp(runtimePath.replace(".", "\\.")));
  }
  assert.equal(existsSync(path.join(root, "docs/planning/current-goal.md")), true);

  const applied = run(root, ["--apply"]);
  assert.equal(applied.status, 0, applied.stderr);
  for (const removed of [
    "docs/planning",
    "notes/reviews/final-audit.md",
    "scripts/planning",
    ".project-state",
    "dist/exports",
  ]) {
    assert.equal(existsSync(path.join(root, ...removed.split("/"))), false, removed);
  }
  assert.equal(readFileSync(path.join(root, ".codex/history.jsonl"), "utf8"), "preserve me\n");
  assert.equal(readFileSync(path.join(root, "auth.json"), "utf8"), "project auth fixture\n");
  assert.equal(readFileSync(path.join(root, "history.jsonl"), "utf8"), "project history fixture\n");
  assert.equal(
    readFileSync(path.join(root, "sessions/thread.jsonl"), "utf8"),
    "project session fixture\n",
  );
  assert.equal(
    readFileSync(path.join(root, "state_1.sqlite"), "utf8"),
    "project database fixture\n",
  );
  assert.equal(readFileSync(path.join(root, ".context-index/manifest.json"), "utf8"), "{}\n");
  assert.equal(
    readFileSync(path.join(root, "src/index.ts"), "utf8"),
    "export const product = true;\n",
  );
  assert.equal(run(root).status, 0);
});
