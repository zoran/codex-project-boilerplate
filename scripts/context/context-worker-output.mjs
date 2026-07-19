import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { sanitizeMultilineForTerminal } from "./terminal-output.mjs";

const workerEnvName = "CONTEXT_INDEX_SANITIZED_WORKER";
const nativeWarningPatterns = [
  /\[[^\]\r\n]+ WARN\s+lance::dataset::write::insert\] No existing dataset at [^\r\n]+, it will be created\r?\n?/g,
];

export function stripKnownNativeContextWarnings(output) {
  let filtered = output;
  for (const pattern of nativeWarningPatterns) {
    filtered = filtered.replace(pattern, "");
  }
  return filtered;
}

function redactWorkerPaths(output, scriptUrl) {
  const scriptPath = fileURLToPath(scriptUrl);
  const repositoryRoot = path.resolve(path.dirname(scriptPath), "..", "..");
  return sanitizeMultilineForTerminal(output, repositoryRoot);
}

export function runAsSanitizedContextWorker(scriptUrl) {
  if (process.env[workerEnvName] === "1") return false;

  const result = spawnSync(process.execPath, [fileURLToPath(scriptUrl), ...process.argv.slice(2)], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, [workerEnvName]: "1" },
    input: "",
    stdio: "pipe",
    maxBuffer: 4 * 1024 * 1024,
  });

  const stdout = redactWorkerPaths(result.stdout ?? "", scriptUrl);
  if (stdout) process.stdout.write(stdout);

  const stderr = redactWorkerPaths(stripKnownNativeContextWarnings(result.stderr ?? ""), scriptUrl);
  if (stderr) process.stderr.write(stderr);

  if (result.error) {
    console.error("Context index worker failed to start.");
    process.exit(1);
  }
  if (result.signal) {
    console.error(`Context index worker terminated by signal ${result.signal}.`);
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}
