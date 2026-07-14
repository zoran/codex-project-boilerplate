import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CodexConfigError,
  parseProjectAgentConfig,
  parsePortableCodexConfig,
  subagentModelPolicy,
  validateCodexConfig,
  validateProjectAgentConfigs,
} from "./validate-codex-config.mjs";
import { validateModelCatalog } from "./validate-codex-model-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const temporaryRoots = [];

function temporaryRoot(prefix) {
  const value = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(value);
  return value;
}

after(() => {
  for (const temporaryRootPath of temporaryRoots) {
    rmSync(temporaryRootPath, { force: true, recursive: true });
  }
});

function run(executable, args, options = {}) {
  return spawnSync(executable, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    input: "",
    stdio: "pipe",
    timeout: 30_000,
  });
}

const validPortableConfig = `# Portable policy; assignments in comments do not count.
project_doc_max_bytes = 65536 # bounded bootstrap context
project_doc_fallback_filenames = ["instructions.md"]
model_reasoning_effort = "xhigh"
model_verbosity = "medium"
web_search = "cached"
model = "gpt-5.6-sol"
service_tier = "fast"
approvals_reviewer = "user"
approval_policy = "never"
sandbox_mode = "danger-full-access"
network_access = "enabled"

[agents]
max_threads = 4
max_depth = 1

[features]
hooks = true
memories = true
network_proxy = true
prevent_idle_sleep = true

[tui]
status_line = ["model-with-reasoning", "model", "run-state", "weekly-limit", "five-hour-limit", "task-progress"]
status_line_use_colors = true
terminal_title = ["activity", "project-name", "five-hour-limit", "weekly-limit", "task-progress"]
theme = "catppuccin-mocha"
`;

function writeProjectAgents(projectRoot) {
  const target = path.join(projectRoot, ".codex", "agents");
  mkdirSync(target, { recursive: true });
  for (const name of ["default", "explorer", "worker"]) {
    copyFileSync(
      path.join(root, ".codex", "agents", `${name}.toml`),
      path.join(target, `${name}.toml`),
    );
  }
}

function configFixture(content = validPortableConfig) {
  const fixture = temporaryRoot("codex-config-");
  mkdirSync(path.join(fixture, ".codex"), { recursive: true });
  writeFileSync(path.join(fixture, ".codex", "config.toml"), content, "utf8");
  writeProjectAgents(fixture);
  return fixture;
}

test("Codex config parser accepts only the complete typed portable policy", () => {
  assert.deepEqual(validateCodexConfig(configFixture()), {
    project_doc_max_bytes: 65_536,
    project_doc_fallback_filenames: ["instructions.md"],
    model_reasoning_effort: "xhigh",
    model_verbosity: "medium",
    web_search: "cached",
    model: "gpt-5.6-sol",
    service_tier: "fast",
    approvals_reviewer: "user",
    approval_policy: "never",
    sandbox_mode: "danger-full-access",
    network_access: "enabled",
    "agents.max_threads": 4,
    "agents.max_depth": 1,
    "features.hooks": true,
    "features.memories": true,
    "features.network_proxy": true,
    "features.prevent_idle_sleep": true,
    "tui.status_line": [
      "model-with-reasoning",
      "model",
      "run-state",
      "weekly-limit",
      "five-hour-limit",
      "task-progress",
    ],
    "tui.status_line_use_colors": true,
    "tui.terminal_title": [
      "activity",
      "project-name",
      "five-hour-limit",
      "weekly-limit",
      "task-progress",
    ],
    "tui.theme": "catppuccin-mocha",
  });

  const customizedProjectDefaults = validPortableConfig
    .replace('model = "gpt-5.6-sol"', 'model = "gpt-5.6-terra"')
    .replace('model_reasoning_effort = "xhigh"', 'model_reasoning_effort = "ultra"')
    .replace("memories = true", "memories = false")
    .replace('theme = "catppuccin-mocha"', 'theme = "light"');
  const customizedPolicy = parsePortableCodexConfig(customizedProjectDefaults);
  assert.equal(customizedPolicy.model, "gpt-5.6-terra");
  assert.equal(customizedPolicy.model_reasoning_effort, "ultra");

  const standardTierPolicy = parsePortableCodexConfig(
    validPortableConfig.replace('service_tier = "fast"\n', ""),
  );
  assert.equal(Object.hasOwn(standardTierPolicy, "service_tier"), false);

  for (const [label, content, expected] of [
    [
      "commented required value",
      validPortableConfig.replace('approval_policy = "never"', '# approval_policy = "never"'),
      /Missing portable project policy keys: approval_policy/,
    ],
    [
      "duplicate contradiction",
      validPortableConfig.replace(
        'approval_policy = "never"',
        'approval_policy = "never"\napproval_policy = "on-request"',
      ),
      /duplicates key approval_policy/,
    ],
    [
      "unknown key",
      validPortableConfig.replace("[features]", 'unsafe_path = "/tmp"\n\n[features]'),
      /unknown key agents\.unsafe_path/,
    ],
    ["unknown table", `${validPortableConfig}[profiles.local]\n`, /unsupported table/],
    [
      "wrong type",
      validPortableConfig.replace(
        "project_doc_max_bytes = 65536",
        'project_doc_max_bytes = "65536"',
      ),
      /non-negative decimal integer/,
    ],
    [
      "wrong allowed value",
      validPortableConfig.replace('web_search = "cached"', 'web_search = "live"'),
      /outside the portable project policy/,
    ],
    [
      "unsupported reasoning level",
      validPortableConfig.replace(
        'model_reasoning_effort = "xhigh"',
        'model_reasoning_effort = "high"',
      ),
      /outside the portable project policy/,
    ],
    [
      "wrong table value type",
      validPortableConfig.replace("hooks = true", 'hooks = "true"'),
      /TOML boolean/,
    ],
  ]) {
    assert.throws(
      () => parsePortableCodexConfig(content),
      (error) => error instanceof CodexConfigError && expected.test(error.message),
      label,
    );
  }
});

test("project subagent roles fix the second model tier and inherit the primary effort", () => {
  const defaultAgent = readFileSync(path.join(root, ".codex", "agents", "default.toml"), "utf8");
  assert.equal(parseProjectAgentConfig(defaultAgent, "default").model, subagentModelPolicy.model);
  assert.throws(
    () =>
      parseProjectAgentConfig(
        defaultAgent.replace('model = "gpt-5.6-terra"', 'model = "gpt-5.6-sol"'),
        "default",
      ),
    /exact second-tier model policy/,
  );
  assert.throws(
    () =>
      parseProjectAgentConfig(
        defaultAgent.replace('model = "gpt-5.6-terra"', 'model = "gpt-5.6-luna"'),
        "default",
      ),
    /exact second-tier model policy/,
  );
  assert.throws(
    () => parseProjectAgentConfig(`${defaultAgent}model_reasoning_effort = "high"\n`, "default"),
    /unknown key model_reasoning_effort/,
  );

  const fixture = configFixture();
  rmSync(path.join(fixture, ".codex", "agents", "worker.toml"));
  assert.throws(
    () => validateProjectAgentConfigs(path.join(fixture, ".codex")),
    /Missing project agent roles: worker/,
  );
});

test("installed model catalog permits only first-tier or second-tier primaries and Terra subagents", () => {
  const catalog = {
    models: [
      {
        slug: "gpt-5.6-sol",
        priority: 1,
        visibility: "list",
        supported_reasoning_levels: [{ effort: "xhigh" }, { effort: "max" }, { effort: "ultra" }],
      },
      {
        slug: "gpt-5.6-terra",
        priority: 2,
        visibility: "list",
        supported_reasoning_levels: [{ effort: "xhigh" }, { effort: "max" }, { effort: "ultra" }],
      },
      {
        slug: "gpt-5.6-luna",
        priority: 3,
        visibility: "list",
        supported_reasoning_levels: [{ effort: "xhigh" }, { effort: "max" }, { effort: "ultra" }],
      },
    ],
  };
  assert.equal(validateModelCatalog(catalog, "gpt-5.6-sol", "xhigh").secondTier, "gpt-5.6-terra");
  assert.equal(
    validateModelCatalog(catalog, "gpt-5.6-terra", "xhigh").primaryModel,
    "gpt-5.6-terra",
  );
  assert.throws(() => validateModelCatalog(catalog, "gpt-5.6-luna", "xhigh"), /below or outside/);
  const terraMissing = structuredClone(catalog);
  terraMissing.models[1].slug = "gpt-5.6-luna";
  assert.throws(
    () => validateModelCatalog(terraMissing, "gpt-5.6-sol", "xhigh"),
    /no longer.*second tier/,
  );
  const defaultEffortMissing = structuredClone(catalog);
  defaultEffortMissing.models[1].supported_reasoning_levels = [
    { effort: "max" },
    { effort: "ultra" },
  ];
  assert.throws(
    () => validateModelCatalog(defaultEffortMissing, "gpt-5.6-sol", "xhigh"),
    /required reasoning: xhigh/,
  );
  const primaryEffortMissing = structuredClone(catalog);
  primaryEffortMissing.models[0].supported_reasoning_levels = [
    { effort: "max" },
    { effort: "ultra" },
  ];
  assert.throws(
    () => validateModelCatalog(primaryEffortMissing, "gpt-5.6-sol", "xhigh"),
    /configured reasoning effort xhigh.*gpt-5\.6-sol/i,
  );
});

test("Codex launcher uses the user home and starts without project runtimes", () => {
  const fixture = temporaryRoot("codex-launcher-");
  const setupDirectory = path.join(fixture, "scripts", "setup");
  const binDirectory = path.join(fixture, "bin");
  mkdirSync(setupDirectory, { recursive: true });
  mkdirSync(path.join(fixture, ".codex"), { recursive: true });
  writeFileSync(path.join(fixture, ".codex", "config.toml"), validPortableConfig, "utf8");
  writeProjectAgents(fixture);
  mkdirSync(binDirectory);
  const launcher = path.join(setupDirectory, "start-codex.sh");
  copyFileSync(path.join(root, "scripts/setup/start-codex.sh"), launcher);
  copyFileSync(
    path.join(root, "scripts/setup/validate-codex-bootstrap.sh"),
    path.join(setupDirectory, "validate-codex-bootstrap.sh"),
  );
  chmodSync(launcher, 0o755);

  const capturePath = path.join(fixture, "capture.txt");
  const userCodexHome = path.join(fixture, "user-codex-home");
  const fakeCodex = path.join(binDirectory, "codex");
  writeFileSync(
    fakeCodex,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'printf \'%s\\0\' "${CODEX_HOME-}" "${OPENAI_API_KEY-}" "$@" > "$CAPTURE_PATH"',
    ].join("\n"),
    "utf8",
  );
  chmodSync(fakeCodex, 0o755);

  const result = run("bash", [launcher, "--fixture"], {
    cwd: fixture,
    env: {
      CAPTURE_PATH: capturePath,
      CODEX_HOME: userCodexHome,
      OPENAI_API_KEY: "global-secret-fixture",
      PATH: `${binDirectory}:/usr/bin:/bin`,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const fields = readFileSync(capturePath, "utf8").split("\0").filter(Boolean);
  assert.deepEqual(fields, [userCodexHome, "global-secret-fixture", "--cd", fixture, "--fixture"]);
  assert.equal(existsSync(path.join(fixture, ".codex", "runtime")), false);

  rmSync(capturePath);
  for (const override of [
    ["--cd", "/tmp/other-project"],
    ["--cd=/tmp/other-project"],
    ["-C", "/tmp/other-project"],
    ["-C/tmp/other-project"],
  ]) {
    const rejected = run("bash", [launcher, ...override], {
      cwd: fixture,
      env: { PATH: `${binDirectory}:/usr/bin:/bin` },
    });
    assert.equal(rejected.status, 64, `${override.join(" ")}\n${rejected.stderr}`);
    assert.match(rejected.stderr, /working-root override/);
    assert.equal(existsSync(capturePath), false);
  }

  for (const override of [
    ["--add-dir", "/tmp/other-project"],
    ["--add-dir=/tmp/other-project"],
    ["-c", 'sandbox_mode="workspace-write"'],
    ['--config=approval_policy="on-request"'],
    ["-p", "unsafe-profile"],
    ["--sandbox", "workspace-write"],
    ["-a", "on-request"],
    ["--dangerously-bypass-approvals-and-sandbox"],
    ["--enable", "unreviewed-feature"],
    ["--disable=memories"],
    ["--model", "untracked-model"],
    ["-mcompact-model"],
    ["--search"],
    ["--remote", "wss://example.invalid"],
    ["--remote-auth-token-env=TOKEN"],
    ["--dangerously-bypass-hook-trust"],
    ["--oss"],
    ["--local-provider", "ollama"],
    ["--image", "/tmp/outside.png"],
  ]) {
    const rejected = run("bash", [launcher, ...override], {
      cwd: fixture,
      env: { PATH: `${binDirectory}:/usr/bin:/bin` },
    });
    assert.equal(rejected.status, 64, `${override.join(" ")}\n${rejected.stderr}`);
    assert.match(
      rejected.stderr,
      /(additional writable root|project-policy override|untracked feature)/,
    );
    assert.equal(existsSync(capturePath), false);
  }

  const promptNamedLikeAnOption = run("bash", [launcher, "--", "--cd", "prompt text"], {
    cwd: fixture,
    env: {
      CAPTURE_PATH: capturePath,
      CODEX_HOME: userCodexHome,
      OPENAI_API_KEY: "global-secret-fixture",
      PATH: `${binDirectory}:/usr/bin:/bin`,
    },
  });
  assert.equal(promptNamedLikeAnOption.status, 0, promptNamedLikeAnOption.stderr);
  assert.deepEqual(readFileSync(capturePath, "utf8").split("\0").filter(Boolean).slice(2), [
    "--cd",
    fixture,
    "--",
    "--cd",
    "prompt text",
  ]);

  rmSync(capturePath, { force: true });
  const configPath = path.join(fixture, ".codex", "config.toml");
  writeFileSync(
    configPath,
    `${validPortableConfig}\n[mcp_servers.fixture]\ncommand = "/bin/false"\n`,
    "utf8",
  );
  const executableConfig = run("bash", [launcher], {
    cwd: fixture,
    env: { PATH: `${binDirectory}:/usr/bin:/bin` },
  });
  assert.notEqual(executableConfig.status, 0);
  assert.match(executableConfig.stderr, /unsupported table/i);
  assert.equal(existsSync(capturePath), false);

  writeFileSync(configPath, validPortableConfig, "utf8");
  const outside = path.join(fixture, "outside-config.toml");
  writeFileSync(outside, validPortableConfig, "utf8");
  rmSync(configPath);
  symlinkSync(outside, configPath);
  const unsafe = run("bash", [launcher], {
    cwd: fixture,
    env: { PATH: `${binDirectory}:/usr/bin:/bin` },
  });
  assert.notEqual(unsafe.status, 0);
  assert.match(unsafe.stderr, /real file/i);
});

test("hook installation is managed and never overwrites an unrelated hook", () => {
  const fixture = temporaryRoot("codex-hooks-");
  mkdirSync(path.join(fixture, "scripts", "setup"), { recursive: true });
  mkdirSync(path.join(fixture, "scripts", "git-hooks"), { recursive: true });
  const installer = path.join(fixture, "scripts", "setup", "install-git-hooks.sh");
  const pathResolver = path.join(fixture, "scripts", "setup", "resolve-git-hooks-path.mjs");
  const sourceHook = path.join(fixture, "scripts", "git-hooks", "pre-push");
  copyFileSync(path.join(root, "scripts/setup/install-git-hooks.sh"), installer);
  copyFileSync(path.join(root, "scripts/setup/resolve-git-hooks-path.mjs"), pathResolver);
  copyFileSync(path.join(root, "scripts/git-hooks/pre-push"), sourceHook);
  chmodSync(installer, 0o755);
  chmodSync(sourceHook, 0o755);
  assert.equal(run("git", ["init", "-q"], { cwd: fixture }).status, 0);

  const installed = run("bash", [installer], { cwd: fixture });
  assert.equal(installed.status, 0, installed.stderr);
  const targetHook = path.join(fixture, ".git", "hooks", "pre-push");
  assert.equal(readFileSync(targetHook, "utf8"), readFileSync(sourceHook, "utf8"));

  const foreign = "#!/usr/bin/env bash\necho foreign\n";
  writeFileSync(targetHook, foreign, "utf8");
  const refused = run("bash", [installer], { cwd: fixture });
  assert.notEqual(refused.status, 0);
  assert.equal(readFileSync(targetHook, "utf8"), foreign);

  const externalHooks = path.join(temporaryRoot("codex-shared-hooks-"), "hooks");
  mkdirSync(externalHooks, { recursive: true });
  const sentinel = path.join(externalHooks, "pre-push");
  writeFileSync(sentinel, "shared hook\n", "utf8");
  assert.equal(run("git", ["config", "core.hooksPath", externalHooks], { cwd: fixture }).status, 0);
  const outsideRefused = run("bash", [installer], { cwd: fixture });
  assert.notEqual(outsideRefused.status, 0);
  assert.match(outsideRefused.stderr, /outside this repository's Git common directory/);
  assert.equal(readFileSync(sentinel, "utf8"), "shared hook\n");
});

test("project export cannot overwrite source or an existing archive", () => {
  const fixture = temporaryRoot("codex-export-boundary-");
  const setupDirectory = path.join(fixture, "scripts", "setup");
  mkdirSync(setupDirectory, { recursive: true });
  const exporter = path.join(setupDirectory, "export-project.sh");
  copyFileSync(path.join(root, "scripts/setup/export-project.sh"), exporter);
  chmodSync(exporter, 0o755);
  writeFileSync(path.join(fixture, "README.md"), "source sentinel\n", "utf8");

  const sourceTarget = run("bash", [exporter, "README.md"], { cwd: fixture });
  assert.notEqual(sourceTarget.status, 0);
  assert.match(sourceTarget.stderr, /dist\/exports/);
  assert.equal(readFileSync(path.join(fixture, "README.md"), "utf8"), "source sentinel\n");

  mkdirSync(path.join(fixture, "dist", "exports"), { recursive: true });
  const existing = path.join(fixture, "dist", "exports", "existing.tar.gz");
  writeFileSync(existing, "archive sentinel\n", "utf8");
  const existingTarget = run("bash", [exporter, "dist/exports/existing.tar.gz"], {
    cwd: fixture,
  });
  assert.notEqual(existingTarget.status, 0);
  assert.match(existingTarget.stderr, /already exists/);
  assert.equal(readFileSync(existing, "utf8"), "archive sentinel\n");
});
