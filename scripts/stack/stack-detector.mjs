import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  discoverProductLayout,
  isProductImplementationPath,
} from "../repository/product-roots.mjs";
import { listActiveFiles } from "../repository/source-inventory.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDir, "..", "..");
const maxFileBytes = 512 * 1024;
const sourceExtensions = new Set([
  ".astro",
  ".c",
  ".cc",
  ".cpp",
  ".css",
  ".cjs",
  ".cts",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".svelte",
  ".ts",
  ".tsx",
  ".vue",
]);

const configBasenames = new Set([
  "build.gradle",
  "build.gradle.kts",
  "cargo.toml",
  "cmakelists.txt",
  "go.mod",
  "gemfile",
  "makefile",
  "package.json",
  "pom.xml",
  "postcss.config.cjs",
  "postcss.config.js",
  "postcss.config.mjs",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "svelte.config.js",
  "tailwind.config.cjs",
  "tailwind.config.js",
  "tailwind.config.mjs",
  "tailwind.config.ts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.ts",
]);

const primaryWebFrameworks = new Set([
  "angular",
  "astro",
  "nextjs",
  "react",
  "svelte",
  "sveltekit",
  "vue",
]);

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function relativePath(root, fullPath) {
  return toPosix(path.relative(root, fullPath)) || ".";
}

function isCandidateFile(filePath) {
  const basename = path.basename(filePath).toLowerCase();
  return sourceExtensions.has(path.extname(filePath)) || configBasenames.has(basename);
}

function candidateFiles(root, relativePaths, productLayout) {
  if (!existsSync(root)) return [];
  const paths = relativePaths ?? listActiveFiles({ root });
  const activeUnits = productLayout.units.filter((productUnit) =>
    paths.some(
      (relativePathValue) =>
        isCandidateFile(relativePathValue) &&
        productUnit.sourceRoots.some(
          (sourceRoot) =>
            relativePathValue === sourceRoot || relativePathValue.startsWith(`${sourceRoot}/`),
        ),
    ),
  );
  return paths
    .filter((relativePathValue) => {
      if (!isCandidateFile(relativePathValue)) return false;
      if (isProductImplementationPath(relativePathValue, productLayout)) return true;
      return activeUnits.some((productUnit) => {
        const owner = productUnit.root === "." ? "" : `${productUnit.root}/`;
        return (
          relativePathValue === productUnit.declaredBy ||
          (relativePathValue.startsWith(owner) &&
            !relativePathValue.slice(owner.length).includes("/") &&
            configBasenames.has(path.basename(relativePathValue).toLowerCase()))
        );
      });
    })
    .map((relativePathValue) => path.join(root, ...relativePathValue.split("/")));
}

function readText(filePath, { prefixOnly = false } = {}) {
  const bytes = statSync(filePath).size;
  if (!prefixOnly || bytes <= maxFileBytes) return readFileSync(filePath, "utf8");
  const descriptor = openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(maxFileBytes);
  try {
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

function readJson(root, filePath, failures, readSource) {
  try {
    return JSON.parse(readSource(filePath));
  } catch {
    failures.push(`${relativePath(root, filePath)}: invalid JSON`);
    return null;
  }
}

function dependenciesFromPackageJson(pkg) {
  return {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.peerDependencies,
    ...pkg.optionalDependencies,
  };
}

function packageRootFor(root, filePath, packageJsonFiles) {
  const sorted = [...packageJsonFiles].sort((a, b) => b.length - a.length);
  const owner = sorted.find((packagePath) => {
    const packageDir = path.dirname(packagePath);
    return filePath === packagePath || filePath.startsWith(`${packageDir}${path.sep}`);
  });
  return owner ? relativePath(root, path.dirname(owner)) : ".";
}

function createEvidence(filePath, detail, weight = 1) {
  return { file: filePath, detail, weight };
}

function addDetection(map, id, label, category, evidence, action) {
  if (!map.has(id)) {
    map.set(id, {
      id,
      label,
      category,
      evidence: [],
      action,
      confidence: "Low",
      packageRoots: new Set(),
    });
  }

  const detection = map.get(id);
  detection.evidence.push(evidence);
  if (evidence.packageRoot) detection.packageRoots.add(evidence.packageRoot);
}

function confidenceFor(evidence) {
  const score = evidence.reduce((total, item) => total + item.weight, 0);
  if (score >= 4) return "High";
  if (score >= 2) return "Medium";
  return "Low";
}

function detectPackageDependencies(root, files, detections, failures, readSource) {
  const packageFiles = files.filter((filePath) => path.basename(filePath) === "package.json");

  for (const filePath of packageFiles) {
    const pkg = readJson(root, filePath, failures, readSource);
    if (!pkg) continue;

    const rel = relativePath(root, filePath);
    const packageRoot = relativePath(root, path.dirname(filePath));
    const deps = dependenciesFromPackageJson(pkg);
    const has = (name) => Object.prototype.hasOwnProperty.call(deps, name);

    const add = (id, label, category, detail, action, weight = 3) => {
      addDetection(
        detections,
        id,
        label,
        category,
        { ...createEvidence(rel, detail, weight), packageRoot },
        action,
      );
    };

    if (has("next")) {
      add("nextjs", "Next.js", "web-framework", "dependency next", "Continue with Next.js.");
    }
    if (has("react")) {
      add("react", "React", "web-framework", "dependency react", "Continue with React.");
    }
    if (has("vue")) {
      add("vue", "Vue", "web-framework", "dependency vue", "Continue with Vue.");
    }
    if (has("@sveltejs/kit")) {
      add(
        "sveltekit",
        "SvelteKit",
        "web-framework",
        "dependency @sveltejs/kit",
        "Continue with SvelteKit.",
      );
    } else if (has("svelte")) {
      add("svelte", "Svelte", "web-framework", "dependency svelte", "Continue with Svelte.");
    }
    if (has("astro")) {
      add("astro", "Astro", "web-framework", "dependency astro", "Continue with Astro.");
    }
    if (has("@angular/core")) {
      add(
        "angular",
        "Angular",
        "web-framework",
        "dependency @angular/core",
        "Continue with Angular.",
      );
    }
    if (has("vite")) {
      add("vite", "Vite", "web-tooling", "dependency vite", "Continue with Vite tooling.");
    }
    if (has("tailwindcss")) {
      add(
        "tailwindcss",
        "Tailwind CSS",
        "css-ui",
        "dependency tailwindcss",
        "Continue with Tailwind CSS.",
      );
    }
    if (has("bootstrap")) {
      add(
        "bootstrap",
        "Bootstrap",
        "css-ui",
        "dependency bootstrap",
        "Continue with Bootstrap conventions.",
      );
    }
    if (has("htmx.org")) {
      add("htmx", "htmx", "web-framework", "dependency htmx.org", "Continue with htmx.");
    }
    if (has("alpinejs")) {
      add("alpinejs", "Alpine.js", "web-framework", "dependency alpinejs", "Continue with Alpine.");
    }
    if (
      has("@radix-ui/react-slot") ||
      Object.keys(deps).some((name) => name.startsWith("@radix-ui/"))
    ) {
      add(
        "radix-ui",
        "Radix UI",
        "css-ui",
        "dependency @radix-ui/*",
        "Continue with Radix UI primitives.",
      );
    }
    if (has("vitest")) {
      add("vitest", "Vitest", "test-tooling", "dependency vitest", "Use Vitest for JS tests.");
    }
    if (has("@playwright/test")) {
      add(
        "playwright",
        "Playwright",
        "test-tooling",
        "dependency @playwright/test",
        "Use Playwright for browser checks.",
      );
    }
  }

  return packageFiles;
}

function detectConfigAndSources(root, files, packageFiles, detections, readSource) {
  for (const filePath of files) {
    const rel = relativePath(root, filePath);
    if (rel.startsWith("scripts/")) continue;
    const basename = path.basename(filePath).toLowerCase();
    const ext = path.extname(filePath);
    const packageRoot = packageRootFor(root, filePath, packageFiles);
    const text = readSource(filePath, { prefixOnly: true });
    const add = (id, label, category, detail, action, weight = 1) => {
      addDetection(
        detections,
        id,
        label,
        category,
        { ...createEvidence(rel, detail, weight), packageRoot },
        action,
      );
    };

    if (basename.startsWith("next.config.")) {
      add("nextjs", "Next.js", "web-framework", "Next.js config", "Continue with Next.js.", 3);
    }
    if (basename.startsWith("vite.config.")) {
      add("vite", "Vite", "web-tooling", "Vite config", "Continue with Vite tooling.", 3);
    }
    if (basename.startsWith("astro.config.")) {
      add("astro", "Astro", "web-framework", "Astro config", "Continue with Astro.", 3);
    }
    if (basename === "svelte.config.js") {
      add(
        "sveltekit",
        "SvelteKit",
        "web-framework",
        "Svelte config",
        "Continue with SvelteKit.",
        3,
      );
    }
    if (basename.startsWith("tailwind.config.")) {
      add(
        "tailwindcss",
        "Tailwind CSS",
        "css-ui",
        "Tailwind config",
        "Continue with Tailwind CSS.",
        3,
      );
    }
    if (basename.startsWith("postcss.config.")) {
      add("postcss", "PostCSS", "css-ui", "PostCSS config", "Continue with PostCSS.", 2);
    }

    if ([".jsx", ".tsx"].includes(ext) || /\bfrom\s+["']react["']/.test(text)) {
      add("react", "React", "web-framework", "React source", "Continue with React.");
    }
    if (ext === ".vue") {
      add("vue", "Vue", "web-framework", "Vue single-file component", "Continue with Vue.");
    }
    if (ext === ".svelte") {
      add("svelte", "Svelte", "web-framework", "Svelte component", "Continue with Svelte.");
    }
    if (ext === ".astro") {
      add("astro", "Astro", "web-framework", "Astro page/component", "Continue with Astro.");
    }
    if (ext === ".html") {
      add(
        "standards-web",
        "Standards-based web",
        "web-platform",
        "HTML document",
        "Continue with semantic HTML, CSS, and browser-native JavaScript conventions.",
        2,
      );
    }
    if (/\b@tailwind\b|\b@import\s+["']tailwindcss["']/.test(text)) {
      add(
        "tailwindcss",
        "Tailwind CSS",
        "css-ui",
        "Tailwind directives/imports",
        "Continue with Tailwind CSS.",
      );
    }
    if (/\bclass(Name)?=["'][^"']*\b(?:container|row|col-|btn btn-|navbar)\b/.test(text)) {
      add(
        "bootstrap",
        "Bootstrap",
        "css-ui",
        "Bootstrap class conventions",
        "Continue with Bootstrap conventions.",
      );
    }
    if (/\bhx-(?:get|post|put|patch|delete|target|swap)=/.test(text)) {
      add("htmx", "htmx", "web-framework", "htmx attributes", "Continue with htmx.");
    }
    if (/\bx-data=|\bx-on:|\b@(?:click|submit)=/.test(text)) {
      add("alpinejs", "Alpine.js", "web-framework", "Alpine attributes", "Continue with Alpine.");
    }
  }
}

function detectLanguages(root, files, detections) {
  const languageRules = [
    {
      id: "javascript-node",
      label: "JavaScript / Node.js",
      matches: (filePath) =>
        [".cjs", ".js", ".jsx", ".mjs"].includes(path.extname(filePath)) ||
        path.basename(filePath) === "package.json",
      action: "Use the declared Node.js module, package-manager, formatter, and test conventions.",
    },
    {
      id: "typescript",
      label: "TypeScript",
      matches: (filePath) => [".cts", ".mts", ".ts", ".tsx"].includes(path.extname(filePath)),
      action: "Use the existing TypeScript compiler, module, formatting, and test conventions.",
    },
    {
      id: "shell",
      label: "Shell",
      matches: (filePath) => path.extname(filePath) === ".sh",
      action: "Preserve shell argument boundaries and use the repository shell checks.",
    },
    {
      id: "python",
      label: "Python",
      matches: (filePath) =>
        [".py"].includes(path.extname(filePath)) ||
        ["pyproject.toml", "requirements.txt", "setup.py"].includes(
          path.basename(filePath).toLowerCase(),
        ),
      action: "Use existing Python tooling and formatting conventions.",
    },
    {
      id: "go",
      label: "Go",
      matches: (filePath) =>
        path.extname(filePath) === ".go" || path.basename(filePath) === "go.mod",
      action: "Use gofmt, go test, and existing package boundaries.",
    },
    {
      id: "rust",
      label: "Rust",
      matches: (filePath) =>
        path.extname(filePath) === ".rs" || path.basename(filePath).toLowerCase() === "cargo.toml",
      action: "Use cargo fmt, clippy, tests, and existing crate boundaries.",
    },
    {
      id: "ruby",
      label: "Ruby",
      matches: (filePath) =>
        path.extname(filePath) === ".rb" || path.basename(filePath).toLowerCase() === "gemfile",
      action: "Use existing Ruby style, tests, and dependency conventions.",
    },
    {
      id: "java",
      label: "Java",
      matches: (filePath) =>
        path.extname(filePath) === ".java" ||
        ["pom.xml", "build.gradle", "build.gradle.kts"].includes(
          path.basename(filePath).toLowerCase(),
        ),
      action: "Use existing Java build and package conventions.",
    },
    {
      id: "c-cpp",
      label: "C/C++",
      matches: (filePath) =>
        [".c", ".cc", ".cpp", ".h", ".hpp"].includes(path.extname(filePath)) ||
        ["cmakelists.txt", "makefile"].includes(path.basename(filePath).toLowerCase()),
      action: "Use existing C/C++ build, formatting, and ownership conventions.",
    },
  ];

  for (const rule of languageRules) {
    const matches = files.filter(rule.matches).slice(0, 4);
    for (const filePath of matches) {
      addDetection(
        detections,
        rule.id,
        rule.label,
        "language",
        createEvidence(relativePath(root, filePath), "language/build signal", 2),
        rule.action,
      );
    }
  }
}

export function detectStacks({
  root = defaultRoot,
  relativePaths,
  readSource = readText,
  productLayout,
} = {}) {
  const failures = [];
  const inventory = relativePaths ?? listActiveFiles({ root });
  const layout =
    productLayout ??
    discoverProductLayout({
      repositoryRoot: root,
      relativePaths: inventory,
      readText: (relativePathValue) => readSource(path.join(root, relativePathValue)),
    });
  const files = candidateFiles(root, inventory, layout);
  const detections = new Map();
  const packageFiles = detectPackageDependencies(root, files, detections, failures, readSource);
  detectConfigAndSources(root, files, packageFiles, detections, readSource);
  detectLanguages(root, files, detections);

  const stacks = [...detections.values()].map((detection) => ({
    ...detection,
    confidence: confidenceFor(detection.evidence),
    evidence: detection.evidence
      .sort((a, b) => b.weight - a.weight || a.file.localeCompare(b.file))
      .slice(0, 5),
    packageRoots: [...detection.packageRoots].sort((a, b) => a.localeCompare(b)),
  }));

  stacks.sort(
    (a, b) =>
      a.category.localeCompare(b.category) ||
      a.label.localeCompare(b.label) ||
      a.id.localeCompare(b.id),
  );

  return {
    root: ".",
    stacks,
    failures,
    hasWebSurface: stacks.some((stack) =>
      ["css-ui", "web-framework", "web-platform", "web-tooling"].includes(stack.category),
    ),
    primaryWebFrameworks: stacks.filter((stack) => primaryWebFrameworks.has(stack.id)),
  };
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}

export function formatStackReport(result, { webOnly = false } = {}) {
  const stacks = webOnly
    ? result.stacks.filter((stack) =>
        ["css-ui", "web-framework", "web-platform", "web-tooling"].includes(stack.category),
      )
    : result.stacks;

  if (stacks.length === 0) {
    return [
      "| Stack | Category | Confidence | Evidence | Agent action |",
      "|---|---|---:|---|---|",
      "| None detected | - | - | - | Choose a profile only after project scope and source evidence justify it. |",
    ].join("\n");
  }

  const rows = [
    "| Stack | Category | Confidence | Evidence | Agent action |",
    "|---|---|---:|---|---|",
  ];

  for (const stack of stacks) {
    const evidence = stack.evidence.map((item) => `${item.file}: ${item.detail}`).join("; ");
    rows.push(
      `| ${escapeCell(stack.label)} | ${escapeCell(stack.category)} | ${stack.confidence} | ${escapeCell(
        evidence,
      )} | ${escapeCell(stack.action)} |`,
    );
  }

  return rows.join("\n");
}

function parseArgs(argv) {
  return {
    json: argv.includes("--json"),
    webOnly: argv.includes("--web"),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = detectStacks({ root: defaultRoot });
  if (result.failures.length > 0) {
    console.error("Stack detection failed:");
    for (const failure of result.failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  if (args.json) {
    const output = {
      stacks: result.stacks.map((stack) => ({
        id: stack.id,
        label: stack.label,
        category: stack.category,
        confidence: stack.confidence,
        evidence: stack.evidence,
        packageRoots: stack.packageRoots,
        action: stack.action,
      })),
      hasWebSurface: result.hasWebSurface,
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log(formatStackReport(result, { webOnly: args.webOnly }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`Stack detection failed: ${error.message}`);
    process.exit(1);
  }
}
