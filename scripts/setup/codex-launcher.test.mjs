import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import {
  portableCodexGitignorePatterns,
  portableCodexGitignoreProbePaths,
  repositoryCodexHomeGitignorePatterns,
  repositoryCodexHomeProtectedGitignoreProbePaths,
} from "../repository/source-inventory.mjs";
import {
  bashSingleQuotedArray,
  cleanupTemporaryRoots,
  root,
  run,
  temporaryRoot,
  validPortableConfig,
  writeProjectAgents,
  writeProjectHookFiles,
} from "./setup-regression-fixtures.mjs";

after(cleanupTemporaryRoots);

test("Codex launcher updates system-wide before an isolated canonical project start", () => {
  const fixture = temporaryRoot("codex launcher with spaces ");
  const setupDirectory = path.join(fixture, "scripts", "setup");
  const binDirectory = path.join(fixture, "bin");
  mkdirSync(setupDirectory, { recursive: true });
  mkdirSync(path.join(fixture, ".codex"), { recursive: true });
  writeFileSync(path.join(fixture, ".codex", "config.toml"), validPortableConfig, "utf8");
  writeProjectHookFiles(fixture);
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
  const externalCodexHome = path.join(fixture, "external-home-must-not-be-used");
  const syntheticSecret = "synthetic-launch-secret";
  const fakeCodex = path.join(binDirectory, "codex");
  writeFileSync(
    fakeCodex,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "{",
      "  printf 'CALL\\0'",
      "  printf '%s\\0' \"${CODEX_HOME:-<unset>}\"",
      "  printf '%s\\0' \"$@\"",
      "  printf 'END\\0'",
      '} >> "$CAPTURE_PATH"',
      'if [[ "${1-}" == "update" ]]; then',
      '  update_status="${FAKE_CODEX_UPDATE_STATUS:-0}"',
      '  if [[ "$update_status" != "0" ]]; then',
      "    printf 'synthetic update failure\\n' >&2",
      '    exit "$update_status"',
      "  fi",
      "  exit 0",
      "fi",
      'exit "${FAKE_CODEX_START_STATUS:-0}"',
    ].join("\n"),
    "utf8",
  );
  chmodSync(fakeCodex, 0o755);

  function capturedCalls() {
    const fields = readFileSync(capturePath, "utf8").split("\0");
    if (fields.at(-1) === "") fields.pop();
    const calls = [];
    for (let index = 0; index < fields.length;) {
      assert.equal(fields[index], "CALL");
      const home = fields[index + 1];
      index += 2;
      const args = [];
      while (fields[index] !== "END") args.push(fields[index++]);
      index += 1;
      calls.push({ home, args });
    }
    return calls;
  }

  const bootstrapSource = readFileSync(
    path.join(setupDirectory, "validate-codex-bootstrap.sh"),
    "utf8",
  );
  // Keep the pre-runtime bootstrap validator Bash-3.2-compatible for the supported macOS host.
  for (const shellSource of [readFileSync(launcher, "utf8"), bootstrapSource]) {
    assert.doesNotMatch(shellSource, /declare\s+-A|\[\[\s+-v\b/);
  }
  assert.match(bootstrapSource, /contains_value\(\)/);
  assert.deepEqual(bashSingleQuotedArray(bootstrapSource, "required_codex_ignore_patterns"), [
    ...repositoryCodexHomeGitignorePatterns,
    ...portableCodexGitignorePatterns,
  ]);
  assert.deepEqual(
    bashSingleQuotedArray(bootstrapSource, "runtime_probe_paths"),
    repositoryCodexHomeProtectedGitignoreProbePaths,
  );
  assert.deepEqual(
    bashSingleQuotedArray(bootstrapSource, "portable_probe_paths"),
    portableCodexGitignoreProbePaths,
  );

  const result = run("bash", [launcher, "--fixture"], {
    cwd: fixture,
    env: {
      CAPTURE_PATH: capturePath,
      CODEX_HOME: externalCodexHome,
      PATH: `${binDirectory}:/usr/bin:/bin`,
      SYNTHETIC_LAUNCH_SECRET: syntheticSecret,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(capturedCalls(), [
    { home: "<unset>", args: ["update"] },
    { home: fixture, args: ["--cd", fixture, "--fixture"] },
  ]);
  assert.equal(`${result.stdout}${result.stderr}`.includes(fixture), false);
  assert.equal(`${result.stdout}${result.stderr}`.includes(syntheticSecret), false);

  rmSync(capturePath);
  const startFailure = run("bash", [launcher], {
    cwd: fixture,
    env: {
      CAPTURE_PATH: capturePath,
      FAKE_CODEX_START_STATUS: "37",
      PATH: `${binDirectory}:/usr/bin:/bin`,
    },
  });
  assert.equal(startFailure.status, 37);
  assert.equal(capturedCalls().length, 2);

  rmSync(capturePath);
  const updateFailure = run("bash", [launcher], {
    cwd: fixture,
    env: {
      CAPTURE_PATH: capturePath,
      FAKE_CODEX_UPDATE_STATUS: "73",
      PATH: `${binDirectory}:/usr/bin:/bin`,
      SYNTHETIC_LAUNCH_SECRET: syntheticSecret,
    },
  });
  assert.equal(updateFailure.status, 73);
  assert.match(updateFailure.stderr, /synthetic update failure/);
  assert.deepEqual(capturedCalls(), [{ home: "<unset>", args: ["update"] }]);
  assert.equal(`${updateFailure.stdout}${updateFailure.stderr}`.includes(fixture), false);
  assert.equal(`${updateFailure.stdout}${updateFailure.stderr}`.includes(syntheticSecret), false);

  rmSync(capturePath);
  for (const override of [
    ["--cd", "/tmp/other-project"],
    ["--cd=/tmp/other-project"],
    ["-C", "/tmp/other-project"],
    ["-C/tmp/other-project"],
  ]) {
    const rejected = run("bash", [launcher, ...override], {
      cwd: fixture,
      env: { CAPTURE_PATH: capturePath, PATH: `${binDirectory}:/usr/bin:/bin` },
    });
    assert.equal(rejected.status, 64, `${override.join(" ")}\n${rejected.stderr}`);
    assert.match(rejected.stderr, /working-root override/);
    assert.equal(rejected.stderr.includes(override.at(-1)), false);
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
      env: { CAPTURE_PATH: capturePath, PATH: `${binDirectory}:/usr/bin:/bin` },
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
      CODEX_HOME: externalCodexHome,
      PATH: `${binDirectory}:/usr/bin:/bin`,
    },
  });
  assert.equal(promptNamedLikeAnOption.status, 0, promptNamedLikeAnOption.stderr);
  assert.deepEqual(capturedCalls(), [
    { home: "<unset>", args: ["update"] },
    {
      home: fixture,
      args: ["--cd", fixture, "--", "--cd", "prompt text"],
    },
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
    env: { CAPTURE_PATH: capturePath, PATH: `${binDirectory}:/usr/bin:/bin` },
  });
  assert.notEqual(executableConfig.status, 0);
  assert.match(executableConfig.stderr, /unsupported table/i);
  assert.equal(existsSync(capturePath), false);

  writeFileSync(configPath, validPortableConfig.replace("hooks = true", "hooks = false"), "utf8");
  const disabledHooks = run("bash", [launcher], {
    cwd: fixture,
    env: { CAPTURE_PATH: capturePath, PATH: `${binDirectory}:/usr/bin:/bin` },
  });
  assert.notEqual(disabledHooks.status, 0);
  assert.match(disabledHooks.stderr, /enable lifecycle hooks/i);
  assert.equal(existsSync(capturePath), false);

  writeFileSync(configPath, validPortableConfig, "utf8");
  const hooksPath = path.join(fixture, ".codex", "hooks.json");
  const validHooks = readFileSync(hooksPath, "utf8");
  for (const invalidHooks of [
    "{}\n",
    validHooks.replace('"Stop": [', '"Start": [],\n    "Stop": ['),
    validHooks.replace(
      '"hooks": [\n          {',
      '"hooks": [\n          {\n            "type": "command",\n            "command": "false"\n          },\n          {',
    ),
  ]) {
    writeFileSync(hooksPath, invalidHooks, "utf8");
    const rejectedHooks = run("bash", [launcher], {
      cwd: fixture,
      env: { CAPTURE_PATH: capturePath, PATH: `${binDirectory}:/usr/bin:/bin` },
    });
    assert.notEqual(rejectedHooks.status, 0);
    assert.match(rejectedHooks.stderr, /exactly the supported Stop hook/i);
    assert.equal(existsSync(capturePath), false);
  }
  writeFileSync(hooksPath, validHooks, "utf8");

  const gitignorePath = path.join(fixture, ".gitignore");
  const validGitignore = readFileSync(gitignorePath, "utf8");
  writeFileSync(gitignorePath, validGitignore.replace("/auth.json\n", ""), "utf8");
  const unsafeIgnore = run("bash", [launcher], {
    cwd: fixture,
    env: { CAPTURE_PATH: capturePath, PATH: `${binDirectory}:/usr/bin:/bin` },
  });
  assert.notEqual(unsafeIgnore.status, 0);
  assert.match(unsafeIgnore.stderr, /runtime ignore policy is incomplete/i);
  assert.equal(existsSync(capturePath), false);
  writeFileSync(gitignorePath, validGitignore, "utf8");

  for (const [override, expected] of [
    ["!/auth.json", /runtime ignore policy is ineffective/i],
    ["/.codex/config.toml", /portable project Codex configuration is unexpectedly ignored/i],
    ["!.codex/agents/extra.json", /runtime ignore policy is ineffective/i],
  ]) {
    writeFileSync(gitignorePath, `${validGitignore}\n${override}\n`, "utf8");
    const overriddenIgnore = run("bash", [launcher], {
      cwd: fixture,
      env: { CAPTURE_PATH: capturePath, PATH: `${binDirectory}:/usr/bin:/bin` },
    });
    assert.notEqual(overriddenIgnore.status, 0, override);
    assert.match(overriddenIgnore.stderr, expected);
    assert.equal(existsSync(capturePath), false);
  }
  writeFileSync(gitignorePath, validGitignore, "utf8");

  const outside = path.join(fixture, "outside-config.toml");
  writeFileSync(outside, validPortableConfig, "utf8");
  rmSync(configPath);
  symlinkSync(outside, configPath);
  const unsafe = run("bash", [launcher], {
    cwd: fixture,
    env: { CAPTURE_PATH: capturePath, PATH: `${binDirectory}:/usr/bin:/bin` },
  });
  assert.notEqual(unsafe.status, 0);
  assert.match(unsafe.stderr, /real file/i);
  assert.equal(existsSync(capturePath), false);
});
