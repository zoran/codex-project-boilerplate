import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { subagentModelPolicy, validateCodexConfig } from "./validate-codex-config.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDirectory, "..", "..");

export function validateModelCatalog(catalog, primaryModel, primaryReasoningEffort) {
  if (!catalog || !Array.isArray(catalog.models)) {
    throw new Error("Codex model catalog is missing its models array.");
  }
  const ranked = catalog.models
    .filter(
      (model) =>
        model?.visibility === "list" &&
        model.slug !== "codex-auto-review" &&
        Number.isFinite(model.priority),
    )
    .sort((left, right) => left.priority - right.priority);
  if (ranked.length < 2) throw new Error("Codex model catalog has fewer than two ranked models.");
  const [firstTier, secondTier] = ranked;
  if (secondTier.slug !== subagentModelPolicy.model) {
    throw new Error(
      `Pinned subagent model ${subagentModelPolicy.model} is no longer the catalog's second tier (${secondTier.slug}); update every project agent role explicitly before delegation.`,
    );
  }
  const efforts = new Set(
    (secondTier.supported_reasoning_levels ?? []).map((entry) => entry?.effort),
  );
  const requiredEfforts = [
    subagentModelPolicy.defaultReasoningEffort,
    subagentModelPolicy.elevatedReasoningEffort,
  ];
  const missingEfforts = requiredEfforts.filter((effort) => !efforts.has(effort));
  if (missingEfforts.length > 0) {
    throw new Error(
      `Pinned subagent model ${secondTier.slug} does not support required reasoning: ${missingEfforts.join(", ")}.`,
    );
  }
  if (![firstTier.slug, secondTier.slug].includes(primaryModel)) {
    throw new Error(
      `Primary model ${primaryModel} is below or outside the two allowed project tiers (${firstTier.slug}, ${secondTier.slug}).`,
    );
  }
  const primaryTier = firstTier.slug === primaryModel ? firstTier : secondTier;
  const unsupportedTiers = [primaryTier, secondTier].filter(
    (model) =>
      !(model.supported_reasoning_levels ?? []).some(
        (entry) => entry?.effort === primaryReasoningEffort,
      ),
  );
  if (unsupportedTiers.length > 0) {
    throw new Error(
      `Configured reasoning effort ${primaryReasoningEffort} is not supported by required model tiers: ${unsupportedTiers.map((model) => model.slug).join(", ")}.`,
    );
  }
  return {
    primaryModel,
    primaryReasoningEffort,
    firstTier: firstTier.slug,
    secondTier: secondTier.slug,
    defaultReasoningEffort: subagentModelPolicy.defaultReasoningEffort,
    elevatedReasoningEffort: subagentModelPolicy.elevatedReasoningEffort,
  };
}

export function validateInstalledCodexModelPolicy(projectRoot = defaultRoot) {
  const policy = validateCodexConfig(projectRoot);
  const result = spawnSync("codex", ["debug", "models", "--bundled"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: process.env,
    input: "",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr.trim() || `status ${result.status}`;
    throw new Error(`Unable to inspect the installed Codex model catalog: ${detail}`);
  }
  let catalog;
  try {
    catalog = JSON.parse(result.stdout);
  } catch {
    throw new Error("Installed Codex model catalog is not valid JSON.");
  }
  return validateModelCatalog(catalog, policy.model, policy.model_reasoning_effort);
}

function main() {
  try {
    const result = validateInstalledCodexModelPolicy();
    console.log(
      `Codex model policy passed (primary: ${result.primaryModel}; subagents: ${result.secondTier}; configured effort: ${result.primaryReasoningEffort}).`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
