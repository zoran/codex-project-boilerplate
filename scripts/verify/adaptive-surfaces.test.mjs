import assert from "node:assert/strict";
import test from "node:test";
import { hasImageSurfaceInFiles } from "./adaptive-surfaces.mjs";

const noDisk = {
  readText: (relativePath) =>
    relativePath === "apps/site/src/view.tsx" ? "return <img src='/hero.webp' alt='Hero' />" : "",
  productLayout: {
    findings: [],
    sourceRoots: ["apps/site/src", "src"],
    units: [
      {
        root: ".",
        sourceRoots: ["src"],
        surfaceRoot: "src",
        kind: "default",
        declaredBy: "fixture",
      },
      {
        root: "apps/site",
        sourceRoots: ["apps/site/src"],
        surfaceRoot: "apps/site",
        kind: "workspace",
        declaredBy: "apps/site/package.json",
      },
    ],
  },
};

test("image surfaces are detected in declared product roots only", () => {
  assert.equal(hasImageSurfaceInFiles(["apps/site/public/hero.png"], noDisk), true);
  assert.equal(hasImageSurfaceInFiles(["apps/site/src/view.tsx"], noDisk), true);
  assert.equal(hasImageSurfaceInFiles(["custom/assets/hero.png"], noDisk), false);
  assert.equal(hasImageSurfaceInFiles(["modules/site/view.tsx"], noDisk), false);
});

test("framework verification source does not detect its own image patterns", () => {
  assert.equal(
    hasImageSurfaceInFiles(["scripts/verify/image-assets.mjs"], {
      readText: () => "<img src='fixture.png'>",
      sizeOf: () => 100,
    }),
    false,
  );
});
