import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const commands = [
  {
    label: "dependency freshness",
    executable: process.execPath,
    args: ["scripts/deps/report.mjs"],
  },
  {
    label: "dependency advisory registry",
    executable: "pnpm",
    args: ["audit", "--audit-level", "high"],
  },
];

for (const command of commands) {
  console.log(`Running external ${command.label} check...`);
  const result = spawnSync(command.executable, command.args, {
    cwd: root,
    encoding: "utf8",
    input: "",
    stdio: "inherit",
    timeout: 180_000,
  });
  if (result.error) {
    console.error(`External verification is indeterminate: ${command.label} failed to start.`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(
      `External verification failed or is indeterminate: ${command.label} exited with status ${result.status}.`,
    );
    process.exit(1);
  }
}
console.log("External dependency freshness and advisory checks passed.");
