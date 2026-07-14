const lexicalStopWords = new Set([
  "and",
  "are",
  "const",
  "default",
  "from",
  "function",
  "import",
  "let",
  "must",
  "not",
  "return",
  "that",
  "the",
  "this",
  "with",
]);

function compareText(left, right) {
  const leftText = String(left);
  const rightText = String(right);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

export function normalizeSearchText(value) {
  return String(value ?? "")
    .replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, "$1 $2")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}_$]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(value) {
  return normalizeSearchText(value)
    .split(" ")
    .filter((token) => token.length > 1 && !lexicalStopWords.has(token));
}

function termCounts(value) {
  const counts = new Map();
  for (const token of tokenize(value)) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

export function lexicalScore(result, query) {
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0) return { score: 0, exactPhrase: false, coverage: 0 };

  const pathTerms = new Set(tokenize(result.path));
  const symbolTerms = new Set(tokenize(result.symbolsText ?? ""));
  const headingTerms = new Set(tokenize(result.headingsText ?? ""));
  const textCounts = termCounts(result.text ?? "");
  let score = 0;
  let matchedTerms = 0;

  for (const term of queryTerms) {
    let matched = false;
    if (pathTerms.has(term)) {
      score += 2.2;
      matched = true;
    }
    if (symbolTerms.has(term)) {
      score += 1.8;
      matched = true;
    }
    if (headingTerms.has(term)) {
      score += 1.2;
      matched = true;
    }
    const hits = textCounts.get(term) ?? 0;
    if (hits > 0) {
      score += Math.min(1.4, 0.35 + Math.log1p(hits));
      matched = true;
    }
    if (matched) matchedTerms += 1;
  }

  const normalizedQuery = normalizeSearchText(query);
  const searchable = normalizeSearchText(
    `${result.path ?? ""} ${result.headingsText ?? ""} ${result.symbolsText ?? ""} ${result.text ?? ""}`,
  );
  const exactPhrase = normalizedQuery.length > 2 && searchable.includes(normalizedQuery);
  const coverage = matchedTerms / queryTerms.length;
  score = score / queryTerms.length + coverage * 1.5 + (exactPhrase ? 5 : 0);
  return { score, exactPhrase, coverage };
}

function withoutVector(record) {
  const { vector: _vector, ...rest } = record;
  return rest;
}

function overlapRatio(left, right) {
  if (left.path !== right.path) return 0;
  const start = Math.max(left.startLine, right.startLine);
  const end = Math.min(left.endLine, right.endLine);
  if (end < start) return 0;
  const overlap = end - start + 1;
  const shorter = Math.min(left.endLine - left.startLine + 1, right.endLine - right.startLine + 1);
  return shorter > 0 ? overlap / shorter : 0;
}

export function rankHybridResults({ denseResults, allRows, query, limit = 5 }) {
  const orderedDense = [...denseResults].sort(
    (left, right) =>
      (left._distance ?? Number.POSITIVE_INFINITY) -
        (right._distance ?? Number.POSITIVE_INFINITY) || compareText(left.id, right.id),
  );
  const denseRank = new Map(orderedDense.map((result, index) => [result.id, index + 1]));
  const denseById = new Map(orderedDense.map((result) => [result.id, result]));
  const lexical = allRows
    .map((row) => ({ row, lexical: lexicalScore(row, query) }))
    .filter((entry) => entry.lexical.score > 0)
    .sort(
      (left, right) =>
        right.lexical.score - left.lexical.score || compareText(left.row.id, right.row.id),
    );
  const lexicalRank = new Map(lexical.map((entry, index) => [entry.row.id, index + 1]));
  const lexicalById = new Map(lexical.map((entry) => [entry.row.id, entry]));
  const lexicalCandidateCount = Math.max(limit * 6, 50);
  const candidateIds = new Set([
    ...orderedDense.map((result) => result.id),
    ...lexical.slice(0, lexicalCandidateCount).map((entry) => entry.row.id),
  ]);
  const allRowsById = new Map(allRows.map((row) => [row.id, row]));

  const candidates = [...candidateIds]
    .map((id) => {
      const dense = denseById.get(id);
      const row = allRowsById.get(id) ?? dense;
      const lexicalEntry = lexicalById.get(id);
      if (!row) return null;
      const vectorRank = denseRank.get(id);
      const textRank = lexicalRank.get(id);
      const reciprocalVector = vectorRank ? 1 / (40 + vectorRank) : 0;
      const reciprocalLexical = textRank ? 1 / (40 + textRank) : 0;
      const exactBoost = lexicalEntry?.lexical.exactPhrase ? 0.05 : 0;
      return {
        ...withoutVector(row),
        _distance: dense?._distance ?? null,
        _vectorRank: vectorRank ?? null,
        _lexicalRank: textRank ?? null,
        _lexicalScore: lexicalEntry?.lexical.score ?? 0,
        _exactPhrase: lexicalEntry?.lexical.exactPhrase ?? false,
        _hybridScore: reciprocalVector + reciprocalLexical * 1.15 + exactBoost,
      };
    })
    .filter(Boolean)
    .sort(
      (left, right) =>
        right._hybridScore - left._hybridScore ||
        (left._distance ?? Number.POSITIVE_INFINITY) -
          (right._distance ?? Number.POSITIVE_INFINITY) ||
        compareText(left.id, right.id),
    );

  const selected = [];
  const deferred = [];
  const perPath = new Map();
  for (const candidate of candidates) {
    const pathCount = perPath.get(candidate.path) ?? 0;
    const overlaps = selected.some((prior) => overlapRatio(prior, candidate) > 0.6);
    if (pathCount >= 2 || overlaps) {
      deferred.push(candidate);
      continue;
    }
    selected.push(candidate);
    perPath.set(candidate.path, pathCount + 1);
    if (selected.length === limit) return selected;
  }

  for (const candidate of deferred) {
    if (!selected.some((result) => result.id === candidate.id)) selected.push(candidate);
    if (selected.length === limit) break;
  }
  return selected;
}
