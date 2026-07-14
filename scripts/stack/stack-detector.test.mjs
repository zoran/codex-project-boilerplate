import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { detectStacks } from "./stack-detector.mjs";

const roots = [];

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "stack-detector-"));
  roots.push(root);
  return root;
}

function write(root, relativePath, content) {
  const target = path.join(root, ...relativePath.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

after(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true });
});

test("stack detection follows declared workspace product roots", () => {
  const root = fixture();
  write(
    root,
    "package.json",
    JSON.stringify({ private: true, type: "module", packageManager: "pnpm@11.12.0" }),
  );
  write(root, "pnpm-workspace.yaml", "packages:\n  - 'apps/*'\n");
  write(
    root,
    "apps/client/package.json",
    JSON.stringify({ dependencies: { react: "^19.0.0", vite: "^7.0.0" } }),
  );
  write(root, "apps/client/src/App.tsx", "export function App() { return <main />; }\n");
  write(root, "components/ignored/package.json", '{"dependencies":{"next":"*"}}');
  write(root, "components/ignored/src/App.tsx", "export function App() { return <main />; }\n");

  const result = detectStacks({ root });
  const detected = new Set(result.stacks.map((stack) => stack.id));
  assert.equal(result.failures.length, 0);
  assert.equal(detected.has("javascript-node"), true);
  assert.equal(detected.has("react"), true);
  assert.equal(detected.has("vite"), true);
  assert.equal(detected.has("nextjs"), false);
});

test("large standalone HTML remains a first-class web surface", () => {
  const root = fixture();
  write(root, "src/archive.html", `<main>semantic content</main>${" ".repeat(600 * 1024)}`);

  const result = detectStacks({ root });
  const detected = new Set(result.stacks.map((stack) => stack.id));
  assert.equal(result.failures.length, 0);
  assert.equal(result.hasWebSurface, true);
  assert.equal(detected.has("standards-web"), true);
});
