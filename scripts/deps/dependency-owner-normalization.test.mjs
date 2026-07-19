import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  formatDependencyTable,
  isPinned,
  normalizeOutdated,
  packageManifests,
  parsePnpmJsonResult,
  readOutdated,
} from "./dependency-policy.mjs";
import {
  applyStoredDependencyPlan,
  prepareDependencyPlan,
  updatedDependencySpec,
} from "./dependency-transaction.mjs";
import { formatPlannedDependencyUpdate, selectDependencyEntries } from "./update.mjs";

const temporaryRoots = [];

after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

function writeJson(root, relativePath, value) {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function workspaceFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "dependency-owner-workspace-"));
  temporaryRoots.push(root);
  mkdirSync(path.join(root, ".codex"));
  writeJson(root, "package.json", { name: "workspace-root", private: true });
  writeFileSync(
    path.join(root, "pnpm-workspace.yaml"),
    'packages: ["packages/*"] # valid flow-style workspace list\n',
    "utf8",
  );
  writeJson(root, "packages/domain/package.json", {
    name: "@example/domain",
    devDependencies: {
      "local-tool": "npm:upstream-tool@^3.1.0",
      shared: "^1.4.0",
      typescript: "^6.0.0",
    },
    dependencies: { shared: "~1.4.0" },
  });
  writeJson(root, "packages/protocol/package.json", {
    name: "@example/protocol",
    devDependencies: { shared: "~1.5.0", typescript: "~6.0.3" },
  });
  writeJson(root, "packages/anonymous/package.json", {
    devDependencies: { "anonymous-tool": "^1.0.0" },
  });
  writeJson(root, "fixtures/rogue/package.json", {
    name: "@example/rogue",
    devDependencies: { typescript: "^6.0.0" },
  });
  writeFileSync(path.join(root, "dependency-policy.json"), '{"pins":[]}\n', "utf8");
  writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nold: true\n");
  const projects = [
    root,
    path.join(root, "packages/anonymous"),
    path.join(root, "packages/domain"),
    path.join(root, "packages/protocol"),
  ].map((projectPath) => ({ path: projectPath }));
  const manifests = packageManifests({
    repositoryRoot: root,
    spawnPnpm: (executable, args, options) => {
      assert.equal(executable, "pnpm");
      assert.deepEqual(args, ["--recursive", "list", "--depth", "-1", "--json"]);
      assert.equal(options.cwd, root);
      return { status: 0, stdout: JSON.stringify(projects), stderr: "" };
    },
  });
  return { root, manifests };
}

function owner(root, workspace, name) {
  return { name, location: path.join(root, "packages", workspace) };
}

function normalize(raw, fixture) {
  return normalizeOutdated(raw, fixture.manifests, { repositoryRoot: fixture.root });
}

function sharedOwnerRaw(fixture) {
  return {
    typescript: {
      current: "6.0.3",
      wanted: "6.0.4",
      latest: "7.0.2",
      dependencyType: "devDependencies",
      dependentPackages: [
        owner(fixture.root, "domain", "@example/domain"),
        owner(fixture.root, "protocol", "@example/protocol"),
      ],
    },
  };
}

function capturedFailure(action) {
  try {
    action();
  } catch (error) {
    return error;
  }
  assert.fail("expected action to fail");
}

test("workspace inventory includes only root and declared pnpm workspace manifests", () => {
  const fixture = workspaceFixture();
  assert.deepEqual(
    fixture.manifests.map((manifest) => manifest.relativePath),
    [
      "package.json",
      "packages/anonymous/package.json",
      "packages/domain/package.json",
      "packages/protocol/package.json",
    ],
  );
});

test("workspace graph locations outside the root or through symlinks fail closed", () => {
  const fixture = workspaceFixture();
  const outside = mkdtempSync(path.join(os.tmpdir(), "dependency-graph-outside-"));
  temporaryRoots.push(outside);
  writeJson(outside, "package.json", { name: "outside" });
  const alias = path.join(fixture.root, "packages/domain-alias");
  symlinkSync(path.join(fixture.root, "packages/domain"), alias);
  const manifestsFor = (projectPath) =>
    packageManifests({
      repositoryRoot: fixture.root,
      spawnPnpm: () => ({
        status: 0,
        stdout: JSON.stringify([{ path: fixture.root }, { path: projectPath }]),
        stderr: "",
      }),
    });

  const outsideFailure = capturedFailure(() => manifestsFor(outside));
  assert.match(outsideFailure.message, /outside the repository/);
  assert.equal(outsideFailure.message.includes(outside), false);
  const symlinkFailure = capturedFailure(() => manifestsFor(alias));
  assert.match(symlinkFailure.message, /non-real project location/);
  assert.equal(symlinkFailure.message.includes(alias), false);
});

test("dependentPackages expands one outdated record into one identity per manifest", () => {
  const fixture = workspaceFixture();
  const entries = normalize(sharedOwnerRaw(fixture), fixture);

  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((entry) => ({
      key: entry.key,
      manifest: entry.manifestPath,
      workspace: entry.workspaceName,
      section: entry.section,
      spec: entry.currentSpec,
      current: entry.current,
      wanted: entry.wanted,
      latest: entry.latest,
      delta: entry.delta,
    })),
    [
      {
        key: "packages/domain/package.json:devDependencies:typescript",
        manifest: "packages/domain/package.json",
        workspace: "@example/domain",
        section: "devDependencies",
        spec: "^6.0.0",
        current: "6.0.3",
        wanted: "6.0.4",
        latest: "7.0.2",
        delta: "major",
      },
      {
        key: "packages/protocol/package.json:devDependencies:typescript",
        manifest: "packages/protocol/package.json",
        workspace: "@example/protocol",
        section: "devDependencies",
        spec: "~6.0.3",
        current: "6.0.3",
        wanted: "6.0.4",
        latest: "7.0.2",
        delta: "major",
      },
    ],
  );
});

test("registry aliases and nameless workspace owners retain manifest identities", () => {
  const fixture = workspaceFixture();
  const [alias] = normalize(
    {
      "upstream-tool": {
        current: "3.1.2",
        wanted: "3.1.4",
        latest: "4.0.0",
        dependencyType: "devDependencies",
        dependentPackages: [owner(fixture.root, "domain", "@example/domain")],
      },
    },
    fixture,
  );
  assert.deepEqual(
    {
      key: alias.key,
      name: alias.name,
      registryName: alias.registryName,
      spec: alias.currentSpec,
    },
    {
      key: "packages/domain/package.json:devDependencies:local-tool",
      name: "local-tool",
      registryName: "upstream-tool",
      spec: "npm:upstream-tool@^3.1.0",
    },
  );
  assert.equal(updatedDependencySpec(alias.currentSpec, "4.0.0"), "npm:upstream-tool@^4.0.0");

  const [anonymous] = normalize(
    {
      "anonymous-tool": {
        current: "1.0.0",
        wanted: "1.0.1",
        latest: "1.1.0",
        dependencyType: "devDependencies",
        dependentPackages: [{ location: path.join(fixture.root, "packages/anonymous") }],
      },
    },
    fixture,
  );
  assert.equal(anonymous.key, "packages/anonymous/package.json:devDependencies:anonymous-tool");
  assert.equal(anonymous.workspaceName, "packages/anonymous");
});

test("same package in distinct sections and version lines retains separate identities", () => {
  const fixture = workspaceFixture();
  const entries = normalize(
    {
      shared: [
        {
          current: "1.4.1",
          wanted: "1.4.3",
          latest: "2.0.0",
          dependencyType: "dependencies",
          dependentPackages: [owner(fixture.root, "domain", "@example/domain")],
        },
        {
          current: "1.4.2",
          wanted: "1.4.4",
          latest: "2.0.0",
          dependencyType: "devDependencies",
          dependentPackages: [owner(fixture.root, "domain", "@example/domain")],
        },
        {
          current: "1.5.1",
          wanted: "1.5.3",
          latest: "2.0.0",
          dependencyType: "devDependencies",
          dependentPackages: [owner(fixture.root, "protocol", "@example/protocol")],
        },
      ],
    },
    fixture,
  );

  assert.deepEqual(
    entries.map((entry) => [entry.key, entry.currentSpec, entry.current]),
    [
      ["packages/domain/package.json:dependencies:shared", "~1.4.0", "1.4.1"],
      ["packages/domain/package.json:devDependencies:shared", "^1.4.0", "1.4.2"],
      ["packages/protocol/package.json:devDependencies:shared", "~1.5.0", "1.5.1"],
    ],
  );
});

test("pins and exact selectors stay scoped to manifest and dependency section", () => {
  const fixture = workspaceFixture();
  const entries = normalize(sharedOwnerRaw(fixture), fixture);
  const [domain, protocol] = entries;
  const policy = {
    pins: [
      {
        name: "typescript",
        manifest: domain.manifestPath,
        section: domain.section,
        reason: "Domain migration is separate",
      },
    ],
  };

  assert.equal(isPinned(domain, policy), true);
  assert.equal(isPinned(protocol, policy), false);
  assert.deepEqual(selectDependencyEntries(entries, [protocol.key]), new Set([protocol.key]));

  const crossSection = normalize(
    {
      shared: [
        {
          current: "1.4.1",
          wanted: "1.4.2",
          latest: "1.4.2",
          dependencyType: "dependencies",
          dependentPackages: [owner(fixture.root, "domain", "@example/domain")],
        },
        {
          current: "1.4.1",
          wanted: "1.5.0",
          latest: "1.5.0",
          dependencyType: "devDependencies",
          dependentPackages: [owner(fixture.root, "domain", "@example/domain")],
        },
      ],
    },
    fixture,
  );
  for (const entry of crossSection) {
    assert.deepEqual(selectDependencyEntries(crossSection, [entry.key]), new Set([entry.key]));
  }
  assert.throws(
    () => selectDependencyEntries(crossSection, ["packages/domain:shared"]),
    /selection is ambiguous.*manifest.*section/i,
  );
});

test("status 1 requires every outdated record to be complete and nonfatal", () => {
  const complete = {
    typescript: {
      current: "6.0.3",
      wanted: "6.0.4",
      latest: "7.0.2",
      dependencyType: "devDependencies",
    },
  };
  assert.deepEqual(
    parsePnpmJsonResult(
      { status: 1, stdout: JSON.stringify(complete), stderr: "" },
      "pnpm outdated",
      { acceptOutdatedStatus: true },
    ),
    complete,
  );
  for (const stdout of [
    "{}",
    "[]",
    "null",
    "not-json",
    JSON.stringify({ ...complete, broken: { current: "1.0.0" } }),
  ]) {
    assert.throws(
      () =>
        parsePnpmJsonResult({ status: 1, stdout }, "pnpm outdated", {
          acceptOutdatedStatus: true,
        }),
      /invalid JSON|without a complete outdated result/,
    );
  }
  assert.throws(
    () =>
      parsePnpmJsonResult(
        { status: 1, stdout: JSON.stringify(complete), stderr: "ERROR registry unavailable" },
        "pnpm outdated",
        { acceptOutdatedStatus: true },
      ),
    /fatal pnpm diagnostic/,
  );
  assert.throws(
    () =>
      parsePnpmJsonResult(
        { status: 2, stdout: JSON.stringify(complete), stderr: "" },
        "pnpm outdated",
        { acceptOutdatedStatus: true },
      ),
    /failed with status 2/,
  );
});

test("readOutdated queries each manifest declaration without pnpm JSON overwrite loss", () => {
  const fixture = workspaceFixture();
  const invocations = [];
  const results = new Map([
    ["anonymous:devDependencies:anonymous-tool", ["anonymous-tool", "1.0.0", "1.0.1", "1.1.0"]],
    ["domain:dependencies:shared", ["shared", "1.4.1", "1.4.3", "2.0.0"]],
    ["domain:devDependencies:local-tool", ["upstream-tool", "3.1.2", "3.1.4", "4.0.0"]],
    ["domain:devDependencies:shared", ["shared", "1.4.2", "1.4.4", "2.0.0"]],
    ["domain:devDependencies:typescript", ["typescript", "6.0.1", "6.0.4", "7.0.2"]],
    ["protocol:devDependencies:typescript", ["typescript", "6.0.3", "6.0.4", "7.0.2"]],
  ]);
  const entries = readOutdated({
    manifests: fixture.manifests,
    repositoryRoot: fixture.root,
    spawnPnpm: (executable, args, options) => {
      assert.equal(executable, "pnpm");
      assert.equal(args[0], "outdated");
      assert.equal(args.includes("--recursive"), false);
      const workspace = path.basename(options.cwd);
      const section = args.includes("--dev")
        ? "devDependencies"
        : args.includes("--no-optional")
          ? "dependencies"
          : "optionalDependencies";
      const key = `${workspace}:${section}:${args[1]}`;
      invocations.push(key);
      const result = results.get(key);
      if (!result) return { status: 0, stdout: "{}", stderr: "" };
      const [registryName, current, wanted, latest] = result;
      return {
        status: 1,
        stderr: "",
        stdout: JSON.stringify({
          [registryName]: { current, wanted, latest, dependencyType: section },
        }),
      };
    },
  });

  assert.deepEqual(
    entries.map((entry) => [entry.key, entry.registryName, entry.current]),
    [
      ["packages/anonymous/package.json:devDependencies:anonymous-tool", "anonymous-tool", "1.0.0"],
      ["packages/domain/package.json:dependencies:shared", "shared", "1.4.1"],
      ["packages/domain/package.json:devDependencies:local-tool", "upstream-tool", "3.1.2"],
      ["packages/domain/package.json:devDependencies:shared", "shared", "1.4.2"],
      ["packages/domain/package.json:devDependencies:typescript", "typescript", "6.0.1"],
      ["packages/protocol/package.json:devDependencies:typescript", "typescript", "6.0.3"],
    ],
  );
  assert.equal(invocations.includes("domain:devDependencies:local-tool"), true);
  assert.equal(invocations.includes("anonymous:devDependencies:anonymous-tool"), true);
});

test("unsafe, unknown, ambiguous, and contradictory owners fail closed", () => {
  const fixture = workspaceFixture();
  const base = sharedOwnerRaw(fixture).typescript;
  const single = (fields) => ({ typescript: { ...base, dependentPackages: undefined, ...fields } });
  const outside = mkdtempSync(path.join(os.tmpdir(), "dependency-owner-outside-"));
  temporaryRoots.push(outside);
  writeJson(outside, "package.json", { name: "@example/domain" });
  symlinkSync(
    path.join(fixture.root, "packages/domain"),
    path.join(fixture.root, "packages/domain-link"),
  );

  const outsideFailure = capturedFailure(() =>
    normalize(
      single({
        dependentPackageName: "@example/domain",
        dependentPackageLocation: outside,
      }),
      fixture,
    ),
  );
  assert.match(outsideFailure.message, /outside the repository/);
  assert.equal(outsideFailure.message.includes(fixture.root), false);
  assert.equal(outsideFailure.message.includes(outside), false);
  assert.throws(
    () =>
      normalize(
        single({
          dependentPackageName: "@example/domain",
          dependentPackageLocation: "packages\/..\/packages\/domain",
        }),
        fixture,
      ),
    /unsafe location/,
  );
  assert.throws(
    () =>
      normalize(
        single({
          dependentPackageName: "@example/domain",
          dependentPackageLocation: path.join(fixture.root, "packages/domain-link"),
        }),
        fixture,
      ),
    /symbolic-link boundary/,
  );
  assert.throws(
    () =>
      normalize(
        {
          typescript: {
            ...base,
            dependentPackages: [
              { name: "@example/rogue", location: path.join(fixture.root, "fixtures/rogue") },
            ],
          },
        },
        fixture,
      ),
    /declared workspace manifest/,
  );
  assert.throws(
    () =>
      normalize(
        single({
          dependentPackageName: "@example/domain",
          dependentPackageLocation: path.join(fixture.root, "packages/missing"),
        }),
        fixture,
      ),
    /readable workspace location/,
  );

  const ambiguousManifests = fixture.manifests.map((manifest) =>
    manifest.relativePath === "packages/protocol/package.json"
      ? { ...manifest, name: "@example/domain" }
      : manifest,
  );
  assert.throws(
    () =>
      normalizeOutdated(single({ dependentPackageName: "@example/domain" }), ambiguousManifests, {
        repositoryRoot: fixture.root,
      }),
    /one declared workspace name/,
  );
  assert.throws(
    () =>
      normalize(
        {
          typescript: {
            ...base,
            dependentPackageName: "@example/domain",
            dependentPackages: [owner(fixture.root, "protocol", "@example/protocol")],
          },
        },
        fixture,
      ),
    /conflicts with dependentPackages/,
  );
});

test("dependency report renders deterministic distinct manifest rows", () => {
  const fixture = workspaceFixture();
  const entries = normalize(sharedOwnerRaw(fixture), fixture);
  const report = formatDependencyTable(entries, { pins: [] });
  const domain = report.indexOf("packages/domain/package.json");
  const protocol = report.indexOf("packages/protocol/package.json");
  assert.match(report, /\| Package \| Manifest \| Workspace \| Section \|/);
  assert.ok(domain > 0);
  assert.ok(protocol > domain);
  assert.equal(report.match(/\| typescript \|/g)?.length, 2);
  assert.deepEqual(
    entries.map((entry) => formatPlannedDependencyUpdate({ ...entry, target: "7.0.2" })),
    [
      "- packages/domain/package.json:devDependencies:typescript: 6.0.3 -> 7.0.2 (major)",
      "- packages/protocol/package.json:devDependencies:typescript: 6.0.3 -> 7.0.2 (major)",
    ],
  );
});

test("a selected transaction changes only its canonical manifest identity", () => {
  const fixture = workspaceFixture();
  const update = {
    key: "packages/domain/package.json:devDependencies:typescript",
    manifestPath: "packages/domain/package.json",
    section: "devDependencies",
    name: "typescript",
    current: "6.0.3",
    currentSpec: "^6.0.0",
    target: "6.0.4",
    delta: "patch",
  };
  const request = {
    level: "patch",
    select: [update.key],
    allowMajor: false,
    includePinned: false,
  };
  const protocolBefore = readFileSync(
    path.join(fixture.root, "packages/protocol/package.json"),
    "utf8",
  );
  prepareDependencyPlan({
    projectRoot: fixture.root,
    request,
    updates: [update],
    manifestPaths: fixture.manifests.map((manifest) => manifest.relativePath),
    lockfilePlanner: () => "lockfileVersion: '9.0'\nplanned: true\n",
  });
  const applied = applyStoredDependencyPlan({ projectRoot: fixture.root, request });

  assert.deepEqual(applied.changed, ["packages/domain/package.json"]);
  assert.equal(
    JSON.parse(readFileSync(path.join(fixture.root, update.manifestPath), "utf8")).devDependencies
      .typescript,
    "^6.0.4",
  );
  assert.equal(
    readFileSync(path.join(fixture.root, "packages/protocol/package.json"), "utf8"),
    protocolBefore,
  );
});

test("dependency plans reject a key that differs from manifest section or package", () => {
  const fixture = workspaceFixture();
  assert.throws(
    () =>
      prepareDependencyPlan({
        projectRoot: fixture.root,
        request: {
          level: "patch",
          select: [],
          allowMajor: false,
          includePinned: false,
        },
        updates: [
          {
            key: "packages/protocol/package.json:devDependencies:typescript",
            manifestPath: "packages/domain/package.json",
            section: "devDependencies",
            name: "typescript",
            current: "6.0.3",
            currentSpec: "^6.0.0",
            target: "6.0.4",
            delta: "patch",
          },
        ],
        manifestPaths: fixture.manifests.map((manifest) => manifest.relativePath),
        lockfilePlanner: () => "lockfileVersion: '9.0'\n",
      }),
    /key does not match its manifest identity/,
  );
});
