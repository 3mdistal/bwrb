/**
 * Calculate the Levenshtein (edit) distance between two strings.
 *
 * The distance is the minimum number of single-character insertions,
 * deletions, or substitutions required to transform `a` into `b`.
 * Comparison is case-sensitive; callers that want case-insensitive
 * matching should lowercase their inputs first.
 *
 * Used for fuzzy matching to suggest corrections for typos.
 *
 * Implementation note: uses a two-row (rolling buffer) dynamic-programming
 * scheme instead of a full O(n·m) matrix, reducing memory to O(min(n, m)).
 * The inner dimension iterates over the shorter string so the row buffers
 * are no larger than `min(a.length, b.length) + 1`. Classic Levenshtein is
 * symmetric, so swapping the operands does not change the result. Character
 * comparison remains by UTF-16 code unit (`===` on single-character strings),
 * identical to the previous full-matrix implementation.
 */
export function levenshteinDistance(a: string, b: string): number {
  // Iterate the shorter string in the inner loop so the row buffers are
  // O(min(n, m)). Distance is symmetric, so swapping operands is safe.
  let shorter = a;
  let longer = b;
  if (a.length > b.length) {
    shorter = b;
    longer = a;
  }

  const shortLen = shorter.length;
  const longLen = longer.length;

  // Fast path: an empty operand means the distance is the other's length.
  if (shortLen === 0) {
    return longLen;
  }

  // `prevRow` holds distances for the previous outer-loop position; `currRow`
  // is filled for the current one. Both are sized to the shorter string.
  let prevRow = new Array<number>(shortLen + 1);
  let currRow = new Array<number>(shortLen + 1);

  // First row: transforming the empty prefix of `longer` into each prefix of
  // `shorter` costs one insertion per character.
  for (let j = 0; j <= shortLen; j++) {
    prevRow[j] = j;
  }

  for (let i = 1; i <= longLen; i++) {
    // First column: transforming each prefix of `longer` into the empty prefix
    // of `shorter` costs one deletion per character.
    currRow[0] = i;

    const longChar = longer[i - 1];
    for (let j = 1; j <= shortLen; j++) {
      if (longChar === shorter[j - 1]) {
        currRow[j] = prevRow[j - 1]!;
      } else {
        currRow[j] = Math.min(
          prevRow[j - 1]! + 1, // substitution
          currRow[j - 1]! + 1, // insertion
          prevRow[j]! + 1 // deletion
        );
      }
    }

    // Swap the buffers: the row we just filled becomes the previous row.
    const tmp = prevRow;
    prevRow = currRow;
    currRow = tmp;
  }

  return prevRow[shortLen]!;
}
