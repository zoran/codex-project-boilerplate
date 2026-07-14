import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parsePnpmWorkspaceProjects, workspaceLifecycleCommands } from "./adaptive-runner.mjs";

function writeManifest(directory, pkg) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "package.json"), `${JSON.stringify(pkg)}\n`, "utf8");
}

test("pnpm graph discovery includes root and arbitrary workspace layouts", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "workspace-graph-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const product = path.join(root, "products", "alpha");
  const module = path.join(root, "modules", "beta");
  writeManifest(root, {
    name: "root",
    scripts: {
      build: "pnpm -r --if-present build",
      lint: "bash scripts/verify/lint.sh",
      test: "node --test",
    },
  });
  writeManifest(product, { name: "alpha", scripts: { build: "vite build" } });
  writeManifest(module, { name: "beta", scripts: { typecheck: "tsc --noEmit" } });

  const manifests = parsePnpmWorkspaceProjects(
    JSON.stringify([{ path: product }, { path: module }]),
    { repositoryRoot: root },
  );
  assert.deepEqual(
    manifests.map(({ directory }) => directory),
    [".", "modules/beta", "products/alpha"],
  );

  const commands = workspaceLifecycleCommands(manifests);
  const build = commands.find((command) => command.key === "workspace:build");
  assert.ok(build.args.includes("./products/alpha"));
  assert.equal(build.args.includes("."), false, "recursive root aggregator must be skipped");
  assert.ok(
    commands.find((command) => command.key === "workspace:test").args.includes("."),
    "ordinary root lifecycle scripts must run",
  );
  assert.ok(
    commands
      .find((command) => command.key === "workspace:typecheck")
      .args.includes("./modules/beta"),
  );
  assert.equal(
    commands.some((command) => command.key === "workspace:lint"),
    false,
    "managed verification aliases must not duplicate direct DAG nodes",
  );
});

test("pnpm graph projects outside the repository fail closed", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "workspace-graph-root-"));
  const outside = mkdtempSync(path.join(tmpdir(), "workspace-graph-outside-"));
  t.after(() => {
    rmSync(root, { force: true, recursive: true });
    rmSync(outside, { force: true, recursive: true });
  });
  writeManifest(root, { name: "root" });
  writeManifest(outside, { name: "outside" });
  assert.throws(
    () =>
      parsePnpmWorkspaceProjects(JSON.stringify([{ path: outside }]), {
        repositoryRoot: root,
      }),
    /escapes the repository/,
  );
});

test("pnpm graph projects with symlinked path components fail closed", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "workspace-graph-symlink-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const realProject = path.join(root, "real", "project");
  writeManifest(root, { name: "root" });
  writeManifest(realProject, { name: "project" });
  symlinkSync(path.join(root, "real"), path.join(root, "linked"), "dir");
  assert.throws(
    () =>
      parsePnpmWorkspaceProjects(JSON.stringify([{ path: path.join(root, "linked", "project") }]), {
        repositoryRoot: root,
      }),
    /symlinked path component/,
  );
});

test("lifecycle filters reject ambiguous pnpm path metacharacters", () => {
  assert.throws(
    () =>
      workspaceLifecycleCommands([{ directory: "modules/[ambiguous]", scripts: { test: "x" } }]),
    /pnpm filter metacharacters/,
  );
});
