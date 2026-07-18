import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeCodePatterns,
  isMaintainedExecutablePath,
  maxExecutableLines,
  physicalLineCount,
} from "./patterns.mjs";

function analyze(files) {
  return analyzeCodePatterns({
    activeFiles: Object.keys(files),
    readText: (relativePath) => files[relativePath],
  });
}

test("maintained executable code accepts 700 physical lines and rejects 701", () => {
  assert.equal(maxExecutableLines, 700);
  assert.deepEqual(analyze({ "src/exact.ts": "line\n".repeat(700) }).failures, []);
  assert.match(
    analyze({ "src/over.ts": "line\n".repeat(701) }).failures.join("\n"),
    /src\/over\.ts: 701 physical lines; maximum for maintained executable code is 700/,
  );
});

test("physical line counting treats LF and CRLF consistently", () => {
  assert.equal(physicalLineCount("one\ntwo\n"), 2);
  assert.equal(physicalLineCount("one\r\ntwo\r\n"), 2);
  assert.equal(physicalLineCount("one\r\ntwo"), 2);
  assert.equal(physicalLineCount(""), 0);
});

test("the quota covers executable tests, portable source extensions, and extensionless hooks", () => {
  for (const relativePath of [
    "src/domain.test.ts",
    "src/native.swift",
    "src/module.mts",
    "scripts/git-hooks/pre-push",
  ]) {
    assert.equal(isMaintainedExecutablePath(relativePath), true, relativePath);
  }
});

test("the quota excludes non-code and code-shaped context carriers", () => {
  for (const relativePath of [
    "docs/project.md",
    "src/page.html",
    "src/styles.css",
    "src/schema.sql",
    "src/fixtures/large.ts",
    "src/snapshots/output.js",
    "src/client.generated.ts",
    "generated/client.py",
  ]) {
    assert.equal(isMaintainedExecutablePath(relativePath), false, relativePath);
  }
  const oversized = "line\n".repeat(701);
  assert.deepEqual(
    analyze({
      "docs/project.md": oversized,
      "src/styles.css": oversized,
      "src/fixtures/large.ts": oversized,
      "src/client.generated.ts": oversized,
    }).failures,
    [],
  );
});
