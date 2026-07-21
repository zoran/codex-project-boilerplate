import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { inspectModelArtifacts } from "./context-embedding.mjs";
import { schemaVersion, validateManifest } from "./context-manifest.mjs";
import {
  copyTree,
  repositoryRoot,
  temporaryDirectory,
  write,
} from "./context-regression-helpers.mjs";

const semanticAcceptanceCases = [
  {
    query: "choose checks affected by the current edits",
    text: "Adaptive verification decisions route changed paths to bounded validation owners.",
    path: "scripts/verify/adaptive-runner.mjs",
  },
  {
    query: "keep portable project policy separate from mutable repository runtime",
    text: "Generated projects keep portable policy separate from mutable repository-root runtime.",
    path: "scripts/setup/validate-staged-project.mjs",
  },
  {
    query: "prevent two index builders from publishing together",
    text: "Context rebuild lock ownership uses a heartbeat and atomic stale-generation quarantine.",
    path: "scripts/context/context-lock.mjs",
  },
  {
    query: "identify authentication material before preserving revisions",
    text: "Secret-pattern scanning detects private tokens and credential material in active sources.",
    path: "scripts/verify/secret-patterns.mjs",
  },
  {
    query: "clone the starter into a clean sibling and rewrite manifests",
    text: "Project initialization copies portable policy safely and rewrites package metadata for a separate workspace.",
    path: "scripts/setup/initialize-project.mjs",
  },
];

test(
  "warm-offline CLI and Stop hook incrementally refresh add/change/delete and repair corrupt state",
  { timeout: 120_000 },
  async (context) => {
    if (process.env.CONTEXT_TEST_REAL_MODEL !== "1") {
      context.skip("set CONTEXT_TEST_REAL_MODEL=1 to run the pinned-model integration");
      return;
    }
    const sharedModelCache = path.join(repositoryRoot, ".context-index", "model-cache");
    if (!inspectModelArtifacts(sharedModelCache).complete) {
      throw new Error("CONTEXT_TEST_REAL_MODEL=1 requires the pinned local model cache.");
    }
    const root = temporaryDirectory("context-integration-");
    execFileSync("git", ["init", "-q"], { cwd: root });
    write(root, "docs/a.md", "# Alpha\n\nIncremental retrieval alpha.\n");
    write(root, "docs/b.md", "# Beta\n\nThis file will be removed.\n");
    write(
      root,
      "docs/semantic.md",
      "# Permission gate\n\nBefore a command proceeds, policy verifies the caller identity and whether that actor may perform the requested operation.\n",
    );
    write(root, "src/stable.ts", "export const stableRetrieval = true;\n");
    for (const fixture of semanticAcceptanceCases) {
      write(root, fixture.path, `${fixture.text}\n`);
    }
    execFileSync("git", ["add", "-A"], { cwd: root });
    copyTree(sharedModelCache, path.join(root, ".context-index", "model-cache"));
    const env = {
      ...process.env,
      CONTEXT_INDEX_TEST_MODE: "1",
      CONTEXT_INDEX_ROOT: root,
      CONTEXT_INDEX_DIRECTORY: path.join(root, ".context-index"),
      CONTEXT_INDEX_OFFLINE: "1",
      CONTEXT_INDEX_ONNX_THREADS: "1",
    };
    const script = path.join(repositoryRoot, "scripts/context/search-context.mjs");
    const firstStartedAt = performance.now();
    const first = execFileSync(process.execPath, [script, "incremental retrieval alpha"], {
      cwd: repositoryRoot,
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
    const firstWallMs = Math.round(performance.now() - firstStartedAt);
    assert.match(first, /Context index refreshed/);
    assert.match(first, /Results:/);
    assert.equal(first.includes(root), false);
    const manifestPath = path.join(root, ".context-index", "manifest.json");
    const firstManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const staleSearchCandidate = path.join(root, ".context-index", "manifest.next-60.json");
    writeFileSync(staleSearchCandidate, "stale search candidate\n");
    const semantic = execFileSync(
      process.execPath,
      [script, "authorization boundary", "--limit=1"],
      {
        cwd: repositoryRoot,
        env,
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    assert.match(semantic, /docs\/semantic\.md/);
    assert.doesNotMatch(semantic, /Context index refreshed/);
    assert.match(semantic, /Context index maintenance: removed 1 validated stale artifact/);
    assert.equal(semantic.includes(root), false);
    assert.equal(existsSync(staleSearchCandidate), false);
    const semanticRanks = [];
    for (const fixture of semanticAcceptanceCases) {
      const output = execFileSync(process.execPath, [script, fixture.query, "--limit=5"], {
        cwd: repositoryRoot,
        env,
        encoding: "utf8",
        timeout: 30_000,
      });
      const escapedPath = fixture.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = output.match(new RegExp(`^([1-5])\\. ${escapedPath}:`, "m"));
      assert.ok(match, `${fixture.path} should rank in the pinned model's top five`);
      semanticRanks.push(Number(match[1]));
    }

    write(root, "docs/a.md", "# Alpha\n\nIncremental retrieval alpha changed.\n");
    rmSync(path.join(root, "docs/b.md"));
    write(root, "docs/c.md", "# Gamma\n\nNew exact retrieval phrase.\n");
    const secondStartedAt = performance.now();
    const stopHookWorker = path.join(
      repositoryRoot,
      "scripts/context/refresh-context-index-on-stop.mjs",
    );
    const stopHook = spawnSync(process.execPath, [stopHookWorker], {
      cwd: repositoryRoot,
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
    const secondWallMs = Math.round(performance.now() - secondStartedAt);
    assert.equal(stopHook.status, 0);
    assert.equal(stopHook.stdout, "");
    assert.equal(stopHook.stderr, "");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.ok(manifest.stats.reusedChunks > 0);
    assert.equal(manifest.stats.addedFiles, 1);
    assert.equal(manifest.stats.changedFiles, 1);
    assert.equal(manifest.stats.removedFiles, 1);
    const second = execFileSync(process.execPath, [script, "new exact retrieval phrase"], {
      cwd: repositoryRoot,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.doesNotMatch(second, /Context index refreshed/);
    assert.match(second, /docs\/c\.md/);

    const warmWallMs = [];
    for (let run = 0; run < 5; run += 1) {
      const warmStartedAt = performance.now();
      const warm = execFileSync(process.execPath, [script, "new exact retrieval phrase"], {
        cwd: repositoryRoot,
        env,
        encoding: "utf8",
        timeout: 30_000,
      });
      warmWallMs.push(Math.round(performance.now() - warmStartedAt));
      assert.doesNotMatch(warm, /Context index refreshed/);
      assert.match(warm, /docs\/c\.md/);
    }

    const lancedb = await import("@lancedb/lancedb");
    const databasePath = path.join(root, ".context-index", "lancedb");
    let db = await lancedb.connect(databasePath);
    let table = await db.openTable("context_chunks");
    const versionBeforeTouch = await table.version();
    await db.close();
    const databaseInodeBeforeTouch = statSync(databasePath).ino;
    const stablePath = path.join(root, "src/stable.ts");
    const future = new Date(Date.now() + 2_000);
    utimesSync(stablePath, future, future);
    const metadataRefresh = execFileSync(process.execPath, [script, "stable retrieval"], {
      cwd: repositoryRoot,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.match(metadataRefresh, /source metadata changed/);
    const metadataManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(metadataManifest.stats.databaseMode, "manifest-only");
    assert.equal(metadataManifest.stats.embeddedChunks, 0);
    assert.equal(metadataManifest.stats.metadataRefreshedFiles, 1);
    assert.equal(
      metadataManifest.stats.databaseModificationOperations,
      manifest.stats.databaseModificationOperations,
    );
    assert.equal(
      metadataManifest.stats.databaseModificationAffectedRows,
      manifest.stats.databaseModificationAffectedRows,
    );
    assert.equal(
      metadataManifest.stats.databaseIndexComplete,
      manifest.stats.databaseIndexComplete,
    );
    assert.equal(metadataManifest.stats.vectorIndexEnabled, manifest.stats.vectorIndexEnabled);
    assert.equal("durationMs" in metadataManifest.stats, false);
    assert.equal(statSync(databasePath).ino, databaseInodeBeforeTouch);
    db = await lancedb.connect(databasePath);
    table = await db.openTable("context_chunks");
    assert.equal(await table.version(), versionBeforeTouch);
    await db.close();

    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        {
          ...metadataManifest,
          stats: {
            ...metadataManifest.stats,
            databaseModificationOperations: 0,
            databaseModificationAffectedRows: 99_999,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    write(root, "docs/row-pressure.md", "# Row pressure\n\nRow threshold settling fixture.\n");
    const databaseInodeBeforeRowSettlement = statSync(databasePath).ino;
    const rowSettlement = execFileSync(process.execPath, [script, "row threshold settling"], {
      cwd: repositoryRoot,
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.match(rowSettlement, /Context index refreshed/);
    const rowSettledManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(rowSettledManifest.stats.databaseMode, "full");
    assert.equal(rowSettledManifest.stats.databaseModificationOperations, 0);
    assert.equal(rowSettledManifest.stats.databaseModificationAffectedRows, 0);
    assert.equal(rowSettledManifest.stats.databaseIndexComplete, true);
    assert.equal(rowSettledManifest.stats.embeddedVectors, 0);
    assert.equal(rowSettledManifest.stats.reusedChunks, rowSettledManifest.stats.chunks);
    assert.notEqual(statSync(databasePath).ino, databaseInodeBeforeRowSettlement);

    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        {
          ...rowSettledManifest,
          stats: {
            ...rowSettledManifest.stats,
            databaseModificationOperations: 19,
            databaseModificationAffectedRows: 0,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    write(root, "src/stable.ts", "export const stableRetrieval = 'operation threshold';\n");
    const databaseInodeBeforeOperationReplacement = statSync(databasePath).ino;
    const operationReplacement = execFileSync(process.execPath, [script, "operation threshold"], {
      cwd: repositoryRoot,
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.match(operationReplacement, /Context index refreshed/);
    const operationReplacedManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(operationReplacedManifest.stats.databaseMode, "full");
    assert.equal(operationReplacedManifest.stats.databaseModificationOperations, 0);
    assert.equal(operationReplacedManifest.stats.databaseModificationAffectedRows, 0);
    assert.equal(operationReplacedManifest.stats.databaseIndexComplete, true);
    assert.ok(operationReplacedManifest.stats.reusedChunks > 0);
    assert.ok(operationReplacedManifest.stats.embeddedVectors > 0);
    assert.notEqual(statSync(databasePath).ino, databaseInodeBeforeOperationReplacement);

    write(
      path.join(root, ".context-index"),
      "database-repair-required.json",
      '{"version":1,"reason":"test fixture"}\n',
    );
    const checkScript = path.join(repositoryRoot, "scripts/context/check-context-index.mjs");
    const repairStatus = spawnSync(
      process.execPath,
      [checkScript, "--no-repair", "--status-only"],
      { cwd: repositoryRoot, env, encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(repairStatus.status, 1);
    assert.match(`${repairStatus.stdout}${repairStatus.stderr}`, /full database repair required/);
    const markerRepair = execFileSync(process.execPath, [script, "stable retrieval"], {
      cwd: repositoryRoot,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.match(markerRepair, /Context index refreshed/);
    assert.equal(
      existsSync(path.join(root, ".context-index", "database-repair-required.json")),
      false,
    );
    const repairManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(repairManifest.stats.reusedChunks, 0);
    assert.equal(repairManifest.stats.embeddedChunks, repairManifest.stats.chunks);
    assert.equal(repairManifest.stats.databaseIndexComplete, true);

    const previousSchemaManifest = {
      ...repairManifest,
      schemaVersion: schemaVersion - 1,
    };
    writeFileSync(manifestPath, `${JSON.stringify(previousSchemaManifest, null, 2)}\n`, "utf8");
    const databaseInodeBeforeSchemaUpgrade = statSync(databasePath).ino;
    const repairStartedAt = performance.now();
    const repaired = execFileSync(process.execPath, [script, "stable retrieval"], {
      cwd: repositoryRoot,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    const repairWallMs = Math.round(performance.now() - repairStartedAt);
    assert.match(repaired, /invalid:/);
    assert.equal((repaired.match(/Context index refreshed/g) ?? []).length, 1);
    const upgradedManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(validateManifest(upgradedManifest).valid, true);
    assert.equal(upgradedManifest.schemaVersion, schemaVersion);
    assert.equal(upgradedManifest.stats.reusedChunks, 0);
    assert.equal(upgradedManifest.stats.databaseIndexComplete, true);
    assert.notEqual(statSync(databasePath).ino, databaseInodeBeforeSchemaUpgrade);
    context.diagnostic(
      JSON.stringify({
        firstWallMs,
        firstBuild: firstManifest.stats,
        incrementalWallMs: secondWallMs,
        incrementalBuild: manifest.stats,
        warmSearchWallMs: warmWallMs,
        semanticRanks,
        metadataOnlyDatabaseVersion: versionBeforeTouch,
        corruptRepairWallMs: repairWallMs,
      }),
    );
  },
);
