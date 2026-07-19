import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { scanRepositorySecrets } from "./secrets.mjs";
import { activeSourcePathClassification } from "../repository/source-inventory.mjs";

const roots = [];

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "secret-scan-"));
  roots.push(root);
  return root;
}

function write(root, relativePath, content) {
  const target = path.join(root, ...relativePath.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

after(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true });
});

test("secret scan covers arbitrary source extensions, binary bytes, and files over one MiB", async () => {
  const root = fixture();
  const apiToken = ["sk-", "a".repeat(24)].join("");
  const keyHeader = ["-----BEGIN PRI", "VATE KEY-----"].join("");
  write(root, "sources/app.py", `value = ${JSON.stringify(apiToken)}\n`);
  write(
    root,
    "assets/large.data",
    Buffer.concat([Buffer.alloc(1024 * 1024 + 32, 65), Buffer.from(`\n${keyHeader}\n`)]),
  );
  write(root, "assets/binary.data", Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(apiToken)]));

  const findings = await scanRepositorySecrets({ root });
  assert.ok(findings.some((finding) => finding.includes("sources/app.py: OpenAI-style API key")));
  assert.ok(findings.some((finding) => finding.includes("assets/large.data: private key block")));
  assert.ok(
    findings.some((finding) => finding.includes("assets/binary.data: OpenAI-style API key")),
  );
});

test("secret scan flags credential paths without rejecting ordinary security source modules", async () => {
  const root = fixture();
  write(root, ".npmrc", "registry=https://example.invalid\n");
  write(root, "src/secrets/provider.ts", "export const provider = 'runtime';\n");

  const findings = await scanRepositorySecrets({ root });
  assert.ok(findings.some((finding) => finding.startsWith(".npmrc:")));
  assert.equal(
    findings.some((finding) => finding.includes("src/secrets/provider.ts")),
    false,
  );
});

test("secret scan classifies private Codex runtime without opening its content", async () => {
  const root = fixture();
  const findings = await scanRepositorySecrets({
    root,
    files: ["sessions/missing-private-session.jsonl", ".codex/cache/missing-runtime.json"],
  });
  assert.deepEqual(findings, [
    "sessions/missing-private-session.jsonl: repository-root Codex runtime or cache state",
    ".codex/cache/missing-runtime.json: project-local Codex runtime or cache state",
  ]);
  assert.equal(
    activeSourcePathClassification("sessions/private.jsonl").code,
    "repository-codex-runtime",
  );
  assert.equal(
    activeSourcePathClassification(".codex/cache/private.json").code,
    "project-codex-runtime",
  );
});

test("secret scan refuses traversal, symlink parents, and hardlinked aliases", async () => {
  const root = fixture();
  const outside = fixture();
  write(outside, "private.txt", "private content without token syntax\n");
  await assert.rejects(
    scanRepositorySecrets({ root, files: ["../private.txt"] }),
    /unsafe repository-relative path/,
  );

  mkdirSync(path.join(root, "src"), { recursive: true });
  symlinkSync(outside, path.join(root, "src", "linked-parent"), "dir");
  await assert.rejects(
    scanRepositorySecrets({ root, files: ["src/linked-parent/private.txt"] }),
    /symlinked parent/,
  );

  write(root, "sessions/private-thread.jsonl", "private runtime without token syntax\n");
  linkSync(
    path.join(root, "sessions", "private-thread.jsonl"),
    path.join(root, "src", "runtime-alias.jsonl"),
  );
  await assert.rejects(
    scanRepositorySecrets({ root, files: ["src/runtime-alias.jsonl"] }),
    /single-link, non-symlink regular repository file/,
  );
});

test("secret scan sees a tracked ignored .env file and its token content", async () => {
  const root = fixture();
  const apiToken = ["sk-", "b".repeat(24)].join("");
  write(root, ".gitignore", ".env\n");
  write(root, ".env", `OPENAI_API_KEY=${apiToken}\n`);
  const git = (args) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8", input: "", stdio: "pipe" });
  assert.equal(git(["init", "-q"]).status, 0);
  const added = git(["add", "-f", ".gitignore", ".env"]);
  assert.equal(added.status, 0, added.stderr);

  const findings = await scanRepositorySecrets({ root });
  assert.ok(findings.includes(".env: environment credential file"));
  assert.ok(findings.includes(".env: OpenAI-style API key"));
});
