import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDirectory, "..", "..");

const portablePolicy = new Map([
  ["project_doc_max_bytes", { type: "integer", value: 65_536 }],
  ["project_doc_fallback_filenames", { type: "string-array", value: ["instructions.md"] }],
  ["model_reasoning_effort", { type: "string", values: ["xhigh", "max", "ultra"] }],
  ["model_verbosity", { type: "string" }],
  ["web_search", { type: "string", value: "cached" }],
  ["model", { type: "string" }],
  ["service_tier", { type: "string", optional: true }],
  ["approvals_reviewer", { type: "string", value: "user" }],
  ["approval_policy", { type: "string", value: "never" }],
  ["sandbox_mode", { type: "string", value: "danger-full-access" }],
  ["network_access", { type: "string", value: "enabled" }],
  ["agents.max_threads", { type: "integer", value: 4 }],
  ["agents.max_depth", { type: "integer", value: 1 }],
  ["features.hooks", { type: "boolean" }],
  ["features.memories", { type: "boolean" }],
  ["features.network_proxy", { type: "boolean" }],
  ["features.prevent_idle_sleep", { type: "boolean" }],
  [
    "tui.status_line",
    {
      type: "string-array",
    },
  ],
  ["tui.status_line_use_colors", { type: "boolean" }],
  [
    "tui.terminal_title",
    {
      type: "string-array",
    },
  ],
  ["tui.theme", { type: "string" }],
]);
const portableTables = new Set(["agents", "features", "tui"]);
const requiredAgentRoles = new Set(["default", "explorer", "worker"]);
export const subagentModelPolicy = Object.freeze({
  model: "gpt-5.6-terra",
  defaultReasoningEffort: "xhigh",
  elevatedReasoningEffort: "ultra",
});

export class CodexConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "CodexConfigError";
  }
}

function stripComment(line, lineNumber) {
  let inString = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (inString && escaped) {
      escaped = false;
      continue;
    }
    if (inString && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      continue;
    }
    if (!inString && character === "#") return line.slice(0, index);
  }
  if (inString) throw new CodexConfigError(`Line ${lineNumber} has an unterminated string.`);
  return line;
}

function parseString(raw, lineNumber) {
  if (!/^"(?:[^"\\]|\\.)*"$/.test(raw)) {
    throw new CodexConfigError(`Line ${lineNumber} must use one double-quoted string value.`);
  }
  try {
    const value = JSON.parse(raw);
    if (typeof value !== "string") throw new Error("not a string");
    return value;
  } catch {
    throw new CodexConfigError(`Line ${lineNumber} contains an invalid quoted string.`);
  }
}

function splitArrayItems(raw, lineNumber) {
  const inner = raw.slice(1, -1).trim();
  if (!inner) return [];
  const items = [];
  let start = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index];
    if (inString && escaped) {
      escaped = false;
      continue;
    }
    if (inString && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      continue;
    }
    if (!inString && character === ",") {
      items.push(inner.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (inString) throw new CodexConfigError(`Line ${lineNumber} has an unterminated array string.`);
  items.push(inner.slice(start).trim());
  if (items.some((item) => !item)) {
    throw new CodexConfigError(`Line ${lineNumber} contains an empty array item.`);
  }
  return items;
}

function parseValue(raw, schema, lineNumber) {
  if (schema.type === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new CodexConfigError(`Line ${lineNumber} must use a TOML boolean.`);
  }
  if (schema.type === "integer") {
    if (!/^(?:0|[1-9]\d*)$/.test(raw)) {
      throw new CodexConfigError(`Line ${lineNumber} must use a non-negative decimal integer.`);
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) {
      throw new CodexConfigError(`Line ${lineNumber} exceeds the supported integer range.`);
    }
    return value;
  }
  if (schema.type === "string") return parseString(raw, lineNumber);
  if (!raw.startsWith("[") || !raw.endsWith("]")) {
    throw new CodexConfigError(`Line ${lineNumber} must use a one-line array of quoted strings.`);
  }
  return splitArrayItems(raw, lineNumber).map((item) => parseString(item, lineNumber));
}

function valuesMatch(actual, expected) {
  if (expected === undefined) {
    if (typeof actual === "string") return actual.trim().length > 0;
    if (Array.isArray(actual)) {
      return actual.length > 0 && actual.every((value) => value.trim().length > 0);
    }
    return true;
  }
  if (!Array.isArray(expected)) return actual === expected;
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function valueMatchesSchema(actual, schema) {
  return valuesMatch(actual, schema.value) && (!schema.values || schema.values.includes(actual));
}

export function parsePortableCodexConfig(content) {
  const parsed = new Map();
  const declaredTables = new Set();
  let currentTable = "";
  const lines = String(content)
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/);
  for (const [index, originalLine] of lines.entries()) {
    const lineNumber = index + 1;
    const line = stripComment(originalLine, lineNumber).trim();
    if (!line) continue;
    if (line.startsWith("[")) {
      const table = line.match(/^\[([A-Za-z_][A-Za-z0-9_-]*)\]$/)?.[1] ?? "";
      if (!portableTables.has(table)) {
        throw new CodexConfigError(`Line ${lineNumber} defines an unsupported table.`);
      }
      if (declaredTables.has(table)) {
        throw new CodexConfigError(`Line ${lineNumber} duplicates table ${table}.`);
      }
      declaredTables.add(table);
      currentTable = table;
      continue;
    }
    const assignment = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+)$/);
    if (!assignment) {
      throw new CodexConfigError(`Line ${lineNumber} is not a supported top-level assignment.`);
    }
    const [, localKey, rawValue] = assignment;
    const key = currentTable ? `${currentTable}.${localKey}` : localKey;
    const schema = portablePolicy.get(key);
    if (!schema) throw new CodexConfigError(`Line ${lineNumber} uses unknown key ${key}.`);
    if (parsed.has(key)) throw new CodexConfigError(`Line ${lineNumber} duplicates key ${key}.`);
    const value = parseValue(rawValue.trim(), schema, lineNumber);
    if (!valueMatchesSchema(value, schema)) {
      throw new CodexConfigError(
        `Line ${lineNumber} gives ${key} a value outside the portable project policy.`,
      );
    }
    parsed.set(key, value);
  }

  const missing = [...portablePolicy.entries()]
    .filter(([, schema]) => !schema.optional)
    .map(([key]) => key)
    .filter((key) => !parsed.has(key));
  if (missing.length > 0) {
    throw new CodexConfigError(`Missing portable project policy keys: ${missing.join(", ")}.`);
  }
  return Object.fromEntries(parsed);
}

function requireRegularFile(targetPath, label) {
  let stats;
  try {
    stats = lstatSync(targetPath);
  } catch {
    throw new CodexConfigError(`Missing ${label}.`);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new CodexConfigError(`${label} must be a non-symlink regular file.`);
  }
}

export function parseProjectAgentConfig(content, expectedName) {
  const schemas = new Map([
    ["name", { type: "string", value: expectedName }],
    ["description", { type: "string" }],
    ["model", { type: "string", value: subagentModelPolicy.model }],
    ["developer_instructions", { type: "string" }],
  ]);
  const parsed = new Map();
  const lines = String(content)
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/);
  for (const [index, originalLine] of lines.entries()) {
    const lineNumber = index + 1;
    const line = stripComment(originalLine, lineNumber).trim();
    if (!line) continue;
    const assignment = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+)$/);
    if (!assignment) {
      throw new CodexConfigError(
        `Agent ${expectedName} line ${lineNumber} is not a supported assignment.`,
      );
    }
    const [, key, rawValue] = assignment;
    const schema = schemas.get(key);
    if (!schema) {
      throw new CodexConfigError(
        `Agent ${expectedName} line ${lineNumber} uses unknown key ${key}.`,
      );
    }
    if (parsed.has(key)) {
      throw new CodexConfigError(`Agent ${expectedName} line ${lineNumber} duplicates key ${key}.`);
    }
    const value = parseValue(rawValue.trim(), schema, lineNumber);
    if (!valueMatchesSchema(value, schema)) {
      throw new CodexConfigError(
        `Agent ${expectedName} line ${lineNumber} violates the exact second-tier model policy.`,
      );
    }
    parsed.set(key, value);
  }
  const missing = [...schemas.keys()].filter((key) => !parsed.has(key));
  if (missing.length > 0) {
    throw new CodexConfigError(`Agent ${expectedName} is missing keys: ${missing.join(", ")}.`);
  }
  return Object.fromEntries(parsed);
}

export function validateProjectAgentConfigs(codexDirectory) {
  const agentsDirectory = path.join(codexDirectory, "agents");
  let stats;
  try {
    stats = lstatSync(agentsDirectory);
  } catch {
    throw new CodexConfigError("Missing project-scoped Codex agents directory.");
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new CodexConfigError("Project-scoped Codex agents path must be a non-symlink directory.");
  }
  const entries = readdirSync(agentsDirectory, { withFileTypes: true });
  const names = new Set();
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile() || !/^[a-z][a-z0-9_-]*\.toml$/.test(entry.name)) {
      throw new CodexConfigError(`Unsupported project agent entry: .codex/agents/${entry.name}.`);
    }
    const name = entry.name.slice(0, -".toml".length);
    names.add(name);
    const agentPath = path.join(agentsDirectory, entry.name);
    requireRegularFile(agentPath, `project agent ${name}`);
    parseProjectAgentConfig(readFileSync(agentPath, "utf8"), name);
  }
  const missing = [...requiredAgentRoles].filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new CodexConfigError(`Missing project agent roles: ${missing.join(", ")}.`);
  }
  return [...names].sort();
}

export function validateCodexConfig(projectRoot = defaultRoot) {
  const root = path.resolve(projectRoot);
  const codexDirectory = path.join(root, ".codex");
  const configPath = path.join(codexDirectory, "config.toml");
  let directoryStats;
  try {
    directoryStats = lstatSync(codexDirectory);
  } catch {
    throw new CodexConfigError("Missing project .codex directory.");
  }
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw new CodexConfigError("Project .codex path must be a non-symlink directory.");
  }
  requireRegularFile(configPath, "project-scoped Codex config");
  if (path.dirname(realpathSync(configPath)) !== realpathSync(codexDirectory)) {
    throw new CodexConfigError(
      "Project-scoped Codex config must remain directly under .codex/config.toml.",
    );
  }
  validateProjectAgentConfigs(codexDirectory);
  return parsePortableCodexConfig(readFileSync(configPath, "utf8"));
}

export function codexConfigOverrideArguments(policy) {
  const argumentsList = [];
  for (const [key, schema] of portablePolicy) {
    if (!Object.prototype.hasOwnProperty.call(policy, key)) {
      if (schema.optional) continue;
      throw new CodexConfigError(`Cannot render missing portable policy key ${key}.`);
    }
    argumentsList.push("-c", `${key}=${JSON.stringify(policy[key])}`);
  }
  return argumentsList;
}

function main() {
  try {
    const policy = validateCodexConfig();
    if (process.argv.includes("--print-cli-overrides")) {
      process.stdout.write(`${codexConfigOverrideArguments(policy).join("\n")}\n`);
      return;
    }
    console.log("Project-scoped Codex config matches the strict portable project policy.");
    console.log("The user Codex home was not read or written.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  main();
