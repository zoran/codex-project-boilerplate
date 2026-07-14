import process from "node:process";
import {
  formatDependencyTable,
  readOutdated,
  readPolicy,
  validatePolicy,
} from "./dependency-policy.mjs";

function main() {
  const json = process.argv.includes("--json");
  const policy = readPolicy();
  const policyFailures = validatePolicy(policy);
  if (policyFailures.length > 0) {
    console.error("Dependency policy verification failed:");
    for (const failure of policyFailures) console.error(`- ${failure}`);
    process.exit(1);
  }

  const entries = readOutdated();
  if (json) {
    console.log(JSON.stringify({ outdated: entries }, null, 2));
    return;
  }

  console.log(formatDependencyTable(entries, policy));
}

try {
  main();
} catch (error) {
  console.error(`Dependency report failed: ${error.message}`);
  process.exit(1);
}
