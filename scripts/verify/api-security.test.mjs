import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { apiSecurityFindings, isApiSource, readApiFiles } from "./api-security.mjs";

function fixture(content, relativePath = "src/routes/account.ts") {
  return { content, relativePath };
}

test("API-like content is recognized independently from ownership", () => {
  assert.equal(isApiSource(fixture("export async function GET() {}")), true);
  assert.equal(
    isApiSource(fixture("router.post('/jobs', handler)", "modules/jobs/worker.ts")),
    true,
  );
});

test("repository API scanning includes declared product roots only", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "api-product-roots-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const write = (relativePath, content) => {
    const target = path.join(root, ...relativePath.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  write("src/routes/root.ts", "router.get('/root', requireAuth(handler))\n");
  write("modules/jobs/routes/ignored.ts", "router.get('/ignored', handler)\n");
  write("pnpm-workspace.yaml", "packages:\n  - 'apps/*'\n");
  write("apps/api/package.json", '{"name":"api"}\n');
  write("apps/api/src/routes/jobs.ts", "router.post('/jobs', requireAuth(handler))\n");
  const files = [
    "src/routes/root.ts",
    "modules/jobs/routes/ignored.ts",
    "pnpm-workspace.yaml",
    "apps/api/package.json",
    "apps/api/src/routes/jobs.ts",
  ];

  assert.deepEqual(
    readApiFiles({ root, files }).map((file) => file.relativePath),
    ["src/routes/root.ts", "apps/api/src/routes/jobs.ts"],
  );
});

test("negative auth statements override unrelated positive keywords", () => {
  const findings = apiSecurityFindings(
    fixture(`
      // Authentication intentionally absent; a token field may be logged for diagnostics.
      router.get('/account', handler)
    `),
  );
  assert.ok(findings.some((finding) => finding.includes("static boundary heuristic")));
  assert.ok(findings.some((finding) => finding.includes("need authentication/authorization")));
});

test("positive auth or a documented internal boundary satisfies the static boundary", () => {
  assert.deepEqual(
    apiSecurityFindings(fixture("router.get('/account', requireAuth(handler))")),
    [],
  );
  assert.deepEqual(
    apiSecurityFindings(
      fixture("// Internal API behind a trusted network boundary\nrouter.get('/health', handler)"),
    ),
    [],
  );
});

test("public API still requires abuse-control evidence", () => {
  const findings = apiSecurityFindings(
    fixture("// Public API with authentication\nrouter.post('/jobs', requireAuth(handler))"),
  );
  assert.ok(findings.some((finding) => finding.includes("rate-limit evidence")));
});
