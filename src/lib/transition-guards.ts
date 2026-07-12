import { join, relative } from 'path';
import type { LoadedSchema, TransitionGuard } from '../types/schema.js';
import { getType, getFieldsForType, getDescendants } from './schema.js';
import { getOptionValues } from '../types/schema.js';
import { buildNoteTargetIndex, resolveRelationTarget } from './discovery.js';
import { parseNote } from './frontmatter.js';
import { extractLinkTargets } from './links.js';

export interface TransitionTrigger { field: string; value: string }
export interface TransitionGuardTargetResult {
  target: string;
  path?: string;
  status: 'unresolved' | 'stale' | 'failed' | 'satisfied';
  value?: unknown;
}
export interface TransitionGuardRequirementResult {
  relation: string;
  min: number;
  status: 'missing' | 'unresolved' | 'stale' | 'failed' | 'satisfied';
  targets: TransitionGuardTargetResult[];
}
export interface TransitionGuardResult {
  on: TransitionTrigger;
  blocked: boolean;
  requirements: TransitionGuardRequirementResult[];
}
export interface TransitionExplanation {
  type: string;
  transition: TransitionTrigger;
  blocked: boolean;
  guards: TransitionGuardResult[];
}

/** The deliberately small trigger grammar shared by guards and recurrence. */
export function parseTransitionTrigger(input: string): TransitionTrigger | undefined {
  const match = input.match(/^\s*([^=\s]+)\s*=\s*(.+?)\s*$/);
  return match ? { field: match[1]!, value: match[2]! } : undefined;
}

export function getTransitionGuardsForType(schema: LoadedSchema, typeName: string): TransitionGuard[] {
  const type = getType(schema, typeName);
  if (!type) return [];
  const traits = schema.raw.traits ?? {};
  const guards: TransitionGuard[] = [];
  for (const traitName of type.traits) guards.push(...(traits[traitName]?.transition_guards ?? []));
  return guards;
}

/** Fail early on invalid effective trait configuration, before a write path sees it. */
export function validateTransitionGuards(schema: LoadedSchema, typeName: string): string[] {
  const fields = getFieldsForType(schema, typeName);
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const guard of getTransitionGuardsForType(schema, typeName)) {
    const trigger = parseTransitionTrigger(guard.on);
    if (!trigger) { errors.push(`Invalid transition guard trigger '${guard.on}'. Expected '<field> = <value>'.`); continue; }
    const key = `${trigger.field}\u0000${trigger.value}`;
    if (seen.has(key)) errors.push(`Duplicate transition guard for '${guard.on}' on type '${typeName}'.`);
    seen.add(key);
    if (!fields[trigger.field]) errors.push(`Transition guard '${guard.on}' references unknown field '${trigger.field}'.`);
    for (const requirement of guard.requires) {
      if (fields[requirement.relation]?.prompt !== 'relation') errors.push(`Transition guard '${guard.on}' relation '${requirement.relation}' must be an effective relation field.`);
      const source = fields[requirement.relation]?.source;
      const sources = Array.isArray(source) ? source : source ? [source] : [];
      // An unconstrained/any relation deliberately has no static target type to
      // inspect. Concrete sources include their descendants, just like normal
      // relation validation.
      const targetTypes = sources.includes('any') ? [] : sources.flatMap((name) => [name, ...getDescendants(schema, name)]);
      for (const predicate of [requirement.all, requirement.failed_when, requirement.stale_when]) {
        if (!predicate) continue;
        for (const targetType of targetTypes) {
          const targetField = getFieldsForType(schema, targetType)[predicate.field];
          if (!targetField) { errors.push(`Transition guard '${guard.on}' predicate references unknown field '${predicate.field}' on relation target type '${targetType}'.`); continue; }
          if (targetField.prompt === 'select' && targetField.options && targetField.options.length > 0) {
            const allowed = new Set(getOptionValues(targetField.options));
            const values = predicate.equals === undefined ? predicate.in! : [predicate.equals];
            for (const value of values) if (!allowed.has(value)) errors.push(`Transition guard '${guard.on}' predicate value '${value}' is not an option for '${targetType}.${predicate.field}'.`);
          }
        }
      }
    }
  }
  return errors;
}

function matches(predicate: { field: string; equals?: string | undefined; in?: string[] | undefined }, frontmatter: Record<string, unknown>): boolean {
  const value = frontmatter[predicate.field];
  if (value === undefined || value === null) return false;
  const expected = predicate.equals === undefined ? predicate.in! : [predicate.equals];
  return expected.includes(String(value));
}

export async function explainTransition(
  schema: LoadedSchema, vaultDir: string, typeName: string, frontmatter: Record<string, unknown>, transition: TransitionTrigger
): Promise<TransitionExplanation> {
  const errors = validateTransitionGuards(schema, typeName);
  if (errors.length) throw new Error(errors.join(' '));
  const matching = getTransitionGuardsForType(schema, typeName).filter((guard) => {
    const trigger = parseTransitionTrigger(guard.on)!;
    return trigger.field === transition.field && trigger.value === transition.value;
  });
  const index = await buildNoteTargetIndex(schema, vaultDir);
  const fields = getFieldsForType(schema, typeName);
  const guards: TransitionGuardResult[] = [];
  for (const guard of matching) {
    const trigger = parseTransitionTrigger(guard.on)!;
    const requirements: TransitionGuardRequirementResult[] = [];
    for (const requirement of guard.requires) {
      const field = fields[requirement.relation]!;
      const targets: TransitionGuardTargetResult[] = [];
      for (const target of extractLinkTargets(frontmatter[requirement.relation])) {
        const resolved = resolveRelationTarget(index, target, { schema, source: field.source });
        if (resolved.resolution !== 'unique' || !resolved.resolvedPath) {
          targets.push({ target, status: 'unresolved' });
          continue;
        }
        try {
          const note = await parseNote(join(vaultDir, resolved.resolvedPath));
          const value = note.frontmatter[requirement.all.field];
          const status = requirement.stale_when && matches(requirement.stale_when, note.frontmatter)
            ? 'stale' : requirement.failed_when && matches(requirement.failed_when, note.frontmatter)
              ? 'failed' : matches(requirement.all, note.frontmatter) ? 'satisfied' : 'failed';
          targets.push({ target, path: relative(vaultDir, join(vaultDir, resolved.resolvedPath)), status, value });
        } catch { targets.push({ target, path: resolved.resolvedPath, status: 'unresolved' }); }
      }
      const status = targets.length < (requirement.min ?? 1) ? 'missing'
        : targets.some((target) => target.status === 'unresolved') ? 'unresolved'
        : targets.some((target) => target.status === 'stale') ? 'stale'
        : targets.some((target) => target.status === 'failed') ? 'failed' : 'satisfied';
      requirements.push({ relation: requirement.relation, min: requirement.min ?? 1, status, targets });
    }
    guards.push({ on: trigger, blocked: requirements.some((requirement) => requirement.status !== 'satisfied'), requirements });
  }
  return { type: typeName, transition, blocked: guards.some((guard) => guard.blocked), guards };
}

export async function assertTransitionGuards(
  schema: LoadedSchema, vaultDir: string, typeName: string, before: Record<string, unknown>, after: Record<string, unknown>
): Promise<void> {
  for (const guard of getTransitionGuardsForType(schema, typeName)) {
    const trigger = parseTransitionTrigger(guard.on);
    if (!trigger || String(before[trigger.field] ?? '') === trigger.value || String(after[trigger.field] ?? '') !== trigger.value) continue;
    const explanation = await explainTransition(schema, vaultDir, typeName, after, trigger);
    if (explanation.blocked) {
      const error = new Error('Transition guard requirements are not satisfied.');
      Object.assign(error, { code: 'TRANSITION_GUARD_FAILED', explanation });
      throw error;
    }
  }
}

/** Resolve the direct evidence-note paths that participate in entered guards. */
export async function transitionGuardTargetPaths(
  schema: LoadedSchema,
  vaultDir: string,
  typeName: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>
): Promise<string[]> {
  const entered = getTransitionGuardsForType(schema, typeName).filter((guard) => {
    const trigger = parseTransitionTrigger(guard.on);
    return trigger
      && String(before[trigger.field] ?? '') !== trigger.value
      && String(after[trigger.field] ?? '') === trigger.value;
  });
  if (entered.length === 0) return [];

  const index = await buildNoteTargetIndex(schema, vaultDir);
  const fields = getFieldsForType(schema, typeName);
  const paths = new Set<string>();
  for (const guard of entered) {
    for (const requirement of guard.requires) {
      const field = fields[requirement.relation]!;
      for (const target of extractLinkTargets(after[requirement.relation])) {
        const resolved = resolveRelationTarget(index, target, { schema, source: field.source });
        if (resolved.resolution === 'unique' && resolved.resolvedPath) {
          paths.add(join(vaultDir, resolved.resolvedPath));
        }
      }
    }
  }
  return [...paths].sort();
}
