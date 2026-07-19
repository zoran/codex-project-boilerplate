import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { projectFormatFiles } from "./format-project.mjs";

test("format inventory always excludes repository-root Codex runtime", (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "format-project-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  writeFileSync(path.join(root, ".prettierignore"), "dist/\n", "utf8");
  writeFileSync(path.join(root, "auth.json"), "{}\n", "utf8");
  mkdirSync(path.join(root, "plugins"));
  writeFileSync(path.join(root, "plugins", "runtime.json"), "{}\n", "utf8");
  mkdirSync(path.join(root, ".codex"));
  writeFileSync(path.join(root, ".codex", "config.toml"), "sandbox_mode = 'fixture'\n", "utf8");
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "index.js"), "export const active = true;\n", "utf8");
  mkdirSync(path.join(root, "src", "plugins"));
  writeFileSync(
    path.join(root, "src", "plugins", "runtime.js"),
    "export const nestedProductPath = true;\n",
    "utf8",
  );

  const expected = [
    ".codex/config.toml",
    ".prettierignore",
    "src/index.js",
    "src/plugins/runtime.js",
  ];
  const previousCodexHome = process.env.CODEX_HOME;
  context.after(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  });
  delete process.env.CODEX_HOME;
  assert.deepEqual(projectFormatFiles(root), expected);
  process.env.CODEX_HOME = path.join(root, "external-home");
  assert.deepEqual(projectFormatFiles(root), expected);
});
