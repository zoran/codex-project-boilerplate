import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const temporaryRoots = [];

export function temporaryRoot(prefix) {
  const value = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(value);
  return value;
}

export function cleanupTemporaryRoots() {
  for (const temporaryRootPath of temporaryRoots.splice(0)) {
    rmSync(temporaryRootPath, { force: true, recursive: true });
  }
}

export function run(executable, args, options = {}) {
  return spawnSync(executable, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    input: "",
    stdio: "pipe",
    timeout: 30_000,
  });
}

export function bashSingleQuotedArray(source, name) {
  const match = source.match(new RegExp(`^${name}=\\(\\n([\\s\\S]*?)^\\)$`, "m"));
  assert.ok(match, name);
  return match[1]
    .split("\n")
    .map((line) => line.trim().match(/^'([^']*)'$/)?.[1])
    .filter((value) => value !== undefined);
}

export const validPortableConfig = `# Portable policy; assignments in comments do not count.
project_doc_max_bytes = 65536 # bounded bootstrap context
project_doc_fallback_filenames = ["instructions.md"]
model_reasoning_effort = "xhigh"
model_verbosity = "medium"
web_search = "cached"
model = "gpt-5.6-sol"
service_tier = "fast"
approvals_reviewer = "user"
approval_policy = "never"
sandbox_mode = "danger-full-access"
network_access = "enabled"

[agents]
max_threads = 4
max_depth = 1

[features]
hooks = true
memories = true
network_proxy = true
prevent_idle_sleep = true

[tui]
status_line = ["model-with-reasoning", "model", "run-state", "weekly-limit", "five-hour-limit", "task-progress"]
status_line_use_colors = true
terminal_title = ["activity", "project-name", "five-hour-limit", "weekly-limit", "task-progress"]
theme = "catppuccin-mocha"
`;

export function writeProjectAgents(projectRoot) {
  const target = path.join(projectRoot, ".codex", "agents");
  mkdirSync(target, { recursive: true });
  for (const name of ["default", "explorer", "worker"]) {
    copyFileSync(
      path.join(root, ".codex", "agents", `${name}.toml`),
      path.join(target, `${name}.toml`),
    );
  }
}

export function writeProjectHookFiles(projectRoot) {
  mkdirSync(path.join(projectRoot, ".codex"), { recursive: true });
  copyFileSync(path.join(root, ".gitignore"), path.join(projectRoot, ".gitignore"));
  copyFileSync(
    path.join(root, ".codex", "hooks.json"),
    path.join(projectRoot, ".codex", "hooks.json"),
  );
  const contextDirectory = path.join(projectRoot, "scripts", "context");
  mkdirSync(contextDirectory, { recursive: true });
  for (const name of ["refresh-context-index-on-stop.sh", "refresh-context-index-on-stop.mjs"]) {
    copyFileSync(path.join(root, "scripts", "context", name), path.join(contextDirectory, name));
  }
}

export function configFixture(content = validPortableConfig) {
  const fixture = temporaryRoot("codex-config-");
  mkdirSync(path.join(fixture, ".codex"), { recursive: true });
  writeFileSync(path.join(fixture, ".codex", "config.toml"), content, "utf8");
  writeProjectHookFiles(fixture);
  writeProjectAgents(fixture);
  return fixture;
}
