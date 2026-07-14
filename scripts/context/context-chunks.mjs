import { hashContent } from "./context-hashing.mjs";
import { maxEmbeddingTokens } from "./context-embedding.mjs";

function truncate(value, maximum) {
  const normalized = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 3)}...`;
}

function symbolFromLine(line) {
  const patterns = [
    /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const)\s+([A-Za-z_$][\w$]*)/,
    /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/,
    /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|type)\s+([A-Za-z_][\w]*)/,
    /^\s*(?:pub\s+)?(?:func|type)\s+([A-Za-z_][\w]*)/,
    /^\s*(?:public|protected|private)?\s*(?:static\s+)?(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/,
  ];
  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function importFromLine(line) {
  const patterns = [
    /^\s*import\s+(?:.+?\s+from\s+)?["']([^"']+)["']/,
    /^\s*const\s+.+?=\s+require\(["']([^"']+)["']\)/,
    /^\s*from\s+([A-Za-z0-9_.]+)\s+import\s+/,
    /^\s*import\s+([A-Za-z0-9_.]+)\s*$/,
    /^\s*use\s+([^;]+);/,
  ];
  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (match) return truncate(match[1], 160);
  }
  return null;
}

export function extractMetadata(content) {
  const headings = [];
  const symbols = [];
  const imports = [];
  const lines = content.split(/\r?\n/);

  lines.forEach((line, index) => {
    const markdownHeading = line.match(/^(#{1,6})\s+(.+)$/);
    const htmlHeading = line.match(/^\s*<h[1-6][^>]*>([^<]+)<\/h[1-6]>\s*$/i);
    const heading = markdownHeading?.[2] ?? htmlHeading?.[1];
    if (heading) headings.push({ line: index + 1, text: truncate(heading, 160) });

    const symbol = symbolFromLine(line);
    if (symbol) symbols.push({ line: index + 1, name: truncate(symbol, 100) });

    const importPath = importFromLine(line);
    if (importPath) imports.push(importPath);
  });

  return {
    headings,
    symbols,
    imports: [...new Set(imports)].slice(0, 16),
  };
}

function incrementLookupStat(stats, key, amount = 1) {
  if (stats) stats[key] = Number(stats[key] ?? 0) + amount;
}

function firstAtOrAfter(entries, line, stats) {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    incrementLookupStat(stats, "binarySearchProbes");
    const middle = Math.floor((low + high) / 2);
    if (entries[middle].line < line) low = middle + 1;
    else high = middle;
  }
  return low;
}

function firstAfter(entries, line, stats) {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    incrementLookupStat(stats, "binarySearchProbes");
    const middle = Math.floor((low + high) / 2);
    if (entries[middle].line <= line) low = middle + 1;
    else high = middle;
  }
  return low;
}

function indexedMetadata(metadata, lookupStats) {
  const byLine = (left, right) => left.line - right.line;
  const ordered = (entries) => {
    for (let index = 1; index < entries.length; index += 1) {
      if (entries[index - 1].line > entries[index].line) return [...entries].sort(byLine);
    }
    return entries;
  };
  return {
    headings: ordered(metadata.headings),
    symbols: ordered(metadata.symbols),
    imports: metadata.imports,
    lookupStats,
  };
}

function nearestHeadings(metadata, startLine) {
  incrementLookupStat(metadata.lookupStats, "headingLookups");
  const end = firstAfter(metadata.headings, startLine, metadata.lookupStats);
  return metadata.headings.slice(Math.max(0, end - 2), end).map((heading) => heading.text);
}

function nearbySymbols(metadata, startLine, endLine) {
  incrementLookupStat(metadata.lookupStats, "symbolLookups");
  const names = [];
  const start = firstAtOrAfter(metadata.symbols, startLine - 12, metadata.lookupStats);
  for (let index = start; index < metadata.symbols.length && names.length < 6; index += 1) {
    const symbol = metadata.symbols[index];
    incrementLookupStat(metadata.lookupStats, "symbolRowsVisited");
    if (symbol.line > endLine) break;
    names.push(symbol.name);
  }
  return names;
}

function metadataParts(filePath, startLine, endLine, metadata) {
  incrementLookupStat(metadata.lookupStats, "candidateLookups");
  return {
    path: truncate(filePath, 240),
    headings: nearestHeadings(metadata, startLine),
    symbols: nearbySymbols(metadata, startLine, endLine),
    imports: metadata.imports.slice(0, 4),
  };
}

function renderMetadata(parts) {
  return [
    `path: ${parts.path}`,
    ...parts.headings.map((heading) => `heading: ${heading}`),
    ...parts.symbols.map((symbol) => `symbol: ${symbol}`),
    ...parts.imports.map((importPath) => `import: ${importPath}`),
  ].join("\n");
}

function compactMetadataPrefix(filePath, originalParts, countTokens, tokenLimit) {
  const compacted = {
    ...originalParts,
    headings: [...originalParts.headings],
    symbols: [...originalParts.symbols],
    imports: [...originalParts.imports],
  };
  let prefix = renderMetadata(compacted);
  while (countTokens(`${prefix}\n\nx`) >= tokenLimit) {
    if (compacted.imports.length > 0) compacted.imports.pop();
    else if (compacted.symbols.length > 0) compacted.symbols.pop();
    else if (compacted.headings.length > 0) compacted.headings.shift();
    else if (compacted.path.length > 32)
      compacted.path = truncate(compacted.path, compacted.path.length - 16);
    else
      throw new Error(`Context metadata for ${filePath} exceeds the ${tokenLimit}-token budget.`);
    prefix = renderMetadata(compacted);
  }
  return prefix;
}

function createCandidate(filePath, startLine, endLine, text, metadata, countTokens, tokenLimit) {
  const normalizedText = text.trim();
  const parts = metadataParts(filePath, startLine, endLine, metadata);
  const prefix = compactMetadataPrefix(filePath, parts, countTokens, tokenLimit);
  const embeddingText = `${prefix}\n\n${normalizedText}`;
  const tokenCount = countTokens(embeddingText);
  return {
    startLine,
    endLine,
    text: normalizedText,
    headings: parts.headings,
    symbols: parts.symbols,
    imports: metadata.imports,
    embeddingText,
    tokenCount,
  };
}

function logicalBlocks(content) {
  const lines = content.split(/\r?\n/);
  const blocks = [];
  let current = null;

  function flush() {
    if (current && current.lines.some((line) => line.trim())) {
      blocks.push({
        startLine: current.startLine,
        endLine: current.startLine + current.lines.length - 1,
        text: current.lines.join("\n").trim(),
      });
    }
    current = null;
  }

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const startsLogicalUnit =
      /^(?:#{1,6}\s+|\s*<(?:h[1-6]|section|article)\b)/i.test(line) ||
      Boolean(symbolFromLine(line));
    if (!line.trim()) {
      flush();
      return;
    }
    if (startsLogicalUnit && current) flush();
    current ??= { startLine: lineNumber, lines: [] };
    current.lines.push(line);
  });
  flush();
  return blocks;
}

function largestFittingPrefix(
  characters,
  offset,
  createForText,
  tokenLimit,
  { hint = 0, allowGrowth = false } = {},
) {
  const remainingLength = characters.length - offset;
  if (hint > 0) {
    const hintedLength = Math.min(remainingLength, hint);
    const hintedCandidate = createForText(characters.slice(offset, offset + hintedLength).join(""));
    if (hintedCandidate.tokenCount <= tokenLimit) {
      if (hintedLength === remainingLength || !allowGrowth) return hintedLength;
      let low = hintedLength + 1;
      let high = Math.min(remainingLength, hintedLength * 2);
      let best = hintedLength;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const candidate = createForText(characters.slice(offset, offset + middle).join(""));
        if (candidate.tokenCount <= tokenLimit) {
          best = middle;
          low = middle + 1;
        } else high = middle - 1;
      }
      return best;
    }
    let low = 1;
    let high = hintedLength - 1;
    let best = 0;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = createForText(characters.slice(offset, offset + middle).join(""));
      if (candidate.tokenCount <= tokenLimit) {
        best = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    return best;
  }
  let high = Math.min(remainingLength, Math.max(1, tokenLimit));
  let low = 1;
  let best = 0;
  while (high < remainingLength) {
    const candidate = createForText(characters.slice(offset, offset + high).join(""));
    if (candidate.tokenCount > tokenLimit) break;
    best = high;
    low = high + 1;
    high = Math.min(remainingLength, high * 2);
  }
  if (high === remainingLength) {
    const candidate = createForText(characters.slice(offset).join(""));
    if (candidate.tokenCount <= tokenLimit) return remainingLength;
  }
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = createForText(characters.slice(offset, offset + middle).join(""));
    if (candidate.tokenCount <= tokenLimit) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function splitOversizedLine(filePath, lineNumber, line, metadata, countTokens, tokenLimit) {
  const pieces = [];
  const characters = [...line];
  let offset = 0;
  let fittingHint = 0;
  while (offset < characters.length) {
    const createForText = (text) =>
      createCandidate(filePath, lineNumber, lineNumber, text, metadata, countTokens, tokenLimit);
    const fittingLength = largestFittingPrefix(characters, offset, createForText, tokenLimit, {
      hint: fittingHint,
      allowGrowth: pieces.length > 0 && pieces.length % 16 === 0,
    });
    if (fittingLength === 0) {
      throw new Error(`A source token in ${filePath}:${lineNumber} exceeds the token budget.`);
    }
    const text = characters.slice(offset, offset + fittingLength).join("");
    pieces.push({ startLine: lineNumber, endLine: lineNumber, text });
    fittingHint = fittingLength;
    offset += fittingLength;
  }
  return pieces;
}

function splitBlock(filePath, block, metadata, countTokens, tokenLimit) {
  const initial = createCandidate(
    filePath,
    block.startLine,
    block.endLine,
    block.text,
    metadata,
    countTokens,
    tokenLimit,
  );
  if (initial.tokenCount <= tokenLimit) return [block];

  const lines = block.text.split("\n");
  if (lines.length === 1) {
    return splitOversizedLine(
      filePath,
      block.startLine,
      lines[0],
      metadata,
      countTokens,
      tokenLimit,
    );
  }
  const pieces = [];
  let pending = null;

  function flush() {
    if (pending) pieces.push(pending);
    pending = null;
  }

  lines.forEach((line, offset) => {
    const lineNumber = block.startLine + offset;
    const next = pending
      ? {
          startLine: pending.startLine,
          endLine: lineNumber,
          text: `${pending.text}\n${line}`,
        }
      : { startLine: lineNumber, endLine: lineNumber, text: line };
    const candidate = createCandidate(
      filePath,
      next.startLine,
      next.endLine,
      next.text,
      metadata,
      countTokens,
      tokenLimit,
    );
    if (candidate.tokenCount <= tokenLimit) {
      pending = next;
      return;
    }

    flush();
    const lineCandidate = createCandidate(
      filePath,
      lineNumber,
      lineNumber,
      line,
      metadata,
      countTokens,
      tokenLimit,
    );
    if (lineCandidate.tokenCount <= tokenLimit)
      pending = { startLine: lineNumber, endLine: lineNumber, text: line };
    else
      pieces.push(
        ...splitOversizedLine(filePath, lineNumber, line, metadata, countTokens, tokenLimit),
      );
  });
  flush();
  return pieces;
}

export function chunkContent(
  filePath,
  content,
  metadata,
  countTokens,
  { tokenLimit = maxEmbeddingTokens, lookupStats } = {},
) {
  const metadataIndex = indexedMetadata(metadata, lookupStats);
  const splitBlocks = logicalBlocks(content).flatMap((block) =>
    splitBlock(filePath, block, metadataIndex, countTokens, tokenLimit),
  );
  const packed = [];
  let pending = null;

  function flush() {
    if (pending) packed.push(pending);
    pending = null;
  }

  for (const block of splitBlocks) {
    const combined = pending
      ? {
          startLine: pending.startLine,
          endLine: block.endLine,
          text: `${pending.text}\n\n${block.text}`,
        }
      : block;
    const candidate = createCandidate(
      filePath,
      combined.startLine,
      combined.endLine,
      combined.text,
      metadataIndex,
      countTokens,
      tokenLimit,
    );
    if (candidate.tokenCount <= tokenLimit) {
      pending = combined;
      continue;
    }
    flush();
    pending = block;
  }
  flush();

  return packed.map((block) => {
    const chunk = createCandidate(
      filePath,
      block.startLine,
      block.endLine,
      block.text,
      metadataIndex,
      countTokens,
      tokenLimit,
    );
    if (chunk.tokenCount > tokenLimit) {
      throw new Error(
        `Context chunk ${filePath}:${chunk.startLine}-${chunk.endLine} has ${chunk.tokenCount} tokens; limit is ${tokenLimit}.`,
      );
    }
    const contentHash = hashContent(chunk.text);
    return {
      ...chunk,
      id: `${filePath}:${chunk.startLine}-${chunk.endLine}:${contentHash.slice(0, 16)}`,
      path: filePath,
      contentHash,
    };
  });
}
