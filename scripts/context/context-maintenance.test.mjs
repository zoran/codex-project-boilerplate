import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  describeMaintenance,
  maintainContextIndex,
  maintenanceChanged,
  validateContextMaintenanceState,
} from "./context-maintenance.mjs";
import { temporaryDirectory, write } from "./context-regression-helpers.mjs";

const selectedRevision = "7".repeat(40);
const staleRevision = "8".repeat(40);

function maintenanceFixture(prefix = "context-maintenance-") {
  const indexDirectory = temporaryDirectory(prefix);
  const modelCachePath = path.join(indexDirectory, "model-cache");
  const modelParent = path.join(modelCachePath, "Provider", "model");
  const selectedModelRevisionDirectory = path.join(modelParent, selectedRevision);
  write(selectedModelRevisionDirectory, "config.json", "selected model\n");
  return {
    indexDirectory,
    databasePath: path.join(indexDirectory, "lancedb"),
    manifestPath: path.join(indexDirectory, "manifest.json"),
    modelCachePath,
    selectedModelRevisionDirectory,
  };
}

test("maintenance is idempotent and preserves selected database and model generations", () => {
  const fixture = maintenanceFixture();
  write(fixture.indexDirectory, "manifest.json", "selected manifest\n");
  write(fixture.indexDirectory, "lancedb/selected", "selected database\n");
  write(fixture.indexDirectory, "manifest.next-10.json", "abandoned manifest\n");
  write(fixture.indexDirectory, "lancedb.next-10/abandoned", "abandoned database\n");
  write(
    fixture.indexDirectory,
    ".context-removal-directory-00000000-0000-4000-8000-000000000000/stale",
    "interrupted removal\n",
  );
  write(
    path.dirname(fixture.selectedModelRevisionDirectory),
    `${staleRevision}/config.json`,
    "old\n",
  );
  write(
    fixture.modelCachePath,
    `OtherProvider/other-model/${"9".repeat(64)}/config.json`,
    "other old model\n",
  );
  write(
    fixture.selectedModelRevisionDirectory,
    ".artifact-hash.json.123.456.tmp",
    "interrupted hash cache\n",
  );
  write(
    fixture.selectedModelRevisionDirectory,
    ".context-removal-file-00000000-0000-4000-8000-000000000001",
    "interrupted selected cache removal\n",
  );
  write(path.dirname(fixture.selectedModelRevisionDirectory), "config.json", "selected model\n");

  const first = maintainContextIndex(fixture);
  assert.equal(maintenanceChanged(first), true);
  assert.equal(first.removedDatabaseGenerations, 1);
  assert.equal(first.removedManifestGenerations, 1);
  assert.equal(first.removedModelGenerations, 2);
  assert.equal(first.removedModelTemporaryArtifacts, 1);
  assert.equal(first.removedLegacyModelArtifacts, 1);
  assert.equal(first.removedInterruptedClaims, 2);
  assert.equal(readFileSync(fixture.manifestPath, "utf8"), "selected manifest\n");
  assert.equal(
    readFileSync(path.join(fixture.databasePath, "selected"), "utf8"),
    "selected database\n",
  );
  assert.equal(
    readFileSync(path.join(fixture.selectedModelRevisionDirectory, "config.json"), "utf8"),
    "selected model\n",
  );
  assert.equal(
    existsSync(path.join(path.dirname(fixture.selectedModelRevisionDirectory), staleRevision)),
    false,
  );
  assert.equal(
    existsSync(path.join(fixture.modelCachePath, "OtherProvider", "other-model", "9".repeat(64))),
    false,
  );
  assert.equal(
    existsSync(
      path.join(fixture.selectedModelRevisionDirectory, ".artifact-hash.json.123.456.tmp"),
    ),
    false,
  );
  assert.doesNotMatch(describeMaintenance(first), /context-maintenance|Provider|model-cache/);

  const second = maintainContextIndex(fixture);
  assert.equal(maintenanceChanged(second), false);
  assert.equal(describeMaintenance(second), "no maintenance changes");
});

test("read-only maintenance validation preserves safe candidates", () => {
  const fixture = maintenanceFixture("context-maintenance-validation-");
  write(fixture.indexDirectory, "manifest.json", "selected manifest\n");
  write(fixture.indexDirectory, "lancedb/selected", "selected database\n");
  write(fixture.indexDirectory, "manifest.next-11.json", "candidate manifest\n");
  write(fixture.indexDirectory, "lancedb.next-11/candidate", "candidate database\n");
  write(
    fixture.selectedModelRevisionDirectory,
    ".artifact-hash.json.321.654.tmp",
    "candidate hash cache\n",
  );

  validateContextMaintenanceState(fixture);
  assert.equal(
    readFileSync(path.join(fixture.indexDirectory, "manifest.next-11.json"), "utf8"),
    "candidate manifest\n",
  );
  assert.equal(
    readFileSync(path.join(fixture.indexDirectory, "lancedb.next-11/candidate"), "utf8"),
    "candidate database\n",
  );
  assert.equal(
    readFileSync(
      path.join(fixture.selectedModelRevisionDirectory, ".artifact-hash.json.321.654.tmp"),
      "utf8",
    ),
    "candidate hash cache\n",
  );
});

test("read-only validation reports a removable identical legacy model config", () => {
  const fixture = maintenanceFixture("context-maintenance-legacy-status-");
  const legacyConfigPath = path.join(
    path.dirname(fixture.selectedModelRevisionDirectory),
    "config.json",
  );
  writeFileSync(legacyConfigPath, "selected model\n");

  const status = validateContextMaintenanceState(fixture);
  assert.equal(status.pending, true);
  assert.equal(readFileSync(legacyConfigPath, "utf8"), "selected model\n");
  assert.equal(
    readFileSync(path.join(fixture.selectedModelRevisionDirectory, "config.json"), "utf8"),
    "selected model\n",
  );
});

test("maintenance restores only a validated previous database-manifest pair", () => {
  const fixture = maintenanceFixture("context-maintenance-recovery-");
  write(fixture.indexDirectory, "lancedb/unpublished", "unpublished database\n");
  write(fixture.indexDirectory, "lancedb.previous-20/selected", "previous database\n");
  write(fixture.indexDirectory, "manifest.previous-20.json", "previous manifest\n");
  write(fixture.indexDirectory, "lancedb.next-20/candidate", "candidate database\n");
  write(fixture.indexDirectory, "manifest.next-20.json", "candidate manifest\n");

  const summary = maintainContextIndex(fixture);
  assert.equal(summary.recoveredGenerationPairs, 1);
  assert.equal(readFileSync(fixture.manifestPath, "utf8"), "previous manifest\n");
  assert.equal(
    readFileSync(path.join(fixture.databasePath, "selected"), "utf8"),
    "previous database\n",
  );
  assert.equal(existsSync(path.join(fixture.indexDirectory, "lancedb.next-20")), false);
});

test("maintenance restores a complete previous pair when only a manifest remains", () => {
  const fixture = maintenanceFixture("context-maintenance-manifest-only-");
  write(fixture.indexDirectory, "manifest.json", "unpaired manifest\n");
  write(fixture.indexDirectory, "lancedb.previous-21/selected", "previous database\n");
  write(fixture.indexDirectory, "manifest.previous-21.json", "previous manifest\n");

  const summary = maintainContextIndex(fixture);
  assert.equal(summary.recoveredGenerationPairs, 1);
  assert.equal(summary.removedManifestGenerations, 1);
  assert.equal(readFileSync(fixture.manifestPath, "utf8"), "previous manifest\n");
  assert.equal(
    readFileSync(path.join(fixture.databasePath, "selected"), "utf8"),
    "previous database\n",
  );
});

test("maintenance preserves ambiguous and unknown state while failing closed", () => {
  const ambiguous = maintenanceFixture("context-maintenance-ambiguous-");
  for (const suffix of ["22", "23"]) {
    write(ambiguous.indexDirectory, `lancedb.previous-${suffix}/selected`, `${suffix}\n`);
    write(ambiguous.indexDirectory, `manifest.previous-${suffix}.json`, `${suffix}\n`);
  }
  assert.throws(() => maintainContextIndex(ambiguous), /ambiguous previous generation pairs/);
  assert.equal(existsSync(path.join(ambiguous.indexDirectory, "lancedb.previous-22")), true);
  assert.equal(
    readFileSync(path.join(ambiguous.indexDirectory, "manifest.previous-23.json"), "utf8"),
    "23\n",
  );

  const unknown = maintenanceFixture("context-maintenance-unknown-");
  write(unknown.indexDirectory, "unclassified-state", "preserve me\n");
  assert.throws(() => maintainContextIndex(unknown), /unknown index artifact/);
  assert.equal(
    readFileSync(path.join(unknown.indexDirectory, "unclassified-state"), "utf8"),
    "preserve me\n",
  );

  const incomplete = maintenanceFixture("context-maintenance-incomplete-");
  write(incomplete.indexDirectory, "lancedb.previous-24/selected", "previous database\n");
  assert.throws(() => maintainContextIndex(incomplete), /incomplete previous generation/);
  assert.equal(
    readFileSync(path.join(incomplete.indexDirectory, "lancedb.previous-24/selected"), "utf8"),
    "previous database\n",
  );
});

test("maintenance fails closed for malformed, symlinked, and hardlinked artifacts", () => {
  const malformed = maintenanceFixture("context-maintenance-malformed-");
  write(malformed.indexDirectory, "lancedb.next-30", "not a directory\n");
  assert.throws(() => maintainContextIndex(malformed), /refused malformed/);
  assert.equal(
    readFileSync(path.join(malformed.indexDirectory, "lancedb.next-30"), "utf8"),
    "not a directory\n",
  );

  const linked = maintenanceFixture("context-maintenance-symlink-");
  const outside = temporaryDirectory("context-maintenance-outside-");
  write(outside, "sentinel", "outside\n");
  symlinkSync(outside, path.join(linked.indexDirectory, "lancedb.next-31"), "dir");
  assert.throws(() => maintainContextIndex(linked), /refused malformed/);
  assert.equal(readFileSync(path.join(outside, "sentinel"), "utf8"), "outside\n");

  const hardlinked = maintenanceFixture("context-maintenance-hardlink-");
  const hardlinkSource = temporaryDirectory("context-maintenance-hardlink-source-");
  const original = path.join(hardlinkSource, "original.json");
  writeFileSync(original, "hardlinked\n");
  linkSync(original, path.join(hardlinked.indexDirectory, "manifest.next-32.json"));
  assert.throws(() => maintainContextIndex(hardlinked), /refused hardlinked/);
  assert.equal(readFileSync(original, "utf8"), "hardlinked\n");

  const linkedModel = maintenanceFixture("context-maintenance-model-link-");
  const linkedModelOutside = temporaryDirectory("context-maintenance-model-link-outside-");
  write(linkedModelOutside, `${selectedRevision}/config.json`, "outside selected model\n");
  write(linkedModelOutside, `${staleRevision}/sentinel`, "preserve outside revision\n");
  const modelParent = path.dirname(linkedModel.selectedModelRevisionDirectory);
  rmSync(modelParent, { recursive: true });
  symlinkSync(linkedModelOutside, modelParent, "dir");
  assert.throws(
    () => validateContextMaintenanceState(linkedModel),
    /refused malformed selected model/,
  );
  assert.throws(() => maintainContextIndex(linkedModel), /refused malformed selected model/);
  assert.equal(
    readFileSync(path.join(linkedModelOutside, staleRevision, "sentinel"), "utf8"),
    "preserve outside revision\n",
  );

  const unselectedLink = maintenanceFixture("context-maintenance-unselected-model-link-");
  write(unselectedLink.indexDirectory, "manifest.next-33.json", "preserve candidate\n");
  const unselectedOutside = temporaryDirectory("context-maintenance-unselected-outside-");
  write(unselectedOutside, "sentinel", "outside unselected model\n");
  symlinkSync(unselectedOutside, path.join(unselectedLink.modelCachePath, "OtherProvider"), "dir");
  assert.throws(() => maintainContextIndex(unselectedLink), /malformed model-cache directory/);
  assert.equal(
    readFileSync(path.join(unselectedLink.indexDirectory, "manifest.next-33.json"), "utf8"),
    "preserve candidate\n",
  );
  assert.equal(
    readFileSync(path.join(unselectedOutside, "sentinel"), "utf8"),
    "outside unselected model\n",
  );
});

test("maintenance never removes a replacement with a changed identity", () => {
  const fixture = maintenanceFixture("context-maintenance-race-");
  const candidate = path.join(fixture.indexDirectory, "lancedb.next-40");
  const displaced = path.join(fixture.indexDirectory, "displaced-candidate");
  write(candidate, "original", "original\n");
  let replaced = false;
  assert.throws(
    () =>
      maintainContextIndex({
        ...fixture,
        testHooks: {
          afterArtifactValidation({ artifactPath, label }) {
            if (replaced || label !== "lancedb.next-40") return;
            replaced = true;
            renameSync(artifactPath, displaced);
            mkdirSync(artifactPath);
            writeFileSync(path.join(artifactPath, "replacement"), "replacement\n");
          },
        },
      }),
    /identity change/,
  );
  assert.equal(readFileSync(path.join(candidate, "replacement"), "utf8"), "replacement\n");
  assert.equal(readFileSync(path.join(displaced, "original"), "utf8"), "original\n");
});
