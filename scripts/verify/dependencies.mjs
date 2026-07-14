import { spawnSync } from "node:child_process";
import process from "node:process";
import { readPolicy, root, validatePolicy } from "../deps/dependency-policy.mjs";

const failures = validatePolicy(readPolicy());
const lockCheck = spawnSync(
  "pnpm",
  ["install", "--lockfile-only", "--frozen-lockfile", "--ignore-scripts", "--offline"],
  {
    cwd: root,
    encoding: "utf8",
    input: "",
    stdio: "pipe",
    timeout: 120_000,
  },
);
if (lockCheck.error)
  failures.push(`lockfile consistency check failed to start: ${lockCheck.error.message}`);
else if (lockCheck.status !== 0) {
  failures.push(`manifests and pnpm-lock.yaml are inconsistent (status ${lockCheck.status})`);
}

if (failures.length > 0) {
  console.error("Dependency verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("Dependency policy and lockfile verification passed.");
