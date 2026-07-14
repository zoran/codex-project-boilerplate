import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { detectStacks, formatStackReport } from "../stack/stack-detector.mjs";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function packageManagerFailures(root, readText) {
  const failures = [];
  const packagePath = path.join(root, "package.json");
  if (!existsSync(packagePath)) return failures;
  let packageJson;
  try {
    packageJson = JSON.parse(
      readText ? readText("package.json") : readFileSync(packagePath, "utf8"),
    );
  } catch {
    return ["package.json contains invalid JSON"];
  }
  const manager = String(packageJson.packageManager ?? "");
  if (!/^(pnpm|npm|yarn|bun)@\S+$/.test(manager)) {
    return ["package.json must pin a supported package manager and version"];
  }
  const selected = manager.split("@")[0];
  const lockfiles = {
    bun: ["bun.lock", "bun.lockb"],
    npm: ["package-lock.json"],
    pnpm: ["pnpm-lock.yaml"],
    yarn: ["yarn.lock"],
  };
  for (const [managerName, names] of Object.entries(lockfiles)) {
    for (const lockfile of names) {
      if (managerName !== selected && existsSync(path.join(root, lockfile))) {
        failures.push(`${lockfile} conflicts with packageManager ${selected}`);
      }
    }
  }
  if (!lockfiles[selected].some((lockfile) => existsSync(path.join(root, lockfile)))) {
    failures.push(`packageManager ${selected} has no matching lockfile`);
  }
  return failures;
}

export function stackStandardsFailures(result, { root = defaultRoot, readText } = {}) {
  return [...result.failures, ...packageManagerFailures(root, readText)];
}

export function runStackStandards(result = detectStacks({ root: defaultRoot }), options = {}) {
  const failures = stackStandardsFailures(result, {
    root: options.root ?? defaultRoot,
    readText: options.readText,
  });
  if (failures.length > 0) {
    console.error("Stack standards verification failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(formatStackReport(result));
  console.log("Stack standards verification passed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runStackStandards();
}
