import assert from "node:assert/strict";
import test from "node:test";
import {
  checkRemoteEntry,
  hasEmbeddedCredential,
  isLocalPathLike,
} from "./git-remote-identity.mjs";

function findings(url) {
  return checkRemoteEntry({ mode: "push", name: "origin", url });
}

test("relative and absolute filesystem remotes are rejected", () => {
  for (const url of [
    "../elsewhere.git",
    "./repo.git",
    "repos/project.git",
    "/srv/repo.git",
    "file:../repo.git",
    "git+file:///srv/repo.git",
    "C:repo.git",
  ]) {
    assert.equal(isLocalPathLike(url), true, url);
    assert.ok(
      findings(url).some((finding) => finding.includes("local filesystem path")),
      url,
    );
  }
});

test("HTTP userinfo is rejected even without a password separator", () => {
  for (const url of [
    "https://token@example.com/owner/repo.git",
    "http://user:pass@example.com/repo.git",
  ]) {
    assert.equal(hasEmbeddedCredential(url), true, url);
    assert.ok(
      findings(url).some((finding) => finding.includes("credentials or tokens")),
      url,
    );
  }
});

test("ordinary HTTPS, SSH, and SCP-style remotes remain valid", () => {
  for (const url of [
    "https://example.com/owner/repo.git",
    "ssh://git@example.com/owner/repo.git",
    "git@example.com:owner/repo.git",
  ]) {
    assert.deepEqual(findings(url), [], url);
  }
});
