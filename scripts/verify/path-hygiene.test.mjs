import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  activePathMarkerFindings,
  createPathMarkerScanner,
  neutralProductSourceFindings,
  productSourceBoundaryFindings,
} from "./path-hygiene.mjs";

test("path marker scanning is extension-independent and chunk-safe", () => {
  const scanner = createPathMarkerScanner(["private/workspace/project"]);
  scanner.write(Buffer.from("binary-prefix\0private/work"));
  scanner.write(Buffer.from("space/project\0suffix"));
  assert.deepEqual(scanner.matches(), ["private/workspace/project"]);
});

test("full active-source scan includes extension-neutral nested source", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "path-hygiene-nested-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const nested = path.join(root, "docs", "reference");
  mkdirSync(nested, { recursive: true });
  writeFileSync(
    path.join(nested, "example.py"),
    "workspace = '/private/workspace/project'\n",
    "utf8",
  );
  assert.deepEqual(
    activePathMarkerFindings({
      markers: ["private/workspace/project"],
      repositoryRoot: root,
    }),
    ['docs/reference/example.py: contains local path marker "private/workspace/project"'],
  );
});

test("default Product Root permits product files and the neutral placeholder", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "product-source-clean-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  mkdirSync(path.join(root, "src", "domain"), { recursive: true });
  writeFileSync(path.join(root, "src", ".gitkeep"), "", "utf8");
  writeFileSync(path.join(root, "src", "domain", "model.ts"), "export const model = true;\n");

  assert.deepEqual(productSourceBoundaryFindings({ repositoryRoot: root }), []);
  assert.deepEqual(neutralProductSourceFindings({ repositoryRoot: root }), [
    "src: neutral template must contain only the .gitkeep placeholder",
  ]);
});

test("neutral product source accepts only an empty real placeholder", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "neutral-product-source-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", ".gitkeep"), "");
  assert.deepEqual(neutralProductSourceFindings({ repositoryRoot: root }), []);

  writeFileSync(path.join(root, "src", ".gitkeep"), "not empty\n");
  assert.deepEqual(neutralProductSourceFindings({ repositoryRoot: root }), [
    "src/.gitkeep: neutral template placeholder must be a real empty file",
  ]);
});

test("default Product Root rejects missing, redirected, and nested agent state", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "product-source-polluted-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  assert.deepEqual(productSourceBoundaryFindings({ repositoryRoot: root }), [
    "src: required default product root is missing",
  ]);

  const outside = path.join(root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, path.join(root, "src"));
  assert.deepEqual(productSourceBoundaryFindings({ repositoryRoot: root }), [
    "src: default product root must be a real directory",
  ]);
  rmSync(path.join(root, "src"));

  mkdirSync(path.join(root, "src", "nested", ".agents", "skills"), { recursive: true });
  mkdirSync(path.join(root, "src", ".codex"), { recursive: true });
  writeFileSync(path.join(root, "src", "nested", "AGENTS.md"), "agent instructions\n");
  assert.deepEqual(productSourceBoundaryFindings({ repositoryRoot: root }), [
    "src/.codex: agent-only path is forbidden inside product unit src",
    "src/nested/.agents: agent-only path is forbidden inside product unit src",
    "src/nested/AGENTS.md: agent instruction path is forbidden inside product unit src",
  ]);
});

test("declared workspace and Android units reject nested agent or vector state", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "product-units-polluted-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", ".gitkeep"), "");
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n");
  mkdirSync(path.join(root, "apps", "web", "src"), { recursive: true });
  writeFileSync(path.join(root, "apps", "web", "package.json"), '{"name":"web"}\n');
  mkdirSync(path.join(root, "apps", "web", ".context-index"));
  writeFileSync(path.join(root, "settings.gradle.kts"), 'include(":app")\n');
  mkdirSync(path.join(root, "app", "src", "main"), { recursive: true });
  writeFileSync(path.join(root, "app", "build.gradle.kts"), "plugins {}\n");
  writeFileSync(path.join(root, "app", "src", "main", "AndroidManifest.xml"), "<manifest />\n");
  mkdirSync(path.join(root, "app", ".agents"));

  assert.deepEqual(productSourceBoundaryFindings({ repositoryRoot: root }), [
    "app/.agents: agent-only path is forbidden inside product unit app",
    "apps/web/.context-index: agent-only path is forbidden inside product unit apps/web",
  ]);
});
