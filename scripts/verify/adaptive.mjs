import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import process from "node:process";
import {
  buildPlan,
  completeVerificationCommands,
  dedupeCommands,
  discoverWorkspaceManifests,
  runPlan,
  verificationCommand,
  workspaceLifecycleCommands,
} from "./adaptive-runner.mjs";
import {
  normalizePath,
  parsePorcelainStatus,
  parsePrePushInput,
  unique,
  validateCurrentCheckoutForPush,
  validatePushedRefsAgainstHead,
} from "./adaptive-state.mjs";

const modes = new Set(["repo", "full", "pre-push"]);

function usage() {
  console.log(`Usage: node scripts/verify/adaptive.mjs [options]

Options:
  --mode <repo|full|pre-push>        Verification entry point. Default: repo.
  --print-plan                       Print selected checks without running them.
  --path <path>                      Simulate a changed path for plan inspection.
  --self-test                        Run focused orchestration regression fixtures.
  --validate-pre-push-refs           Validate clean HEAD against Git pre-push stdin.
`);
}

export function parseArgs(argv) {
  const options = {
    mode: "repo",
    printPlan: false,
    simulatedPaths: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--print-plan") {
      options.printPlan = true;
    } else if (arg === "--mode") {
      options.mode = argv[++index] ?? "";
    } else if (arg.startsWith("--mode=")) {
      options.mode = arg.slice("--mode=".length);
    } else if (arg === "--path") {
      options.simulatedPaths.push(argv[++index] ?? "");
    } else if (arg.startsWith("--path=")) {
      options.simulatedPaths.push(arg.slice("--path=".length));
    } else {
      throw new Error(`Unknown adaptive verification argument: ${arg}`);
    }
  }

  if (!modes.has(options.mode)) {
    throw new Error(`Invalid adaptive verification mode: ${options.mode}`);
  }
  options.simulatedPaths = unique(options.simulatedPaths.map(normalizePath).filter(Boolean));
  return options;
}

function fixtureOptions(overrides = {}) {
  return {
    mode: "repo",
    printPlan: true,
    simulatedPaths: [],
    ...overrides,
  };
}

function assertCommandKeys(commands, expectedKeys) {
  const keys = new Set(commands.map((command) => command.key));
  for (const expectedKey of expectedKeys) {
    assert.equal(keys.has(expectedKey), true, `missing verification command ${expectedKey}`);
  }
}

export function runSelfTests() {
  const productLayout = {
    findings: [],
    sourceRoots: ["app/src/main", "apps/site/src", "src"],
    units: [
      {
        root: ".",
        sourceRoots: ["src"],
        surfaceRoot: "src",
        kind: "default",
        declaredBy: "fixture",
      },
      {
        root: "app",
        sourceRoots: ["app/src/main"],
        surfaceRoot: "app",
        kind: "android",
        declaredBy: "app/build.gradle.kts",
      },
      {
        root: "apps/site",
        sourceRoots: ["apps/site/src"],
        surfaceRoot: "apps/site",
        kind: "workspace",
        declaredBy: "apps/site/package.json",
      },
    ],
  };
  const completePlan = buildPlan(fixtureOptions({ mode: "full" }), {
    gitAvailable: true,
    changedPaths: [],
    productLayout,
    workspaceManifests: [],
  });
  assert.equal(completePlan.verificationScope, "complete");
  assertCommandKeys(completePlan.readOnlyCommands, [
    "syntax-lint",
    "docs",
    "scripts",
    "repository-smoke",
    "skills",
    "codex-config",
    "dependencies",
    "dependency-regressions",
    "secrets",
    "language",
    "patterns",
    "context-policy",
    "context-regressions",
    "setup-regressions",
    "verification-boundary-regressions",
    "path-hygiene",
    "surface-quality",
    "api-security",
    "adaptive-regressions",
    "format",
  ]);
  const prePushPlan = buildPlan(fixtureOptions({ mode: "pre-push" }), {
    gitAvailable: true,
    changedPaths: [],
    productLayout,
    workspaceManifests: [],
  });
  for (const plan of [completePlan, prePushPlan]) {
    const commands = [...plan.readOnlyCommands, ...plan.workspaceCommands];
    assert.equal(
      commands.some((command) =>
        command.args.some((argument) =>
          /scripts\/context\/(?:index-codebase|search-context|check-context-index)\.mjs$/.test(
            argument,
          ),
        ),
      ),
      false,
      "verify and pre-push plans must not refresh or repair the real context index",
    );
  }
  const cleanChangedPlan = buildPlan(fixtureOptions(), {
    gitAvailable: true,
    changedPaths: [],
    productLayout,
    workspaceManifests: [],
  });
  assert.equal(cleanChangedPlan.verificationScope, "targeted feedback");
  assert.equal(cleanChangedPlan.readOnlyCommands.length, 0);
  assert.equal(cleanChangedPlan.workspaceCommands.length, 0);

  const unknownPlan = buildPlan(fixtureOptions(), {
    gitAvailable: true,
    changedPaths: ["unexpected/new-surface.bin"],
    productLayout,
    workspaceManifests: [],
  });
  assert.equal(unknownPlan.verificationScope, "complete");
  assertCommandKeys(unknownPlan.readOnlyCommands, ["syntax-lint", "docs", "secrets", "patterns"]);

  const frameworkScriptPlan = buildPlan(fixtureOptions(), {
    gitAvailable: true,
    changedPaths: ["scripts/unknown/future-policy.mjs"],
    productLayout,
    workspaceManifests: [],
  });
  assert.equal(frameworkScriptPlan.verificationScope, "complete");

  const contextScriptPlan = buildPlan(fixtureOptions(), {
    gitAvailable: true,
    changedPaths: ["scripts/context/context-ranking.mjs"],
    productLayout,
    workspaceManifests: [],
  });
  assert.equal(contextScriptPlan.verificationScope, "targeted feedback");
  assertCommandKeys(contextScriptPlan.readOnlyCommands, [
    "syntax-lint",
    "scripts",
    "context-policy",
    "context-regressions",
    "verification-boundary-regressions",
    "patterns",
  ]);
  assert.equal(
    contextScriptPlan.readOnlyCommands.length < completePlan.readOnlyCommands.length,
    true,
  );

  for (const retrievalPolicyPath of [
    "AGENTS.md",
    ".agents/skills/context-retrieval/agents/openai.yaml",
    ".agents/skills/project-implementation/SKILL.md",
    ".agents/skills/resume-project/SKILL.md",
    ".codex/agents/explorer.toml",
    "scripts/context/portable-context-contract.mjs",
  ]) {
    const retrievalPolicyPlan = buildPlan(fixtureOptions(), {
      gitAvailable: true,
      changedPaths: [retrievalPolicyPath],
      productLayout,
      workspaceManifests: [],
    });
    assert.equal(
      retrievalPolicyPlan.classifiedPaths[0].categories.includes("context source-policy surface"),
      true,
      retrievalPolicyPath,
    );
    assertCommandKeys(retrievalPolicyPlan.readOnlyCommands, [
      "context-policy",
      "context-regressions",
      "verification-boundary-regressions",
    ]);
  }

  const hookConfigPlan = buildPlan(fixtureOptions(), {
    gitAvailable: true,
    changedPaths: [".codex/hooks.json"],
    productLayout,
    workspaceManifests: [],
  });
  assert.equal(hookConfigPlan.classifiedPaths[0].categories.includes("project Codex config"), true);
  assertCommandKeys(hookConfigPlan.readOnlyCommands, ["codex-config", "secrets", "path-hygiene"]);

  for (const imagePolicyPath of [
    "scripts/verify/adaptive-surfaces.mjs",
    "scripts/verify/adaptive-surfaces.test.mjs",
    "scripts/verify/image-assets.mjs",
    "scripts/verify/image-assets.test.mjs",
    "scripts/verify/surface-quality.mjs",
    "scripts/verify/surface-quality.test.mjs",
  ]) {
    const imagePolicyPlan = buildPlan(fixtureOptions(), {
      gitAvailable: true,
      changedPaths: [imagePolicyPath],
      productLayout,
      workspaceManifests: [],
    });
    assert.equal(
      imagePolicyPlan.classifiedPaths[0].categories.includes("image quality surface"),
      true,
      imagePolicyPath,
    );
    assertCommandKeys(imagePolicyPlan.readOnlyCommands, [
      "surface-quality",
      "verification-boundary-regressions",
    ]);
  }

  const skillExecutablePlan = buildPlan(fixtureOptions(), {
    gitAvailable: true,
    changedPaths: [".agents/skills/example/scripts/runner.mjs"],
    productLayout,
    workspaceManifests: [],
  });
  assert.equal(skillExecutablePlan.verificationScope, "targeted feedback");
  assertCommandKeys(skillExecutablePlan.readOnlyCommands, [
    "syntax-lint",
    "setup-regressions",
    "skills",
  ]);

  for (const applicationPath of [
    "src/page.mdx",
    "apps/site/src/page.mdx",
    "apps/site/public/logo.png",
    "app/src/main/java/App.kt",
  ]) {
    const applicationPlan = buildPlan(fixtureOptions(), {
      gitAvailable: true,
      changedPaths: [applicationPath],
      productLayout,
      workspaceManifests: [],
    });
    assert.equal(
      applicationPlan.verificationScope,
      "complete",
      `${applicationPath} must receive application-wide coverage`,
    );
  }

  const unconventionalApplicationPlan = buildPlan(fixtureOptions(), {
    gitAvailable: true,
    changedPaths: ["modules/jobs/worker.ts"],
    productLayout,
    workspaceManifests: [],
  });
  assert.equal(unconventionalApplicationPlan.verificationScope, "complete");
  assert.equal(
    unconventionalApplicationPlan.classifiedPaths[0].categories.includes(
      "app/package/service/runtime source",
    ),
    false,
  );

  const noSurfacePlan = buildPlan(fixtureOptions({ mode: "full" }), {
    gitAvailable: true,
    changedPaths: [],
    productLayout,
    workspaceManifests: [],
  });
  const noSurfaceKeys = new Set(noSurfacePlan.readOnlyCommands.map((command) => command.key));
  assert.equal(
    noSurfaceKeys.has("surface-quality"),
    true,
    "one surface owner must decide conditional checks from one snapshot",
  );
  assert.equal(noSurfaceKeys.has("api-security"), true);
  const documentationPlan = buildPlan(fixtureOptions(), {
    gitAvailable: true,
    changedPaths: ["docs/project.md"],
    productLayout,
    workspaceManifests: [],
  });
  assert.equal(documentationPlan.verificationScope, "targeted feedback");
  assert.equal(
    documentationPlan.readOnlyCommands.every((command) =>
      command.reason.startsWith("targeted development feedback for "),
    ),
    true,
  );
  const duplicate = verificationCommand({
    key: "fixture",
    label: "fixture",
    executable: process.execPath,
    args: ["--version"],
    reason: "fixture",
  });
  assert.equal(dedupeCommands([duplicate, { ...duplicate }]).length, 1);
  assert.throws(
    () => dedupeCommands([duplicate, { ...duplicate, args: ["--help"] }]),
    /conflicting definitions/,
  );

  const lifecycleCommands = workspaceLifecycleCommands([
    {
      directory: ".",
      scripts: { build: "pnpm -r --if-present build", test: "node --test" },
    },
    { directory: "products/one", scripts: { build: "build", test: "test" } },
    { directory: "modules/two", scripts: { build: "build", "test:unit": "unit" } },
  ]);
  assert.deepEqual(
    lifecycleCommands.map((command) => command.key),
    ["workspace:build", "workspace:test", "workspace:test:unit"],
  );
  assert.equal(
    lifecycleCommands.find((command) => command.key === "workspace:build")?.args.includes("."),
    false,
    "recursive root build aggregator must not run and duplicate workspace builds",
  );
  assert.equal(
    lifecycleCommands.find((command) => command.key === "workspace:test")?.args.includes("."),
    true,
    "root-owned lifecycle scripts must participate",
  );
  assert.equal(
    lifecycleCommands.every((command) => command.args[0] === "--recursive"),
    true,
  );
  assert.equal(
    discoverWorkspaceManifests().some((manifest) => manifest.directory === "."),
    true,
    "pnpm workspace discovery must include the root manifest",
  );

  const headObject = "a".repeat(40);
  const zeroObject = "0".repeat(40);
  const parsedRefs = parsePrePushInput(
    [
      `refs/heads/main ${headObject} refs/heads/main ${zeroObject}`,
      `(delete) ${zeroObject} refs/heads/old ${headObject}`,
    ].join("\n"),
  );
  assert.equal(parsedRefs.length, 2);
  assert.deepEqual(
    validatePushedRefsAgainstHead(parsedRefs, {
      headObject,
      resolveCommit: () => headObject,
    }),
    [headObject],
  );
  assert.throws(
    () =>
      validatePushedRefsAgainstHead(parsedRefs, {
        headObject: "b".repeat(40),
        resolveCommit: () => headObject,
      }),
    /does not match the clean checked-out HEAD/,
  );

  assert.deepEqual(
    parsePorcelainStatus(
      ` M docs/one.md\0R  scripts/new.mjs\0scripts/old.mjs\0?? fresh-file.txt\0`,
    ),
    ["docs/one.md", "fresh-file.txt", "scripts/new.mjs", "scripts/old.mjs"],
  );

  const completeKeys = completeVerificationCommands({
    hasImageSurface: true,
    hasWebSurface: true,
  }).map((command) => command.key);
  assert.equal(completeKeys.length, new Set(completeKeys).size);
  console.log("Adaptive verification regression fixtures passed.");
}

function validatePrePushRefs() {
  const input = process.stdin.isTTY ? "" : readFileSync(0, "utf8");
  const result = validateCurrentCheckoutForPush(input);
  const scope = result.directInvocation
    ? "direct clean HEAD invocation"
    : `${result.pushedCommits.length} pushed commit object(s)`;
  console.log(`Pre-push commit scope validated: ${scope}.`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) {
    if (argv.some((arg) => arg !== "--self-test" && arg !== "--")) {
      throw new Error("--self-test cannot be combined with verification plan options.");
    }
    runSelfTests();
    return;
  }
  if (argv.includes("--validate-pre-push-refs")) {
    if (argv.some((arg) => arg !== "--validate-pre-push-refs" && arg !== "--")) {
      throw new Error(
        "--validate-pre-push-refs cannot be combined with verification plan options.",
      );
    }
    validatePrePushRefs();
    return;
  }
  await runPlan(buildPlan(parseArgs(argv)));
}

try {
  await main();
} catch (error) {
  console.error(`Adaptive verification failed: ${error.message}`);
  process.exit(1);
}
