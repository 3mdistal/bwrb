/**
 * Calculate the Levenshtein (edit) distance between two strings.
 *
 * The distance is the minimum number of single-character insertions,
 * deletions, or substitutions required to transform `a` into `b`.
 * Comparison is case-sensitive; callers that want case-insensitive
 * matching should lowercase their inputs first.
 *
 * Used for fuzzy matching to suggest corrections for typos.
 */
export function levenshteinDistance(a: string, b: string): number {
  const aLen = a.length;
  const bLen = b.length;

  // Create a 2D matrix with proper initialization
  const matrix: number[][] = Array.from({ length: aLen + 1 }, () =>
    Array.from({ length: bLen + 1 }, () => 0)
  );

  // Initialize first column
  for (let i = 0; i <= aLen; i++) {
    matrix[i]![0] = i;
  }

  // Initialize first row
  for (let j = 0; j <= bLen; j++) {
    matrix[0]![j] = j;
  }

  // Fill in the rest of the matrix
  for (let i = 1; i <= aLen; i++) {
    for (let j = 1; j <= bLen; j++) {
      if (a[i - 1] === b[j - 1]) {
        matrix[i]![j] = matrix[i - 1]![j - 1]!;
      } else {
        matrix[i]![j] = Math.min(
          matrix[i - 1]![j - 1]! + 1, // substitution
          matrix[i]![j - 1]! + 1, // insertion
          matrix[i - 1]![j]! + 1 // deletion
        );
      }
    }
  }

  return matrix[aLen]![bLen]!;
}
