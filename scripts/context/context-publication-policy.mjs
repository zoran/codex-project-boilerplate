export const databaseReplacementOperationThreshold = 20;
export const databaseReplacementAffectedRowThreshold = 100_000;

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

export function databaseGenerationReplacementRequired(
  manifest,
  { additionalOperations = 0, additionalAffectedRows = 0 } = {},
) {
  const operations =
    nonNegativeInteger(manifest?.stats?.databaseModificationOperations) +
    nonNegativeInteger(additionalOperations);
  const affectedRows =
    nonNegativeInteger(manifest?.stats?.databaseModificationAffectedRows) +
    nonNegativeInteger(additionalAffectedRows);
  return (
    operations >= databaseReplacementOperationThreshold ||
    affectedRows >= databaseReplacementAffectedRowThreshold
  );
}
