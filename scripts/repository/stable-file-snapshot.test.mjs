import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  captureStableRepositoryFileIdentity,
  copyStableRepositoryFile,
  readStableRepositoryFile,
  scanStableRepositoryFile,
} from "./stable-file-snapshot.mjs";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "stable-snapshot-aba-"));
  const target = mkdtempSync(path.join(os.tmpdir(), "stable-snapshot-target-"));
  mkdirSync(path.join(root, "src"));
  mkdirSync(path.join(root, "sessions"));
  mkdirSync(path.join(target, "out"));
  mkdirSync(path.join(target, "runtime"));
  writeFileSync(path.join(root, "src", "source.txt"), "public source\n");
  writeFileSync(path.join(root, "sessions", "source.txt"), "private session\n");
  return { root, target };
}

function sourceAbaHooks(root) {
  const sourceParent = path.join(root, "src");
  const savedParent = path.join(root, "src.saved");
  return {
    beforeOpen() {
      renameSync(sourceParent, savedParent);
      symlinkSync(path.join(root, "sessions"), sourceParent, "dir");
    },
    afterOpen() {
      rmSync(sourceParent);
      renameSync(savedParent, sourceParent);
    },
  };
}

test("stable repository readers reject a restored parent ABA into private runtime state", (t) => {
  const { root, target } = fixture();
  t.after(() => {
    rmSync(root, { force: true, recursive: true });
    rmSync(target, { force: true, recursive: true });
  });
  const options = { repositoryRoot: root, relativePath: "src/source.txt" };

  assert.throws(
    () => captureStableRepositoryFileIdentity({ ...options, testHooks: sourceAbaHooks(root) }),
    /path binding change/,
  );
  assert.throws(
    () => readStableRepositoryFile({ ...options, testHooks: sourceAbaHooks(root) }),
    /path binding change/,
  );
  assert.throws(
    () =>
      scanStableRepositoryFile({
        ...options,
        onChunk() {},
        testHooks: sourceAbaHooks(root),
      }),
    /path binding change/,
  );
  assert.throws(
    () =>
      copyStableRepositoryFile({
        ...options,
        targetRoot: target,
        targetRelativePath: "out/copied.txt",
        testHooks: { source: sourceAbaHooks(root) },
      }),
    /path binding change/,
  );
  assert.equal(existsSync(path.join(target, "out", "copied.txt")), false);
});

test("stable repository copy binds a newly opened target before writing source bytes", (t) => {
  const { root, target } = fixture();
  t.after(() => {
    rmSync(root, { force: true, recursive: true });
    rmSync(target, { force: true, recursive: true });
  });
  const outputParent = path.join(target, "out");
  const savedParent = path.join(target, "out.saved");

  assert.throws(
    () =>
      copyStableRepositoryFile({
        repositoryRoot: root,
        relativePath: "src/source.txt",
        targetRoot: target,
        targetRelativePath: "out/copied.txt",
        testHooks: {
          beforeTargetOpen() {
            renameSync(outputParent, savedParent);
            symlinkSync(path.join(target, "runtime"), outputParent, "dir");
          },
          afterTargetOpen() {
            rmSync(outputParent);
            renameSync(savedParent, outputParent);
          },
        },
      }),
    /path binding change/,
  );
  assert.equal(existsSync(path.join(target, "out", "copied.txt")), false);
  assert.equal(readFileSync(path.join(target, "runtime", "copied.txt"), "utf8"), "");
});
