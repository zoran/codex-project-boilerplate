import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  classifyUpdate,
  isPinned,
  normalizeOutdated,
  validatePolicy,
} from "./dependency-policy.mjs";
import {
  acquireDependencyTransactionLock,
  applyStoredDependencyPlan,
  dependencyTransactionPaths,
  prepareDependencyPlan,
  releaseDependencyTransactionLock,
} from "./dependency-transaction.mjs";

const transactionRoots = [];

after(() => {
  for (const root of transactionRoots) rmSync(root, { recursive: true, force: true });
});

function transactionFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "dependency-transaction-"));
  transactionRoots.push(root);
  mkdirSync(path.join(root, ".codex"));
  writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "transaction-fixture",
        private: true,
        dependencies: { example: "^1.2.0" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(path.join(root, "dependency-policy.json"), '{"pins":[]}\n', "utf8");
  writeFileSync(
    path.join(root, "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\nfixture: old\n",
    "utf8",
  );
  return root;
}

function localInputTransactionFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "dependency-local-input-"));
  transactionRoots.push(root);
  for (const directory of [
    ".codex",
    "package-source",
    "packages/example",
    "patches",
    "vendor/local-directory",
  ]) {
    mkdirSync(path.join(root, directory), { recursive: true });
  }
  writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "local-input-transaction-fixture",
        private: true,
        dependencies: {
          example: "^1.2.0",
          "local-directory": "file:vendor/local-directory",
          "local-source": "file:vendor/local-source-1.0.0.tgz",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(root, "packages/example/package.json"),
    `${JSON.stringify({ name: "example", version: "1.2.1" }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(root, "vendor/local-directory/package.json"),
    `${JSON.stringify({ name: "local-directory", version: "1.0.0" }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(root, "vendor/local-directory/index.js"),
    'export default "directory";\n',
  );
  writeFileSync(
    path.join(root, "package-source/package.json"),
    `${JSON.stringify({ name: "local-source", version: "1.0.0", main: "index.js" }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(path.join(root, "package-source/index.js"), 'export default "source";\n');
  const pack = spawnSync("pnpm", ["pack", "--pack-destination", path.join(root, "vendor")], {
    cwd: path.join(root, "package-source"),
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
    input: "",
    stdio: "pipe",
    timeout: 30_000,
  });
  assert.equal(pack.status, 0, `local tarball fixture setup failed: ${pack.stderr || pack.stdout}`);
  rmSync(path.join(root, "package-source"), { recursive: true });
  const patchContent = [
    "diff --git a/index.js b/index.js",
    "--- a/index.js",
    "+++ b/index.js",
    "@@ -1 +1 @@",
    '-export default "source";',
    '+export default "patched";',
    "",
  ].join("\n");
  writeFileSync(path.join(root, "patches/local-source.patch"), patchContent, "utf8");
  writeFileSync(path.join(root, "dependency-policy.json"), '{"pins":[]}\n', "utf8");
  writeFileSync(
    path.join(root, "pnpm-workspace.yaml"),
    [
      "packages:",
      "  - packages/*",
      "offline: true",
      "linkWorkspacePackages: true",
      "patchedDependencies:",
      "  local-source@1.0.0: patches/local-source.patch",
      "allowUnusedPatches: true",
      "",
    ].join("\n"),
    "utf8",
  );
  const install = spawnSync("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
    input: "",
    stdio: "pipe",
    timeout: 30_000,
  });
  assert.equal(
    install.status,
    0,
    `offline local-input fixture setup failed: ${install.stderr || install.stdout}`,
  );
  return {
    root,
    patchContent,
    tarballPath: path.join(root, "vendor/local-source-1.0.0.tgz"),
  };
}

const request = {
  level: "patch",
  select: [],
  allowMajor: false,
  includePinned: false,
};

function transactionUpdate(target = "1.2.1") {
  return {
    key: "package.json:dependencies:example",
    manifestPath: "package.json",
    workspacePath: ".",
    section: "dependencies",
    name: "example",
    current: "1.2.0",
    currentSpec: "^1.2.0",
    target,
    delta: "patch",
  };
}

function prepareFixturePlan(root, target = "1.2.1") {
  return prepareDependencyPlan({
    projectRoot: root,
    request,
    updates: [transactionUpdate(target)],
    manifestPaths: ["package.json"],
    now: new Date("2026-07-10T12:00:00.000Z"),
    lockfilePlanner: () => "lockfileVersion: '9.0'\nfixture: planned\n",
  });
}

const manifests = [
  {
    relativePath: "apps/one/package.json",
    workspacePath: "apps/one",
    name: "app-one",
    data: { dependencies: { shared: "^1.2.0" } },
  },
  {
    relativePath: "apps/two/package.json",
    workspacePath: "apps/two",
    name: "app-two",
    data: { dependencies: { shared: "^2.3.0" } },
  },
];

test("outdated entries retain manifest, workspace, section, and version-line identity", () => {
  const entries = normalizeOutdated(
    [
      {
        packageName: "shared",
        current: "1.2.0",
        wanted: "1.2.4",
        latest: "2.4.0",
        dependencyType: "dependencies",
        dependentPackageName: "app-one",
      },
      {
        packageName: "shared",
        current: "2.3.0",
        wanted: "2.3.2",
        latest: "2.4.0",
        dependencyType: "dependencies",
        dependentPackageName: "app-two",
      },
    ],
    manifests,
  );
  assert.deepEqual(
    entries.map((entry) => [entry.manifestPath, entry.current, entry.currentSpec]),
    [
      ["apps/one/package.json", "1.2.0", "^1.2.0"],
      ["apps/two/package.json", "2.3.0", "^2.3.0"],
    ],
  );
  assert.equal(new Set(entries.map((entry) => entry.key)).size, 2);
});

test("ambiguous registry output fails instead of collapsing workspaces", () => {
  assert.throws(
    () =>
      normalizeOutdated(
        {
          shared: {
            current: "1.2.0",
            latest: "2.4.0",
            dependencyType: "dependencies",
          },
        },
        manifests,
      ),
    /did not identify one manifest/,
  );
});

test("pins can target one manifest and dependency section", () => {
  const [one, two] = normalizeOutdated(
    [
      {
        packageName: "shared",
        current: "1.2.0",
        latest: "2.4.0",
        dependencyType: "dependencies",
        dependentPackageName: "app-one",
      },
      {
        packageName: "shared",
        current: "2.3.0",
        latest: "2.4.0",
        dependencyType: "dependencies",
        dependentPackageName: "app-two",
      },
    ],
    manifests,
  );
  const policy = {
    pins: [
      {
        name: "shared",
        manifest: "apps/one/package.json",
        section: "dependencies",
        reason: "Compatibility investigation",
      },
    ],
  };
  assert.equal(isPinned(one, policy), true);
  assert.equal(isPinned(two, policy), false);
  assert.deepEqual(validatePolicy(policy), []);
});

test("zero-major minor movement is classified as major risk", () => {
  assert.equal(classifyUpdate("0.4.1", "0.5.0"), "major");
  assert.equal(classifyUpdate("1.4.1", "1.5.0"), "minor");
  assert.equal(classifyUpdate("1.4.1", "1.4.2"), "patch");
});

test("dependency preview freezes outputs and apply uses the exact reviewed plan", () => {
  const root = transactionFixture();
  const originalManifest = readFileSync(path.join(root, "package.json"), "utf8");
  const { plan, planPath } = prepareFixturePlan(root);
  assert.ok(existsSync(planPath));
  assert.match(plan.hash, /^[a-f0-9]{64}$/);
  assert.equal(readFileSync(path.join(root, "package.json"), "utf8"), originalManifest);
  assert.match(readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8"), /fixture: old/);

  const applied = applyStoredDependencyPlan({ projectRoot: root, request });
  assert.deepEqual(applied.changed, ["package.json"]);
  assert.equal(
    JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).dependencies.example,
    "^1.2.1",
  );
  assert.match(readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8"), /fixture: planned/);
  const paths = dependencyTransactionPaths(root);
  assert.equal(existsSync(paths.plan), false);
  assert.equal(existsSync(paths.journal), false);
});

test("dependency preview isolates and freezes repository-local pnpm inputs", () => {
  const { root, patchContent, tarballPath } = localInputTransactionFixture();
  const manifestPath = path.join(root, "package.json");
  const lockfilePath = path.join(root, "pnpm-lock.yaml");
  const localDirectoryPath = path.join(root, "vendor/local-directory/index.js");
  const patchPath = path.join(root, "patches/local-source.patch");
  const originalManifest = readFileSync(manifestPath);
  const originalLockfile = readFileSync(lockfilePath);
  const originalLocalDirectory = readFileSync(localDirectoryPath);
  const originalTarball = readFileSync(tarballPath);
  const originalPatch = readFileSync(patchPath);

  const { plan } = prepareDependencyPlan({
    projectRoot: root,
    request,
    updates: [transactionUpdate()],
    manifestPaths: ["package.json", "packages/example/package.json"],
    now: new Date("2026-07-10T12:00:00.000Z"),
  });

  assert.deepEqual(readFileSync(manifestPath), originalManifest);
  assert.deepEqual(readFileSync(lockfilePath), originalLockfile);
  assert.deepEqual(readFileSync(localDirectoryPath), originalLocalDirectory);
  assert.deepEqual(readFileSync(tarballPath), originalTarball);
  assert.deepEqual(readFileSync(patchPath), originalPatch);
  assert.deepEqual(
    plan.inputs
      .filter((input) =>
        [
          "patches/local-source.patch",
          "vendor/local-directory",
          "vendor/local-source-1.0.0.tgz",
        ].includes(input.path),
      )
      .map((input) => [input.path, input.kind]),
    [
      ["patches/local-source.patch", "file"],
      ["vendor/local-directory", "directory"],
      ["vendor/local-source-1.0.0.tgz", "file"],
    ],
  );
  assert.match(plan.outputs.lockfile.content, /specifier: \^1\.2\.1/);
  assert.match(plan.outputs.lockfile.content, /patchedDependencies:/);

  writeFileSync(patchPath, `${patchContent}# changed after preview\n`, "utf8");
  assert.throws(
    () => applyStoredDependencyPlan({ projectRoot: root, request }),
    /plan is stale because patches\/local-source\.patch changed/,
  );
  writeFileSync(patchPath, patchContent, "utf8");
  writeFileSync(tarballPath, Buffer.concat([originalTarball, Buffer.from("changed")]));
  assert.throws(
    () => applyStoredDependencyPlan({ projectRoot: root, request }),
    /plan is stale because vendor\/local-source-1\.0\.0\.tgz changed/,
  );
  assert.deepEqual(readFileSync(manifestPath), originalManifest);
  assert.deepEqual(readFileSync(lockfilePath), originalLockfile);
});

test("dependency apply rejects source or version changes after preview", () => {
  const root = transactionFixture();
  prepareFixturePlan(root);
  const manifestPath = path.join(root, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.dependencies.example = "^1.2.5";
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  assert.throws(
    () => applyStoredDependencyPlan({ projectRoot: root, request }),
    /plan is stale because package.json changed/,
  );
  assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).dependencies.example, "^1.2.5");
  assert.match(readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8"), /fixture: old/);
  assert.equal(existsSync(dependencyTransactionPaths(root).plan), true);
});

test("dependency apply arguments must match the reviewed preview", () => {
  const root = transactionFixture();
  prepareFixturePlan(root);
  assert.throws(
    () =>
      applyStoredDependencyPlan({
        projectRoot: root,
        request: { ...request, level: "minor" },
      }),
    /arguments do not match the reviewed dependency preview/,
  );
  assert.equal(
    JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).dependencies.example,
    "^1.2.0",
  );
  assert.match(readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8"), /fixture: old/);
});

test("dependency preview rejects inputs changed while outputs are being planned", () => {
  const root = transactionFixture();
  const manifestPath = path.join(root, "package.json");
  assert.throws(
    () =>
      prepareDependencyPlan({
        projectRoot: root,
        request,
        updates: [transactionUpdate()],
        manifestPaths: ["package.json"],
        lockfilePlanner: () => {
          const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
          manifest.description = "concurrent edit";
          writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
          return "lockfileVersion: '9.0'\nfixture: planned\n";
        },
      }),
    /plan is stale because package.json changed/,
  );
  assert.equal(existsSync(dependencyTransactionPaths(root).plan), false);
});

test("dependency transaction lock enforces process ownership", () => {
  const root = transactionFixture();
  const lock = acquireDependencyTransactionLock(root, { token: "first-owner" });
  assert.throws(() => acquireDependencyTransactionLock(root), /locked by process/);
  assert.throws(
    () =>
      releaseDependencyTransactionLock({
        ...lock,
        owner: { ...lock.owner, token: "different-owner" },
      }),
    /ownership changed/,
  );
  assert.ok(existsSync(lock.path));
  releaseDependencyTransactionLock(lock);
});

test("interrupted dependency transaction is journaled, rolled back, and retried", () => {
  const root = transactionFixture();
  prepareFixturePlan(root);
  assert.throws(
    () =>
      applyStoredDependencyPlan({
        projectRoot: root,
        request,
        injectedFailure: "after-manifests",
      }),
    /Injected dependency interruption/,
  );
  const paths = dependencyTransactionPaths(root);
  assert.equal(existsSync(paths.journal), true);
  assert.equal(
    JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).dependencies.example,
    "^1.2.1",
  );
  assert.match(readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8"), /fixture: old/);

  const applied = applyStoredDependencyPlan({ projectRoot: root, request });
  assert.equal(applied.recovered, "rolled-back");
  assert.equal(
    JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).dependencies.example,
    "^1.2.1",
  );
  assert.match(readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8"), /fixture: planned/);
  assert.equal(existsSync(paths.journal), false);
});

test("dependency recovery preserves unrelated manual output changes and its journal", () => {
  const root = transactionFixture();
  prepareFixturePlan(root);
  assert.throws(
    () =>
      applyStoredDependencyPlan({
        projectRoot: root,
        request,
        injectedFailure: "after-manifests",
      }),
    /Injected dependency interruption/,
  );

  const manifestPath = path.join(root, "package.json");
  const manualContent = `${JSON.stringify(
    {
      name: "transaction-fixture",
      private: true,
      description: "manual edit after interruption",
      dependencies: { example: "^1.2.7" },
    },
    null,
    2,
  )}\n`;
  writeFileSync(manifestPath, manualContent, "utf8");
  const paths = dependencyTransactionPaths(root);

  assert.throws(
    () => applyStoredDependencyPlan({ projectRoot: root, request }),
    /recovery refused to overwrite package\.json.*unrelated change.*journal preserved/i,
  );
  assert.equal(readFileSync(manifestPath, "utf8"), manualContent);
  assert.equal(existsSync(paths.journal), true);
  assert.equal(existsSync(paths.plan), true);
});

test("fully written interrupted dependency transaction is finalized idempotently", () => {
  const root = transactionFixture();
  const { plan } = prepareFixturePlan(root);
  assert.throws(
    () =>
      applyStoredDependencyPlan({
        projectRoot: root,
        request,
        injectedFailure: "after-lockfile",
      }),
    /Injected dependency interruption/,
  );
  const recovered = applyStoredDependencyPlan({ projectRoot: root, request });
  assert.equal(recovered.recovered, "finalized");
  assert.equal(recovered.planHash, plan.hash);
  assert.equal(existsSync(dependencyTransactionPaths(root).journal), false);
});

test("corrupt dependency recovery journal is detected and preserved", () => {
  const root = transactionFixture();
  prepareFixturePlan(root);
  assert.throws(
    () =>
      applyStoredDependencyPlan({
        projectRoot: root,
        request,
        injectedFailure: "after-manifests",
      }),
    /Injected dependency interruption/,
  );
  const journalPath = dependencyTransactionPaths(root).journal;
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.originals[0].content = "tampered\n";
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  assert.throws(
    () => applyStoredDependencyPlan({ projectRoot: root, request }),
    /journal is invalid; manual recovery is required/,
  );
  assert.equal(existsSync(journalPath), true);
});
