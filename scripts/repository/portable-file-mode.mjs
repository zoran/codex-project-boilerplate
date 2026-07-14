import { closeSync, openSync, readSync } from "node:fs";

export function portableFileMode(filePath) {
  const descriptor = openSync(filePath, "r");
  const prefix = Buffer.alloc(2);
  try {
    const bytesRead = readSync(descriptor, prefix, 0, prefix.length, 0);
    return bytesRead === 2 && prefix[0] === 0x23 && prefix[1] === 0x21 ? 0o755 : 0o644;
  } finally {
    closeSync(descriptor);
  }
}
