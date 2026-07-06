import { relative } from 'path';
import type { Calendar, LoadedSchema, Field } from '../types/schema.js';
import { getFieldsForType, resolveDateCalendar, resolveTypeFromFrontmatter } from './schema.js';
import { extractLinkTarget } from './links.js';
import {
  resolveRelationTarget,
  type NoteTargetIndex,
  type VaultNoteSnapshot,
} from './discovery.js';
import { parseDate } from './local-date.js';
import { formatLinearCalendarDate, parseCalendarDate } from './calendar-date.js';

export type RelativeDateKind = 'equal' | 'after' | 'before';
export type RelativeDateUnit = 'min' | 'h' | 'd' | 'w';
export type RelativeDateResolution = 'ok' | 'cycle' | 'unanchored' | 'contradiction';

export interface RelativeDateOffset {
  amount: number;
  unit: RelativeDateUnit;
  mode: 'linear' | 'calendar';
}

export interface RelativeDateConstraint {
  kind: RelativeDateKind;
  ref: string;
  field?: string;
  offset?: RelativeDateOffset;
}

export interface RelativeDateFieldOutput {
  source: unknown;
  resolved: string | null;
  resolution: RelativeDateResolution;
  calendar?: string;
  linear?: number;
  bounds?: RelativeDateBoundOutput[];
}

export interface RelativeDateBoundOutput {
  kind: 'after' | 'before';
  ref: string;
  field?: string;
  offset?: RelativeDateOffset;
  resolved: string | null;
}

export type RelativeDateDiagnosticCode =
  | 'relative-date-cycle'
  | 'relative-date-contradiction'
  | 'relative-date-bound-violation'
  | 'relative-date-unanchored'
  | 'relative-date-invalid-ref'
  | 'relative-date-invalid-offset';

export interface RelativeDateDiagnostic {
  code: RelativeDateDiagnosticCode;
  severity: 'warning';
  path: string;
  field: string;
  message: string;
  relatedPaths?: string[];
}

interface IndexedNote {
  path: string;
  relativePath: string;
  frontmatter: Record<string, unknown>;
  typePath: string;
  fields: Record<string, Field>;
}

interface ResolveKey {
  path: string;
  field: string;
}

interface ResolveResult {
  resolved: ResolvedPosition | null;
  resolution: RelativeDateResolution;
  source: unknown;
  constraints: RelativeDateConstraint[];
  diagnostics: RelativeDateDiagnostic[];
  bounds: RelativeDateBoundOutput[];
}

interface ResolvedPosition {
  value: number;
  display: string;
  calendar?: string;
  calendarDef?: Calendar;
}

export type RelativeDateFieldMap = Map<string, Map<string, RelativeDateFieldOutput>>;

const DEFAULT_OFFSET: RelativeDateOffset = { amount: 0, unit: 'h', mode: 'linear' };
const MS_PER_UNIT: Record<RelativeDateUnit, number> = {
  min: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

function parseRelativeDateOffset(value: unknown): RelativeDateOffset | null {
  if (value === undefined || value === null || value === '') return { ...DEFAULT_OFFSET };
  if (typeof value === 'object' && !Array.isArray(value)) {
    const raw = value as Record<string, unknown>;
    if (
      typeof raw.amount === 'number' &&
      Number.isFinite(raw.amount) &&
      isRelativeDateUnit(raw.unit) &&
      (raw.mode === undefined || raw.mode === 'linear' || raw.mode === 'calendar')
    ) {
      return { amount: raw.amount, unit: raw.unit, mode: raw.mode === 'calendar' ? 'calendar' : 'linear' };
    }
    return null;
  }
  if (typeof value !== 'string') return null;

  const match = value.trim().match(/^([+-]?\d+)(min|h|d|w)$/);
  if (!match) return null;
  return {
    amount: Number.parseInt(match[1]!, 10),
    unit: match[2]! as RelativeDateUnit,
    mode: 'linear',
  };
}

function parseRelativeDateConstraints(value: unknown): RelativeDateConstraint[] | null {
  const rawConstraints = Array.isArray(value) ? value : [value];
  const parsed: RelativeDateConstraint[] = [];

  for (const rawConstraint of rawConstraints) {
    if (typeof rawConstraint !== 'object' || rawConstraint === null || Array.isArray(rawConstraint)) {
      return null;
    }
    const raw = rawConstraint as Record<string, unknown>;
    if (!isRelativeDateKind(raw.kind) || typeof raw.ref !== 'string' || raw.ref.trim() === '') {
      return null;
    }
    if (raw.field !== undefined && typeof raw.field !== 'string') return null;
    const offset = parseRelativeDateOffset(raw.offset);
    if (!offset) return null;

    parsed.push({
      kind: raw.kind,
      ref: raw.ref,
      ...(raw.field !== undefined ? { field: raw.field } : {}),
      offset,
    });
  }

  return parsed;
}

export function validateRelativeDateValue(fieldName: string, value: unknown): string | null {
  const rawConstraints = Array.isArray(value) ? value : [value];
  for (let index = 0; index < rawConstraints.length; index++) {
    const prefix = Array.isArray(value) ? `${fieldName}[${index}]` : fieldName;
    const rawConstraint = rawConstraints[index];
    if (typeof rawConstraint !== 'object' || rawConstraint === null || Array.isArray(rawConstraint)) {
      return `Invalid relative-date for ${prefix}: expected object with kind, ref, field, and offset`;
    }
    const raw = rawConstraint as Record<string, unknown>;
    if (!isRelativeDateKind(raw.kind)) {
      return `Invalid relative-date for ${prefix}.kind: expected equal, after, or before`;
    }
    if (typeof raw.ref !== 'string' || raw.ref.trim() === '') {
      return `Invalid relative-date for ${prefix}.ref: expected non-empty wikilink or note reference`;
    }
    if (raw.field !== undefined && typeof raw.field !== 'string') {
      return `Invalid relative-date for ${prefix}.field: expected string`;
    }
    if (raw.offset !== undefined && parseRelativeDateOffset(raw.offset) === null) {
      return `Invalid relative-date for ${prefix}.offset: expected signed duration using min, h, d, or w`;
    }
  }
  return null;
}

export function buildRelativeDateFieldMap(
  schema: LoadedSchema,
  vaultDir: string,
  snapshot: VaultNoteSnapshot,
  noteTargetIndex: NoteTargetIndex
): { fields: RelativeDateFieldMap; diagnostics: RelativeDateDiagnostic[] } {
  const notes = new Map<string, IndexedNote>();
  const cache = new Map<string, ResolveResult>();
  const diagnostics: RelativeDateDiagnostic[] = [];
  const emitted = new Set<string>();

  for (const note of snapshot.notes) {
    if (!note.frontmatter) continue;
    const typePath = note.resolvedType ?? resolveTypeFromFrontmatter(schema, note.frontmatter);
    if (!typePath) continue;
    const fields = getFieldsForType(schema, typePath);
    notes.set(note.relativePath, {
      path: note.path,
      relativePath: note.relativePath,
      frontmatter: note.frontmatter,
      typePath,
      fields,
    });
  }

  const ctx = {
    schema,
    notes,
    noteTargetIndex,
    cache,
    diagnostics,
    emitted,
  };

  const output: RelativeDateFieldMap = new Map();
  for (const note of notes.values()) {
    for (const [fieldName, field] of Object.entries(note.fields)) {
      if (field.prompt !== 'relative-date') continue;
      const result = resolveRelativeDateField(ctx, { path: note.relativePath, field: fieldName }, []);
      setRelativeDateOutput(output, note.path, fieldName, {
        source: result.source ?? null,
        resolved: result.resolved?.display ?? null,
        resolution: result.resolution,
        ...(result.resolved?.calendar ? { calendar: result.resolved.calendar, linear: result.resolved.value } : {}),
        ...(result.bounds.length > 0 ? { bounds: result.bounds } : {}),
      });
    }
  }

  // Keep diagnostics stable and display-oriented.
  diagnostics.sort((a, b) => {
    const pathCompare = relative(vaultDir, a.path).localeCompare(relative(vaultDir, b.path));
    return pathCompare || a.field.localeCompare(b.field) || a.code.localeCompare(b.code);
  });

  return { fields: output, diagnostics };
}

function resolveRelativeDateField(
  ctx: {
    schema: LoadedSchema;
    notes: Map<string, IndexedNote>;
    noteTargetIndex: NoteTargetIndex;
    cache: Map<string, ResolveResult>;
    diagnostics: RelativeDateDiagnostic[];
    emitted: Set<string>;
  },
  key: ResolveKey,
  stack: ResolveKey[]
): ResolveResult {
  const cacheKey = makeCacheKey(key);
  const cached = ctx.cache.get(cacheKey);
  if (cached) return cached;

  const note = ctx.notes.get(key.path);
  if (!note) {
    return emptyResult(undefined, 'unanchored');
  }

  const cycleStart = stack.findIndex(item => makeCacheKey(item) === cacheKey);
  if (cycleStart >= 0) {
    const cycle = [...stack.slice(cycleStart), key];
    const relatedPaths = [...new Set(cycle.map(item => item.path))];
    for (const cycleKey of cycle) {
      const cycleNote = ctx.notes.get(cycleKey.path);
      if (!cycleNote) continue;
      emitDiagnostic(ctx, {
        code: 'relative-date-cycle',
        severity: 'warning',
        path: cycleNote.path,
        field: cycleKey.field,
        relatedPaths,
        message: `Relative date cycle detected for ${cycleKey.field}: ${relatedPaths.join(' -> ')}`,
      });
      ctx.cache.set(makeCacheKey(cycleKey), emptyResult(cycleNote.frontmatter[cycleKey.field], 'cycle'));
    }
    return emptyResult(note.frontmatter[key.field], 'cycle');
  }

  const field = note.fields[key.field];
  if (!field || field.prompt !== 'relative-date') {
    const absolute = parseAbsoluteDateValue(ctx.schema, note, key.field, field);
    return {
      resolved: absolute,
      resolution: absolute === null ? 'unanchored' : 'ok',
      source: note.frontmatter[key.field],
      constraints: [],
      diagnostics: [],
      bounds: [],
    };
  }

  const source = note.frontmatter[key.field];
  const constraints = parseRelativeDateConstraints(source);
  if (!constraints || constraints.length === 0) {
    const ownAnchor = resolveOwnAbsoluteAnchor(ctx.schema, note);
    const result: ResolveResult = ownAnchor === null
      ? emptyResult(source, 'unanchored')
      : {
          resolved: ownAnchor,
          resolution: 'ok',
          source,
          constraints: [],
          diagnostics: [],
          bounds: [],
        };
    ctx.cache.set(cacheKey, result);
    return result;
  }

  const equalResults: Array<{ constraint: RelativeDateConstraint; resolved: ResolvedPosition | null; resolution: RelativeDateResolution; path?: string }> = [];
  const bounds: RelativeDateBoundOutput[] = [];
  const boundResults: Array<{ bound: RelativeDateBoundOutput; resolved: ResolvedPosition | null }> = [];

  for (const constraint of constraints) {
    const targetPath = resolveConstraintTarget(ctx, constraint, field);
    if (!targetPath) {
      emitDiagnostic(ctx, {
        code: 'relative-date-invalid-ref',
        severity: 'warning',
        path: note.path,
        field: key.field,
        message: `Relative date ${key.field} references an unknown or ambiguous note: ${constraint.ref}`,
      });
      continue;
    }

    const target = ctx.notes.get(targetPath);
    const targetField = target ? resolveTargetField(target, constraint.field) : undefined;
    const targetResult = target && targetField
      ? resolveRelativeDateField(ctx, { path: targetPath, field: targetField }, [...stack, key])
      : emptyResult(undefined, 'unanchored');
    const resolved = targetResult.resolved === null
      ? null
      : applyOffsetToPosition(ctx, note, key.field, targetResult.resolved, constraint.offset ?? DEFAULT_OFFSET);

    if (constraint.kind === 'equal') {
      equalResults.push({ constraint, resolved, resolution: targetResult.resolution, path: targetPath });
    } else {
      const offset = resolvedOffsetForPosition(targetResult.resolved, constraint.offset ?? DEFAULT_OFFSET);
      const bound: RelativeDateBoundOutput = {
        kind: constraint.kind,
        ref: constraint.ref,
        ...(constraint.field ? { field: constraint.field } : {}),
        offset,
        resolved: resolved?.display ?? null,
      };
      bounds.push(bound);
      boundResults.push({ bound, resolved });
    }
  }

  const firstEqual = equalResults[0];
  let resolution: RelativeDateResolution = 'unanchored';
  let resolved: ResolvedPosition | null = null;

  if (firstEqual) {
    resolved = firstEqual.resolved;
    resolution = firstEqual.resolution === 'ok' ? 'ok' : firstEqual.resolution;
    const disagreeing = equalResults.slice(1).filter(result =>
      result.resolved !== null &&
      firstEqual.resolved !== null &&
      !positionsEqual(result.resolved, firstEqual.resolved)
    );
    if (disagreeing.length > 0) {
      resolution = 'contradiction';
      emitDiagnostic(ctx, {
        code: 'relative-date-contradiction',
        severity: 'warning',
        path: note.path,
        field: key.field,
        relatedPaths: equalResults.map(result => result.path).filter((path): path is string => Boolean(path)),
        message: `Relative date ${key.field} has equal constraints that resolve to different positions`,
      });
    }
  }

  if (!firstEqual && bounds.length > 0) {
    resolution = 'unanchored';
  }

  if (resolved !== null) {
    for (const { bound, resolved: boundResult } of boundResults) {
      if (!bound.resolved) continue;
      if (!boundResult || !positionsComparable(resolved, boundResult)) continue;
      const violates = bound.kind === 'after' ? resolved.value < boundResult.value : resolved.value > boundResult.value;
      if (violates) {
        emitDiagnostic(ctx, {
          code: 'relative-date-bound-violation',
          severity: 'warning',
          path: note.path,
          field: key.field,
          message: `Relative date ${key.field} violates ${bound.kind} bound against ${bound.ref}`,
        });
      }
    }
  }

  const result: ResolveResult = {
    resolved,
    resolution,
    source,
    constraints,
    diagnostics: [],
    bounds,
  };
  ctx.cache.set(cacheKey, result);
  return result;
}

function resolveTargetField(note: IndexedNote, explicitField: string | undefined): string | undefined {
  if (explicitField) return explicitField;
  for (const [fieldName, field] of Object.entries(note.fields)) {
    if (field.prompt === 'date' && note.frontmatter[fieldName] !== undefined) return fieldName;
  }
  for (const [fieldName, field] of Object.entries(note.fields)) {
    if (field.prompt === 'relative-date' && note.frontmatter[fieldName] !== undefined) return fieldName;
  }
  return undefined;
}

function resolveOwnAbsoluteAnchor(schema: LoadedSchema, note: IndexedNote): ResolvedPosition | null {
  for (const [fieldName, field] of Object.entries(note.fields)) {
    if (field.prompt !== 'date') continue;
    const resolved = parseAbsoluteDateValue(schema, note, fieldName, field);
    if (resolved !== null) return resolved;
  }
  return null;
}

function resolveConstraintTarget(
  ctx: { schema: LoadedSchema; noteTargetIndex: NoteTargetIndex },
  constraint: RelativeDateConstraint,
  field: Field
): string | null {
  const target = extractLinkTarget(constraint.ref) ?? constraint.ref.trim();
  if (!target) return null;
  const resolved = resolveRelationTarget(ctx.noteTargetIndex, target, {
    schema: ctx.schema,
    source: field.source,
  });
  return resolved.resolvedPath ?? null;
}

function parseAbsoluteDateValue(
  schema: LoadedSchema,
  note: IndexedNote,
  fieldName: string,
  field: Field | undefined
): ResolvedPosition | null {
  let value = note.frontmatter[fieldName];
  const calendarId = field
    ? resolveDateCalendar(schema, note.typePath, fieldName, field)
    : undefined;
  if (calendarId) {
    const parsed = parseCalendarDate(value, calendarId, schema.config.calendars[calendarId]!);
    return parsed.valid
      ? {
          value: parsed.date.linear,
          display: parsed.date.value,
          calendar: calendarId,
          calendarDef: schema.config.calendars[calendarId]!,
        }
      : null;
  }
  if (value instanceof Date) {
    return { value: value.getTime(), display: value.toISOString() };
  }
  if (typeof value === 'number') value = String(value);
  if (typeof value !== 'string') return null;
  const parsed = parseDate(value);
  return parsed.valid && parsed.date
    ? { value: parsed.date.getTime(), display: parsed.date.toISOString() }
    : null;
}

function applyOffsetToPosition(
  ctx: { diagnostics: RelativeDateDiagnostic[]; emitted: Set<string> },
  note: IndexedNote,
  fieldName: string,
  position: ResolvedPosition,
  offset: RelativeDateOffset
): ResolvedPosition | null {
  if (position.calendar && offset.unit === 'w') {
    emitDiagnostic(ctx, {
      code: 'relative-date-invalid-offset',
      severity: 'warning',
      path: note.path,
      field: fieldName,
      message: `Relative date ${fieldName} uses unsupported calendar offset unit "w"; use h or d for calendar chains`,
    });
    return null;
  }

  const amount = offsetAmount(position, offset);
  const nextValue = position.value + amount;
  if (position.calendar && position.calendarDef) {
    const formatted = formatLinearCalendarDate(nextValue, position.calendar, position.calendarDef);
    if (!formatted.valid) {
      emitDiagnostic(ctx, {
        code: 'relative-date-invalid-offset',
        severity: 'warning',
        path: note.path,
        field: fieldName,
        message: `Relative date ${fieldName} offset cannot be formatted in calendar "${position.calendar}": ${formatted.error}`,
      });
      return null;
    }
    return {
      value: nextValue,
      display: formatted.date.value,
      calendar: position.calendar,
      calendarDef: position.calendarDef,
    };
  }

  return {
    value: nextValue,
    display: new Date(nextValue).toISOString(),
  };
}

function resolvedOffsetForPosition(
  position: ResolvedPosition | null,
  offset: RelativeDateOffset
): RelativeDateOffset {
  return position?.calendar ? { ...offset, mode: 'calendar' } : offset;
}

function offsetAmount(position: ResolvedPosition, offset: RelativeDateOffset): number {
  if (!position.calendar) return offset.amount * MS_PER_UNIT[offset.unit];
  if (offset.unit === 'min') return offset.amount / 60;
  if (offset.unit === 'h') return offset.amount;
  if (offset.unit === 'd') return offset.amount * (position.calendarDef?.hoursInDay ?? 24);
  return offset.amount * MS_PER_UNIT[offset.unit];
}

function positionsEqual(left: ResolvedPosition, right: ResolvedPosition): boolean {
  return positionsComparable(left, right) && left.value === right.value;
}

function positionsComparable(left: ResolvedPosition, right: ResolvedPosition): boolean {
  return left.calendar === right.calendar;
}

function setRelativeDateOutput(
  map: RelativeDateFieldMap,
  path: string,
  field: string,
  value: RelativeDateFieldOutput
): void {
  const fields = map.get(path) ?? new Map<string, RelativeDateFieldOutput>();
  fields.set(field, value);
  map.set(path, fields);
}

function emptyResult(source: unknown, resolution: RelativeDateResolution): ResolveResult {
  return {
    resolved: null,
    resolution,
    source,
    constraints: [],
    diagnostics: [],
    bounds: [],
  };
}

function emitDiagnostic(
  ctx: { diagnostics: RelativeDateDiagnostic[]; emitted: Set<string> },
  diagnostic: RelativeDateDiagnostic
): void {
  const key = `${diagnostic.code}:${diagnostic.path}:${diagnostic.field}:${diagnostic.message}`;
  if (ctx.emitted.has(key)) return;
  ctx.emitted.add(key);
  ctx.diagnostics.push(diagnostic);
}

function makeCacheKey(key: ResolveKey): string {
  return `${key.path}#${key.field}`;
}

function isRelativeDateKind(value: unknown): value is RelativeDateKind {
  return value === 'equal' || value === 'after' || value === 'before';
}

function isRelativeDateUnit(value: unknown): value is RelativeDateUnit {
  return value === 'min' || value === 'h' || value === 'd' || value === 'w';
}
