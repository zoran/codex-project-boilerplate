import assert from "node:assert/strict";
import { test } from "node:test";
import { formatContextError, sanitizeMultilineForTerminal } from "./terminal-output.mjs";

test("terminal output redacts unknown absolute paths with spaces through the end of the line", () => {
  const value = "failure at /tmp/private workspace/secret-name/file.txt\nnext line";
  const sanitized = sanitizeMultilineForTerminal(value, "/different/root");
  assert.equal(sanitized, "failure at <local-path>\nnext line");
  assert.equal(sanitized.includes("workspace"), false);
  assert.equal(sanitized.includes("secret-name"), false);
});

test("context errors redact quoted POSIX, Windows, and file URL paths containing spaces", () => {
  for (const value of [
    'failed at "/tmp/private workspace/secret-name/file.txt"',
    'failed at "C:\\private workspace\\secret-name\\file.txt"',
    'failed at "file:///tmp/private workspace/secret-name/file.txt"',
  ]) {
    const sanitized = formatContextError(value, "/different/root");
    assert.equal(sanitized.includes("private workspace"), false);
    assert.equal(sanitized.includes("secret-name"), false);
    assert.match(sanitized, /<local-path>/);
  }
});

test("path redaction handles root-prefix collisions, punctuation boundaries, and UNC paths", () => {
  const tick = String.fromCharCode(96);
  const value = [
    "collision /tmp/project-private/secret-name/file.txt",
    "colon:/tmp/private workspace/secret-name/file.txt",
    "tick " + tick + "/tmp/private workspace/secret-name/file.txt" + tick,
    "bracket [/tmp/private workspace/secret-name/file.txt]",
    "hyphen-/tmp/private workspace/secret-name/file.txt",
    "hyphen-C:\\private workspace\\secret-name\\file.txt",
    "unc \\\\server\\private workspace\\secret-name\\file.txt",
  ].join("\n");
  const sanitized = sanitizeMultilineForTerminal(value, "/tmp/project");
  assert.equal(sanitized.includes("/tmp/"), false);
  assert.equal(sanitized.includes("private workspace"), false);
  assert.equal(sanitized.includes("secret-name"), false);
  assert.equal(sanitized.includes("\\\\server"), false);
  assert.equal(sanitized.match(/<local-path>/g)?.length, 7);
});

test("known project-root paths stay useful and require left and right boundaries", () => {
  assert.equal(
    sanitizeMultilineForTerminal(
      "project /tmp/project/src/file.mjs\nother /tmp/project-other/private.txt",
      "/tmp/project",
    ),
    "project ./src/file.mjs\nother <local-path>",
  );
  assert.equal(
    sanitizeMultilineForTerminal("docs https://example.invalid/tmp/project/api", "/tmp/project"),
    "docs https://example.invalid/tmp/project/api",
  );
  assert.equal(
    sanitizeMultilineForTerminal(
      "prefix/tmp/project/secret-name.txt\nnotfile:///tmp/project/secret-name.txt",
      "/tmp/project",
    ),
    "prefix/tmp/project/secret-name.txt\nnotfile:<local-path>",
  );
});

test("unknown paths redact legal punctuation inside path segments conservatively", () => {
  for (const value of [
    "at /tmp/private[secret-name]/token.txt then continue",
    "at /tmp/private(secret-name)/token.txt then continue",
    "at C:\\private{secret-name}\\token.txt then continue",
  ]) {
    const sanitized = sanitizeMultilineForTerminal(value, "/different/root");
    assert.equal(sanitized, "at <local-path>");
    assert.equal(sanitized.includes("secret-name"), false);
  }
});

test("control sequences cannot conceal paths or rewrite terminal lines", () => {
  for (const value of [
    "failure at \u001b[31m/tmp/private workspace/secret-name/file.txt\u001b[0m",
    "failure at \u202e/tmp/private workspace/secret-name/file.txt",
    "failure at \u001b[31mC:\\private workspace\\secret-name\\file.txt\u001b[0m",
    "failure at \u001b[31m\\\\server\\private workspace\\secret-name\\file.txt\u001b[0m",
    "prefix\u001b[0m/tmp/private workspace/secret-name/file.txt",
    "prefix\u202e/tmp/private workspace/secret-name/file.txt",
    "prefix\u001b[0mC:\\private workspace\\secret-name\\file.txt",
  ]) {
    const sanitized = sanitizeMultilineForTerminal(value, "/different/root");
    assert.equal(sanitized.includes("secret-name"), false);
    assert.match(sanitized, /<local-path>/);

    const formatted = formatContextError(value, "/different/root");
    assert.equal(formatted.includes("secret-name"), false);
    assert.match(formatted, /<local-path>/);
  }

  assert.equal(
    sanitizeMultilineForTerminal("visible\r\nhidden\rlast", "/different/root"),
    "visible\nhidden\nlast",
  );
});

test("context output redacts recognized secrets after removing control sequences", () => {
  const openAiToken = `sk-${"z".repeat(32)}`;
  const githubToken = `ghp_${"a".repeat(36)}`;
  const value = [
    `native failure token=${openAiToken}`,
    `split control token=sk-${"y".repeat(10)}\u001b[31m${"y".repeat(22)}`,
    `github=${githubToken}`,
  ].join("\n");
  const sanitized = sanitizeMultilineForTerminal(value, "/different/root");

  assert.equal(sanitized.includes(openAiToken), false);
  assert.equal(sanitized.includes(githubToken), false);
  assert.equal(sanitized.includes("sk-"), false);
  assert.equal(sanitized.includes("ghp_"), false);
  assert.equal(sanitized.match(/<redacted-secret>/g)?.length, 3);
});
