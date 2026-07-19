import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, linkSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { repositoryRoot } from "../repository/source-inventory.mjs";
import { stageProjectExport } from "./stage-project-export.mjs";

const temporaryRoots = [];

function temporaryRoot(prefix) {
  const value = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(value);
  return value;
}

function createStage(prefix) {
  const stage = path.join(temporaryRoot(prefix), "stage");
  stageProjectExport({ sourceRoot: repositoryRoot, targetRoot: stage });
  return stage;
}

function runValidator(stage, args = []) {
  return spawnSync(
    process.execPath,
    [path.join(stage, "scripts/setup/validate-staged-project.mjs"), ...args],
    {
      cwd: stage,
      encoding: "utf8",
      env: process.env,
      input: "",
      stdio: "pipe",
    },
  );
}

after(() => {
  for (const root of temporaryRoots) rmSync(root, { force: true, recursive: true });
});

test("the copied stage is the authoritative secret-scan boundary", () => {
  const stage = createStage("staged-validator-secret-");
  appendFileSync(path.join(stage, "README.md"), `${["sk-", "a".repeat(24)].join("")}\n`);

  const result = runValidator(stage);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /potential secret material/i);
});

test("the staged validator rejects caller-selected roots and unsafe validator identity", () => {
  const stage = createStage("staged-validator-owned-");
  const decoy = temporaryRoot("caller-selected-stage-");
  const redirected = runValidator(stage, [decoy]);
  assert.equal(redirected.status, 1);
  assert.match(redirected.stderr, /Usage: node scripts\/setup\/validate-staged-project\.mjs/);
  assert.equal(`${redirected.stdout}${redirected.stderr}`.includes(stage), false);
  assert.equal(`${redirected.stdout}${redirected.stderr}`.includes(decoy), false);

  const validator = path.join(stage, "scripts/setup/validate-staged-project.mjs");
  const hardlink = path.join(stage, "validator-hardlink.mjs");
  linkSync(validator, hardlink);
  const unsafeIdentity = runValidator(stage);
  assert.equal(unsafeIdentity.status, 1);
  assert.match(unsafeIdentity.stderr, /validator is not safely bound/i);
  assert.equal(`${unsafeIdentity.stdout}${unsafeIdentity.stderr}`.includes(stage), false);
  rmSync(hardlink);

  const valid = runValidator(stage);
  assert.equal(valid.status, 0, valid.stderr);
});
