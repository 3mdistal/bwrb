import { getFieldsForType, resolveTypeFromFrontmatter } from '../schema.js';
import { levenshteinDistance } from '../discovery.js';
import type { LoadedSchema, Field } from '../../types/schema.js';

export type ValueShape = 'empty' | 'string' | 'number' | 'boolean' | 'array' | 'object' | 'unknown';

export type SimilarFieldCandidate = {
  field: string;
  distance: number;
  typeMismatch: boolean;
  priority: number;
};

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string' && value.trim().length === 0) return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.keys(value as Record<string, unknown>).length === 0;
  }
  return false;
}

export function getValueShape(value: unknown): ValueShape {
  if (value === null || value === undefined) return 'empty';
  if (Array.isArray(value)) return 'array';
  const type = typeof value;
  if (type === 'string') return 'string';
  if (type === 'number') return 'number';
  if (type === 'boolean') return 'boolean';
  if (type === 'object') return 'object';
  return 'unknown';
}

export function getExpectedFieldShape(field: Field | undefined): ValueShape {
  if (!field || !field.prompt) return 'unknown';

  switch (field.prompt) {
    case 'list':
      return 'array';
    case 'boolean':
      return 'boolean';
    case 'number':
      return 'number';
    default:
      // text/select/relation/date all ultimately serialize as strings in frontmatter
      return 'string';
  }
}

function isFieldShapeCompatible(value: unknown, field: Field | undefined): boolean {
  const actual = getValueShape(value);
  if (actual === 'empty') return true;

  const expected = getExpectedFieldShape(field);
  if (expected === 'unknown') return true;

  return actual === expected;
}

function normalizeKeyTokens(key: string): string[] {
  return key
    .toLowerCase()
    .split(/[\s\-_]+/)
    .map(t => t.trim())
    .filter(Boolean);
}

function normalizeKeyForComparison(key: string): string {
  return normalizeKeyTokens(key).join('');
}

function isSingularPluralVariantNormalized(a: string, b: string): boolean {
  if (!a || !b || a === b) return false;
  return a === b + 's' || b === a + 's';
}

export function getSimilarFieldCandidates(
  unknownField: string,
  schemaFields: Record<string, Field>,
  unknownValue: unknown,
  maxResults = 3
): SimilarFieldCandidate[] {
  const unknownNorm = normalizeKeyForComparison(unknownField);
  if (!unknownNorm) return [];

  const candidates: SimilarFieldCandidate[] = [];

  for (const fieldName of Object.keys(schemaFields)) {
    if (fieldName === 'type' || fieldName.endsWith('-type')) continue;

    const candidateNorm = normalizeKeyForComparison(fieldName);
    if (!candidateNorm) continue;

    const dist = levenshteinDistance(unknownNorm, candidateNorm);
    const minLen = Math.min(unknownNorm.length, candidateNorm.length);
    const maxAllowedDist = Math.max(1, Math.floor(minLen * 0.2));

    if (dist > maxAllowedDist) continue;

    const isExactMatch = candidateNorm === unknownNorm;
    const isSingularPlural = isSingularPluralVariantNormalized(unknownNorm, candidateNorm);
    const priority = isExactMatch ? 0 : isSingularPlural ? 1 : 2;
    const field = schemaFields[fieldName];
    const typeMismatch = !isFieldShapeCompatible(unknownValue, field);

    candidates.push({ field: fieldName, distance: dist, typeMismatch, priority });
  }

  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.typeMismatch !== b.typeMismatch) return a.typeMismatch ? 1 : -1;
    if (a.distance !== b.distance) return a.distance - b.distance;
    return a.field.localeCompare(b.field, 'en');
  });

  return candidates.slice(0, maxResults);
}

export function getAutoUnknownFieldMigrationTarget(
  schema: LoadedSchema,
  frontmatter: Record<string, unknown>,
  unknownField: string,
  unknownValue: unknown
): string | null {
  const typePath = resolveTypeFromFrontmatter(schema, frontmatter);
  if (!typePath) return null;

  const schemaFields = getFieldsForType(schema, typePath);
  const unknownNorm = normalizeKeyForComparison(unknownField);
  if (!unknownNorm) return null;

  const normalizedExactMatches = Object.keys(schemaFields).filter(
    fieldName => normalizeKeyForComparison(fieldName) === unknownNorm
  );

  let targetField: string | undefined;

  if (normalizedExactMatches.length === 1) {
    targetField = normalizedExactMatches[0];
  } else {
    const singularPluralMatches = Object.keys(schemaFields).filter(fieldName =>
      isSingularPluralVariantNormalized(unknownNorm, normalizeKeyForComparison(fieldName))
    );

    if (singularPluralMatches.length === 1) {
      targetField = singularPluralMatches[0];
    }
  }

  if (!targetField) return null;

  const existing = frontmatter[targetField];
  if (!isEmpty(existing)) return null;

  const field = schemaFields[targetField];
  if (!isFieldShapeCompatible(unknownValue, field)) return null;

  return targetField;
}
