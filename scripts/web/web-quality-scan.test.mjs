import assert from "node:assert/strict";
import test from "node:test";
import { collectSitemapLastmodFreshnessFailures } from "../verify/seo.mjs";
import { isIso8601Timestamp } from "./sitemap-metadata.mjs";
import { failMessage, isProductWebSource, isWebCandidate } from "./web-quality-scan.mjs";

const productLayout = {
  findings: [],
  sourceRoots: ["apps/web/src", "src"],
  units: [
    { root: ".", sourceRoots: ["src"], surfaceRoot: "src", kind: "default" },
    {
      root: "apps/web",
      sourceRoots: ["apps/web/src"],
      surfaceRoot: "apps/web",
      kind: "workspace",
    },
  ],
};

test("web candidates follow declared product roots", () => {
  for (const relativePath of [
    "src/App.tsx",
    "apps/web/src/index.html",
    "apps/web/public/page.html",
  ]) {
    assert.equal(isProductWebSource(relativePath, productLayout), true, relativePath);
  }
  for (const relativePath of [
    "web/index.html",
    "modules/catalog/view.vue",
    "examples/site/page.svelte",
  ]) {
    assert.equal(isProductWebSource(relativePath, productLayout), false, relativePath);
  }
});

test("framework automation and non-web files are not product web sources", () => {
  assert.equal(isProductWebSource("scripts/verify/fixture.ts", productLayout), false);
  assert.equal(isProductWebSource("docs/example.html", productLayout), false);
  assert.equal(isWebCandidate("src/service.py"), false);
});

test("repeated findings use indexed line lookup for large context carriers", () => {
  const file = {
    relativePath: "site/archive.html",
    content: `${"x".repeat(600_000)}\n<section>\n<img>`,
  };
  assert.equal(failMessage(file, "first", 500_000), "site/archive.html:1: first");
  assert.equal(
    failMessage(file, "second", file.content.indexOf("<img>")),
    "site/archive.html:3: second",
  );
});

test("sitemap timestamps reject incomplete and impossible calendar values", () => {
  assert.equal(isIso8601Timestamp("2026-07-08T16:29:57+00:00"), true);
  assert.equal(isIso8601Timestamp("2026-07-08"), false);
  assert.equal(isIso8601Timestamp("2026-02-31T00:00:00+00:00"), false);
});

test("changed static pages require an advancing sitemap lastmod", () => {
  const canonical = "https://example.com/";
  const pages = [{ file: { relativePath: "apps/web/index.html" }, canonical }];
  const stale = collectSitemapLastmodFreshnessFailures({
    changedHtmlRelativePaths: new Set(["apps/web/index.html"]),
    currentEntries: [{ loc: canonical, lastmod: "2026-07-08T16:29:57+00:00" }],
    previousEntries: [{ loc: canonical, lastmod: "2026-07-08T16:29:57+00:00" }],
    pages,
  });
  assert.ok(stale.some((failure) => failure.includes("must advance")));

  const advanced = collectSitemapLastmodFreshnessFailures({
    changedHtmlRelativePaths: new Set(["apps/web/index.html"]),
    currentEntries: [{ loc: canonical, lastmod: "2026-07-08T16:30:57+00:00" }],
    previousEntries: [{ loc: canonical, lastmod: "2026-07-08T16:29:57+00:00" }],
    pages,
  });
  assert.deepEqual(advanced, []);
});
