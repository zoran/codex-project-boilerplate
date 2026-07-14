import { secretPatterns } from "./secret-patterns.mjs";

// All repository secret signatures are ASCII. Keeping a bounded byte overlap catches a signature
// split across stream chunks without buffering an arbitrarily large Git blob in memory.
const overlapBytes = Math.max(
  256,
  ...secretPatterns.map(({ label }) => Buffer.byteLength(label, "ascii") * 4),
);

export function createSecretContentScanner() {
  const patterns = secretPatterns.map(({ label, regex }) => ({
    label,
    regex: new RegExp(regex.source, regex.flags.replace(/[gy]/g, "")),
  }));
  const labels = new Set();
  let tail = "";

  return {
    write(chunk) {
      if (!chunk || chunk.length === 0 || labels.size === secretPatterns.length) return;
      const text = tail + Buffer.from(chunk).toString("latin1");
      for (const pattern of patterns) {
        if (!labels.has(pattern.label) && pattern.regex.test(text)) labels.add(pattern.label);
      }
      tail = text.slice(-overlapBytes);
    },
    findings() {
      return [...labels].sort((left, right) => left.localeCompare(right));
    },
  };
}

export function findSecretLabelsInBuffer(buffer) {
  const scanner = createSecretContentScanner();
  scanner.write(buffer);
  return scanner.findings();
}
