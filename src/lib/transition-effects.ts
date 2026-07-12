/**
 * Bounded related-note transition effects.
 *
 * Effects deliberately do not call edit/recurrence: the source mutation owns
 * the transaction and writes validated target bytes directly. That prevents a
 * target effect from cascading into further effects or successor creation.
 */

import { join } from 'path';
import { getOptionValues, type LoadedSchema, type TransitionEffect } from '../types/schema.js';
import { getDescendants, getEffectiveTraitNames, getFieldsForType, resolveTypePathFromFrontmatter } from './schema.js';
import { buildNoteTargetIndex, resolveRelationTarget } from './discovery.js';
import { extractLinkTargets } from './links.js';
import { parseNote, writeFileAtomic, writeNote } from './frontmatter.js';
import { readFile } from 'fs/promises';
import { validateContextFields, validateFrontmatter } from './validation.js';
import { normalizeDateFields } from './validation.js';
import { validateRelativeDateCalendarOffsetsForWrite } from './relative-date.js';
import { relative } from 'path';
import { isBwrbReservedFrontmatterField } from './frontmatter/systemFields.js';
import { parseTransitionTrigger } from './transition-guards.js';
import { expandStaticValue } from './local-date.js';

export interface PreparedTransitionEffect {
  path: string;
  raw: string;
  body: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  order: string[];
}

export interface CommittedTransitionEffects {
  writes: Array<{ effect: PreparedTransitionEffect; written: string }>;
}

function getTransitionEffectsForType(schema: LoadedSchema, typeName: string): TransitionEffect[] {
  const traits = schema.raw.traits ?? {};
  return getEffectiveTraitNames(schema, typeName).flatMap((traitName) => traits[traitName]?.transition_effects ?? []);
}

export function validateTransitionEffects(schema: LoadedSchema, typeName: string): string[] {
  const fields = getFieldsForType(schema, typeName);
  const errors: string[] = [];
  for (const effect of getTransitionEffectsForType(schema, typeName)) {
    const trigger = parseTransitionTrigger(effect.on);
    if (!trigger) {
      errors.push(`Invalid transition effect trigger '${effect.on}'. Expected '<field> = <value>'.`);
      continue;
    }
    if (!fields[trigger.field]) errors.push(`Transition effect '${effect.on}' references unknown field '${trigger.field}'.`);
    const relation = fields[effect.relation];
    if (relation?.prompt !== 'relation' || relation.multiple === true) {
      errors.push(`Transition effect '${effect.on}' relation '${effect.relation}' must be an effective scalar relation field.`);
    }
    const sources = Array.isArray(relation?.source) ? relation.source : relation?.source ? [relation.source] : [];
    const targetTypes = sources.includes('any') ? [] : sources.flatMap((source) => [source, ...getDescendants(schema, source)]);
    for (const [field, value] of Object.entries(effect.set)) {
      if (isBwrbReservedFrontmatterField(field)) {
        errors.push(`Transition effect '${effect.on}' cannot modify system-managed field '${field}'.`);
      }
      for (const targetType of targetTypes) {
        const targetField = getFieldsForType(schema, targetType)[field];
        if (!targetField) {
          errors.push(`Transition effect '${effect.on}' patch references unknown field '${field}' on relation target type '${targetType}'.`);
          continue;
        }
        if (targetField.prompt === 'select' && targetField.options?.length && !['$ACTOR', '$NOW', '$TODAY'].includes(value) && !getOptionValues(targetField.options).includes(value)) {
          errors.push(`Transition effect '${effect.on}' value '${value}' is not an option for '${targetType}.${field}'.`);
        }
      }
    }
  }
  return errors;
}

function entered(effect: TransitionEffect, before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  const trigger = parseTransitionTrigger(effect.on);
  return Boolean(trigger
    && String(before[trigger.field] ?? '') !== trigger.value
    && String(after[trigger.field] ?? '') === trigger.value);
}

function expandEffectValue(value: string, schema: LoadedSchema): string {
  // Keep the date expansion seam shared with ordinary static values.
  if (value === '$ACTOR' || value === '$NOW' || value === '$TODAY') {
    return expandStaticValue(value, new Date(), schema.config.dateFormat);
  }
  return value;
}

/** Prepare every entered effect and validate all target notes before any write. */
export async function prepareTransitionEffects(
  schema: LoadedSchema,
  vaultDir: string,
  typeName: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  sourcePath?: string
): Promise<PreparedTransitionEffect[]> {
  const effects = getTransitionEffectsForType(schema, typeName).filter((effect) => entered(effect, before, after));
  if (effects.length === 0) return [];
  const errors = validateTransitionEffects(schema, typeName);
  if (errors.length) throw new Error(errors.join(' '));
  const index = await buildNoteTargetIndex(schema, vaultDir);
  const fields = getFieldsForType(schema, typeName);
  const prepared = new Map<string, PreparedTransitionEffect>();

  for (const effect of effects) {
    const relationValue = after[effect.relation];
    if (relationValue === undefined || relationValue === null || (typeof relationValue === 'string' && relationValue.trim() === '')) continue;
    const targets = extractLinkTargets(relationValue);
    if (targets.length !== 1) throw new Error(`Transition effect '${effect.on}' relation '${effect.relation}' must contain one direct relation target.`);
    const resolved = resolveRelationTarget(index, targets[0]!, { schema, source: fields[effect.relation]!.source });
    if (resolved.resolution !== 'unique' || !resolved.resolvedPath) {
      throw new Error(`Transition effect '${effect.on}' relation '${effect.relation}' does not resolve to one note.`);
    }
    const path = join(vaultDir, resolved.resolvedPath);
    if (sourcePath === path) throw new Error(`Transition effect '${effect.on}' cannot target its source note.`);
    let target = prepared.get(path);
    if (!target) {
      const parsed = await parseNote(path);
      target = { path, raw: parsed.raw, body: parsed.body, before: parsed.frontmatter, after: { ...parsed.frontmatter }, order: [] };
      prepared.set(path, target);
    }
    for (const [field, value] of Object.entries(effect.set)) target.after[field] = expandEffectValue(value, schema);
  }

  for (const target of prepared.values()) {
    const targetType = resolveTypePathFromFrontmatter(schema, target.after);
    if (!targetType) throw new Error(`Transition effect target '${relative(vaultDir, target.path)}' has no recognized type.`);
    target.after = normalizeDateFields(schema, targetType, target.after);
    const validation = validateFrontmatter(schema, targetType, target.after);
    if (!validation.valid) throw new Error(`Transition effect target '${relative(vaultDir, target.path)}' is invalid: ${validation.errors.map((error) => error.message).join(', ')}`);
    const context = await validateContextFields(schema, vaultDir, targetType, target.after);
    if (!context.valid) throw new Error(`Transition effect target '${relative(vaultDir, target.path)}' has invalid relations: ${context.errors.map((error) => error.message).join(', ')}`);
    const dates = await validateRelativeDateCalendarOffsetsForWrite(schema, vaultDir, targetType, target.after, relative(vaultDir, target.path));
    if (dates.length) throw new Error(`Transition effect target '${relative(vaultDir, target.path)}' is invalid: ${dates.map((error) => error.message).join(', ')}`);
    target.order = Object.keys(target.after);
  }
  return [...prepared.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function transitionEffectTargetPaths(effects: PreparedTransitionEffect[]): string[] {
  return effects.map((effect) => effect.path);
}

/** Restore only bytes written by this transaction, preserving newer writers. */
export async function rollbackTransitionEffects(committed: CommittedTransitionEffects): Promise<void> {
  for (const { effect, written } of [...committed.writes].reverse()) {
    if (await readFile(effect.path, 'utf-8').catch(() => '') === written) {
      await writeFileAtomic(effect.path, effect.raw);
    }
  }
}

/** Write targets directly: no guard/effect/recurrence execution is re-entered. */
export async function commitTransitionEffects(effects: PreparedTransitionEffect[]): Promise<CommittedTransitionEffects> {
  const committed: CommittedTransitionEffects = { writes: [] };
  try {
    for (const effect of effects) {
      await writeNote(effect.path, effect.after, effect.body, effect.order);
      committed.writes.push({ effect, written: await readFile(effect.path, 'utf-8') });
    }
    return committed;
  } catch (error) {
    await rollbackTransitionEffects(committed);
    throw error;
  }
}
