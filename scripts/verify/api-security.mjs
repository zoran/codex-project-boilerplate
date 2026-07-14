import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  discoverProductLayout,
  isProductImplementationPath,
} from "../repository/product-roots.mjs";
import { listActiveFiles, repositoryRoot } from "../repository/source-inventory.mjs";

const sourceExtensions = new Set([
  ".cjs",
  ".cs",
  ".cts",
  ".go",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".mjs",
  ".mts",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".ts",
  ".tsx",
]);

const apiPathPattern = /(?:^|\/)(?:api|apis|controllers?|endpoints?|handlers?|routes?)(?:\/|$)/i;
const apiContentPatterns = [
  /\b(?:app|router|server)\.(?:get|post|put|patch|delete|options|head)\s*\(/,
  /\b(?:fastify|hono)\.(?:get|post|put|patch|delete|route)\s*\(/,
  /\bexport\s+async\s+function\s+(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*\(/,
  /@\w*route\s*\(|@(?:app|router)\.(?:get|post|put|patch|delete)\s*\(/,
  /@(?:RestController|Controller|RequestMapping|GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping)\b/,
  /\b(?:http\.HandleFunc|HandleFunc|ServeHTTP)\b/,
  /\bRouter::new\(\)|\.route\s*\(/,
  /\b(?:get|post|put|patch|delete)\s+["'][^"']+["']\s+do\b/,
];

const securityEvidencePattern =
  /\b(?:auth|authenticated|authentication|authorization|authorize|authorized|bearer|credential|guard|jwt|oauth|permission|policy|requireAuth|requireUser|session|token)\b/i;
const absentSecurityPattern =
  /\b(?:(?:no|without|missing|lacks?)\s+(?:auth|authentication|authorization)|(?:auth|authentication|authorization)\s+(?:is\s+)?(?:absent|disabled|omitted|bypassed|not\s+required|intentionally\s+absent)|unauthenticated)\b/i;
const internalBoundaryPattern =
  /\b(?:internal api|internal-api|service-to-service|private api|private-api|not internet-facing|network boundary|trusted network)\b/i;
const publicApiPattern =
  /\b(?:public api|public-api|external api|external-api|internet-facing|anonymous|unauthenticated|guest access|no auth|noauth)\b/i;
const rateLimitPattern =
  /\b(?:429|rate limit|rate-limit|rateLimit|ratelimit|throttle|throttling|quota|Retry-After|too many requests)\b/i;

function isProductSource(relativePath, productLayout) {
  const basename = path.posix.basename(relativePath);
  return (
    sourceExtensions.has(path.posix.extname(relativePath).toLowerCase()) &&
    isProductImplementationPath(relativePath, productLayout) &&
    !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(basename)
  );
}

export function isApiSource(file) {
  if (apiPathPattern.test(file.relativePath)) return true;
  return apiContentPatterns.some((pattern) => pattern.test(file.content));
}

export function apiSecurityFindings(file) {
  const findings = [];
  const explicitlyAbsent = absentSecurityPattern.test(file.content);
  const hasSecurityBoundary =
    !explicitlyAbsent &&
    (securityEvidencePattern.test(file.content) || internalBoundaryPattern.test(file.content));
  if (explicitlyAbsent) {
    findings.push(
      `${file.relativePath}: explicitly absent, disabled, or bypassed authentication/authorization requires security review; the static boundary heuristic cannot accept positive keywords elsewhere`,
    );
  }
  if (!hasSecurityBoundary) {
    findings.push(
      `${file.relativePath}: API handlers need authentication/authorization evidence or a documented internal boundary`,
    );
  }

  if (publicApiPattern.test(file.content) && !rateLimitPattern.test(file.content)) {
    findings.push(
      `${file.relativePath}: public API handlers need rate-limit evidence such as throttling, quota, 429, or Retry-After handling`,
    );
  }
  return findings;
}

export function readApiFiles({ root = repositoryRoot, files, productLayout } = {}) {
  const inventory = files ?? listActiveFiles({ root });
  const layout =
    productLayout ?? discoverProductLayout({ repositoryRoot: root, relativePaths: inventory });
  return inventory
    .filter((relativePath) => isProductSource(relativePath, layout))
    .map((relativePath) => ({
      fullPath: path.join(root, relativePath),
      relativePath,
      content: readFileSync(path.join(root, relativePath), "utf8"),
    }))
    .filter(isApiSource);
}

function main() {
  const apiFiles = readApiFiles();
  const failures = apiFiles.flatMap(apiSecurityFindings);

  if (failures.length > 0) {
    console.error("API static boundary heuristic failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  if (apiFiles.length === 0) {
    console.log("API static boundary heuristic skipped; no API-like source files detected.");
  } else {
    console.log(`API static boundary heuristic passed (${apiFiles.length} API-like file(s)).`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
