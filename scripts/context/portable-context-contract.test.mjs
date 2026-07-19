import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  portableContextContractFiles,
  portableContextContractFindings,
} from "./portable-context-contract.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const temporaryRoots = [];

function stagedFixture() {
  const parent = mkdtempSync(path.join(os.tmpdir(), "portable-context-contract-"));
  const root = path.join(parent, "stage");
  temporaryRoots.push(parent);
  for (const relativePath of portableContextContractFiles) {
    const target = path.join(root, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(repositoryRoot, relativePath), target);
  }
  return root;
}

function append(root, relativePath, content) {
  const absolutePath = path.join(root, relativePath);
  writeFileSync(absolutePath, `${readFileSync(absolutePath, "utf8")}\n${content}\n`, "utf8");
}

function contradictionFindings(root) {
  return portableContextContractFindings({ repositoryRoot: root }).filter((finding) =>
    finding.includes("contradictory Stop-hook index contract"),
  );
}

after(() => {
  for (const root of temporaryRoots) rmSync(root, { force: true, recursive: true });
});

test("the hook mutation contract permits bounded lifecycle non-mutation", () => {
  const root = stagedFixture();
  append(
    root,
    "README.md",
    "Before bootstrap, the Stop hook does not update the context index. The Stop hook does not update the context index before bootstrap. During normal verification, the Stop hook does not update the context index. The Stop hook does not update the context index during normal verification. After each tool call, the Stop hook does not update the context index. The Stop hook does not update the context index after each tool call.",
  );
  assert.deepEqual(contradictionFindings(root), []);
});

test("the hook mutation contract rejects active and passive obsolete assertions", () => {
  for (const assertion of [
    "Project hooks never\nupdate the context index.",
    "The context index is never\nupdated by the Stop hook.",
    "Project hooks will never update the context index.",
    "The Stop hook never updates `.context-index/`.",
    "The Stop hook does not update the context index before bootstrap, but after bootstrap the Stop hook never updates the context index.",
    "Verification remains read-only; the Stop hook never updates the context index.",
    "The Stop hook never updates the context index; verification remains read-only.",
  ]) {
    const root = stagedFixture();
    append(root, "README.md", assertion);
    assert.equal(
      contradictionFindings(root).some((finding) => finding.endsWith("README.md")),
      true,
    );
  }
});
