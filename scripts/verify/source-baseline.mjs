import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { neutralProductSourceFindings } from "./path-hygiene.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const productSourceFindings = neutralProductSourceFindings({ repositoryRoot: root });
if (productSourceFindings.length > 0) {
  console.error(
    `Boilerplate Product Roots baseline is not neutral: ${productSourceFindings.join(", ")}`,
  );
  process.exit(1);
}
const resetScript = path.join(
  root,
  ".agents",
  "skills",
  "reset-boilerplate",
  "scripts",
  "reset-boilerplate.mjs",
);
const resetTest = path.join(path.dirname(resetScript), "reset-boilerplate.test.mjs");
const testResult = spawnSync(process.execPath, ["--test", "--test-reporter=dot", resetTest], {
  cwd: root,
  encoding: "utf8",
  input: "",
  stdio: "inherit",
});
if (testResult.error) {
  console.error(`Source baseline regression failed to start: ${testResult.error.message}`);
  process.exit(1);
}
if (testResult.status !== 0) process.exit(testResult.status ?? 1);

const result = spawnSync(process.execPath, [resetScript], {
  cwd: root,
  encoding: "utf8",
  input: "",
  stdio: "inherit",
});

if (result.error) {
  console.error(`Source baseline verification failed to start: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
