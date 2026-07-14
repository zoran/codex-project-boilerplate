import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { detectStacks, formatStackReport } from "../stack/stack-detector.mjs";

export function webStackFailures(result) {
  const failures = [...result.failures];
  if (!result.hasWebSurface) return failures;

  const primaryByPackage = new Map();
  for (const framework of result.primaryWebFrameworks) {
    for (const packageRoot of framework.packageRoots.length > 0 ? framework.packageRoots : ["."]) {
      if (!primaryByPackage.has(packageRoot)) primaryByPackage.set(packageRoot, []);
      primaryByPackage.get(packageRoot).push(framework.label);
    }
  }

  for (const [packageRoot, labels] of primaryByPackage) {
    const uniqueLabels = [...new Set(labels)].sort((left, right) => left.localeCompare(right));
    if (uniqueLabels.length > 2) {
      failures.push(
        `${packageRoot}: too many primary web frameworks detected (${uniqueLabels.join(
          ", ",
        )}); document a migration boundary before adding more`,
      );
    }
  }
  return failures;
}

export function runWebStack(result = detectStacks()) {
  const failures = webStackFailures(result);
  if (failures.length > 0) {
    console.error("Web stack verification failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.log(formatStackReport(result, { webOnly: true }));
  console.log(
    result.hasWebSurface
      ? "Web stack verification passed."
      : "Web stack verification passed; no web surface detected.",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runWebStack();
}
