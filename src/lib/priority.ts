export const PRIORITY_ALGORITHM = 'thin-hybrid-v1';
const SUBJECTIVE_REVIEW_DAYS = 30;

export interface PriorityInput {
  id: string;
  importance: number | null;
  excitement: number | null;
  deadline?: string | null;
  deadlineKind?: string | null;
  priorRank?: number | null;
  effectiveRank?: number | null;
  override?: boolean;
  reason?: string | null;
  algorithm?: string | null;
  asOf?: string | null;
  basisRevision?: string | null;
  reviewed?: string | null;
  approvalId?: string | null;
  revision: string;
}

export interface PrioritySuggestion extends PriorityInput {
  score: number;
  deadlinePressure: number;
  suggestedRank: number;
  staleReasons: string[];
  unknown: string[];
  neutralBaseline: Record<string, number>;
}

export function deadlinePressure(
  deadline: string | null | undefined,
  kind: string | null | undefined,
  asOf: string
): number {
  if (!deadline) return 0;
  const days = Math.floor((Date.parse(`${deadline}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 86_400_000);
  if (!Number.isFinite(days)) return 0;
  // Missing deadline-kind is not evidence of an external commitment.
  const hard = kind === 'hard';
  if (days <= 0) return hard ? 4 : 3;
  if (days <= 3) return hard ? 3 : 2;
  if (days <= 7) return hard ? 2 : 1;
  return hard && days <= 30 ? 1 : 0;
}

export function suggestPriorities(inputs: PriorityInput[], asOf: string): PrioritySuggestion[] {
  const suggestions = inputs.map((input) => {
    const pressure = deadlinePressure(input.deadline, input.deadlineKind, asOf);
    const unknown = [input.importance === null ? 'importance' : null, input.excitement === null ? 'excitement' : null]
      .filter((value): value is string => value !== null);
    const neutralBaseline = Object.fromEntries(unknown.map((field) => [field, 2]));
    const score = (input.importance ?? 2) * 4 + pressure * 3 + (input.excitement ?? 2);
    const reviewedAge = input.reviewed
      ? Math.floor((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${input.reviewed}T00:00:00Z`)) / 86_400_000)
      : Number.POSITIVE_INFINITY;
    const staleReasons = [
      input.algorithm !== PRIORITY_ALGORITHM ? 'algorithm' : null,
      input.asOf !== asOf ? 'as-of' : null,
      input.basisRevision !== input.revision ? 'evidence' : null,
      !Number.isFinite(reviewedAge) || reviewedAge < 0 || reviewedAge > SUBJECTIVE_REVIEW_DAYS ? 'review' : null,
    ].filter((value): value is string => value !== null);
    return { ...input, score, deadlinePressure: pressure, suggestedRank: 0, staleReasons, unknown, neutralBaseline };
  });
  suggestions.sort((a, b) => b.score - a.score || (a.priorRank ?? Number.MAX_SAFE_INTEGER) - (b.priorRank ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id));
  suggestions.forEach((suggestion, index) => { suggestion.suggestedRank = index + 1; });
  return suggestions;
}
