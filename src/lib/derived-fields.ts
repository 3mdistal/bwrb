import type { Expression, CallExpression, Identifier, MemberExpression } from 'jsep';
import { evaluateExpression, parseExpression } from './expression.js';
import { parsePartialIsoDate } from './local-date.js';
import type { Field, LoadedSchema } from '../types/schema.js';

export type DerivedValueType = 'string' | 'number' | 'boolean' | 'date';

export interface DerivedFieldDefinition {
  expression: string;
  type: DerivedValueType;
}

export interface DerivedFieldPlanEntry extends DerivedFieldDefinition {
  field: string;
  dependencies: string[];
  expressionAst: Expression;
}

/** A deterministic, dependency-first plan for one resolved effective type. */
export interface DerivedFieldPlan {
  fields: Map<string, DerivedFieldPlanEntry>;
  order: string[];
}

export interface DerivedFieldPlans {
  byType: Map<string, DerivedFieldPlan>;
}

export interface DerivedFieldProjectionOptions {
  /** The query snapshot day, always YYYY-MM-DD. Required so today() is stable. */
  asOf: string;
  /** Optional note path included in runtime errors from a query projection. */
  notePath?: string;
}

const plansBySchema = new WeakMap<LoadedSchema, DerivedFieldPlans>();

const PURE_FUNCTIONS = new Set([
  'contains', 'startsWith', 'endsWith', 'lower', 'upper', 'length', 'trim', 'replace',
  'today', 'date', 'year', 'month', 'day', 'isEmpty', 'isNull', 'isDefined',
]);
const REJECTED_FUNCTIONS = new Set([
  'now', 'inFolder', 'hasTag', 'isRoot', 'isChildOf', 'isDescendantOf', 'under',
]);
const DERIVED_INCOMPATIBLE_KEYS = [
  'prompt', 'value', 'default', 'required', 'options', 'source', 'filter', 'multiple',
  'list_format', 'reset_on_fork', 'owned', 'alias', 'minimum', 'maximum',
] as const;

/**
 * Validate every resolved type's derived declarations and produce its
 * dependency-first evaluation plan. Call this after schema inheritance and
 * traits have been resolved.
 */
export function validateDerivedFields(schema: LoadedSchema): DerivedFieldPlans {
  const byType = new Map<string, DerivedFieldPlan>();
  for (const type of schema.types.values()) {
    const plan = buildDerivedFieldPlan(type.fields, `types.${type.name}.fields`);
    if (plan.order.length > 0) byType.set(type.name, plan);
  }
  const plans = { byType };
  plansBySchema.set(schema, plans);
  return plans;
}

/** Return the cached resolved-type plan, validating and caching on first use. */
export function getDerivedFieldPlan(
  schema: LoadedSchema,
  typeName: string
): DerivedFieldPlan | undefined {
  return (plansBySchema.get(schema) ?? validateDerivedFields(schema)).byType.get(typeName);
}

/** Validate a single resolved effective field map and build its evaluation DAG. */
export function buildDerivedFieldPlan(
  fields: Record<string, Field>,
  path = 'fields'
): DerivedFieldPlan {
  const entries = new Map<string, DerivedFieldPlanEntry>();

  for (const [field, declaration] of Object.entries(fields)) {
    if (!declaration.derived) continue;
    const incompatible = DERIVED_INCOMPATIBLE_KEYS.find((key) =>
      Object.hasOwn(declaration as object, key)
    );
    if (incompatible) {
      throw new Error(
        `${path}.${field}: derived fields cannot also declare ${incompatible}`
      );
    }
    const derived = declaration.derived;
    let expressionAst: Expression;
    try {
      expressionAst = parseExpression(derived.expression);
    } catch (error) {
      throw new Error(`${path}.${field}.derived.expression: ${(error as Error).message}`);
    }
    const dependencies = [...collectDependencies(expressionAst, field, path)];
    for (const dependency of dependencies) {
      if (!Object.hasOwn(fields, dependency)) {
        throw new Error(
          `${path}.${field}.derived.expression: unknown field reference "${dependency}"`
        );
      }
      if (dependency === field) {
        throw new Error(`${path}.${field}.derived.expression: field "${field}" cannot reference itself`);
      }
      if (fields[dependency]?.prompt === 'relative-date') {
        throw new Error(
          `${path}.${field}.derived.expression: relative-date field "${dependency}" is not record-local and cannot be referenced`
        );
      }
    }
    entries.set(field, { field, expression: derived.expression, type: derived.type, dependencies, expressionAst });
  }

  const order: string[] = [];
  const states = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (field: string): void => {
    const state = states.get(field);
    if (state === 'done') return;
    if (state === 'visiting') {
      const start = stack.indexOf(field);
      const chain = [...stack.slice(start), field].join(' -> ');
      throw new Error(`${path}.${field}.derived.expression: derived-field cycle ${chain}`);
    }
    states.set(field, 'visiting');
    stack.push(field);
    const entry = entries.get(field);
    if (entry) {
      for (const dependency of entry.dependencies) {
        if (entries.has(dependency)) visit(dependency);
      }
      order.push(field);
    }
    stack.pop();
    states.set(field, 'done');
  };
  for (const field of entries.keys()) visit(field);
  return { fields: entries, order };
}

/**
 * Return a copy of record frontmatter with virtual values overlaid. Stored
 * same-name values are intentionally overwritten, never consulted.
 */
export function projectDerivedFields(
  plan: DerivedFieldPlan | undefined,
  frontmatter: Record<string, unknown>,
  options: DerivedFieldProjectionOptions
): Record<string, unknown> {
  if (!plan || plan.order.length === 0) return { ...frontmatter };
  assertAsOf(options.asOf);
  const projected = { ...frontmatter };
  for (const field of plan.order) delete projected[field];

  for (const field of plan.order) {
    const entry = plan.fields.get(field);
    if (!entry) continue;
    if (entry.dependencies.some((dependency) => projected[dependency] == null)) {
      projected[field] = null;
      continue;
    }
    let value: unknown;
    try {
      value = evaluateExpression(bindToday(entry.expressionAst, options.asOf), { frontmatter: projected });
    } catch (error) {
      throw new Error(`${runtimeLabel(field, options.notePath)} evaluation failed: ${(error as Error).message}`);
    }
    assertResultType(field, entry.type, value, options.notePath);
    projected[field] = value;
  }
  return projected;
}

function collectDependencies(expression: Expression, field: string, path: string): Set<string> {
  const dependencies = new Set<string>();
  const visit = (node: Expression, isCallCallee = false): void => {
    switch (node.type) {
      case 'Identifier': {
        const name = (node as Identifier).name;
        if (name === 'file' || name === '__frontmatter') {
          throw new Error(`${path}.${field}.derived.expression: ${name} access is not supported for derived fields`);
        }
        if (!isCallCallee && !['true', 'false', 'null'].includes(name)) dependencies.add(name);
        return;
      }
      case 'CallExpression': {
        const call = node as CallExpression;
        if (call.callee.type !== 'Identifier') {
          throw new Error(`${path}.${field}.derived.expression: only named pure functions are supported`);
        }
        const name = (call.callee as Identifier).name;
        if (REJECTED_FUNCTIONS.has(name)) {
          throw new Error(`${path}.${field}.derived.expression: ${name}() is not supported for derived fields`);
        }
        if (!PURE_FUNCTIONS.has(name)) {
          throw new Error(`${path}.${field}.derived.expression: unknown or impure function ${name}()`);
        }
        for (const arg of call.arguments) visit(arg);
        return;
      }
      case 'MemberExpression': {
        const member = node as MemberExpression;
        visit(member.object);
        if (member.computed) visit(member.property);
        return;
      }
      case 'BinaryExpression':
      case 'LogicalExpression': {
        const binary = node as Expression & { left: Expression; right: Expression };
        visit(binary.left);
        visit(binary.right);
        return;
      }
      case 'UnaryExpression':
        visit((node as Expression & { argument: Expression }).argument);
        return;
      case 'Literal':
      case 'ThisExpression':
        if (node.type === 'ThisExpression') {
          throw new Error(`${path}.${field}.derived.expression: this is not supported for derived fields`);
        }
        return;
      default:
        throw new Error(`${path}.${field}.derived.expression: unsupported expression node ${node.type}`);
    }
  };
  visit(expression);
  return dependencies;
}

function bindToday(expression: Expression, asOf: string): Expression {
  if (expression.type === 'CallExpression') {
    const call = expression as CallExpression;
    if (call.callee.type === 'Identifier' && (call.callee as Identifier).name === 'today') {
      return { type: 'Literal', value: asOf, raw: JSON.stringify(asOf) } as Expression;
    }
  }
  const clone = { ...expression } as Expression & Record<string, unknown>;
  if ('left' in clone) clone.left = bindToday(clone.left as Expression, asOf);
  if ('right' in clone) clone.right = bindToday(clone.right as Expression, asOf);
  if ('argument' in clone) clone.argument = bindToday(clone.argument as Expression, asOf);
  if (expression.type === 'CallExpression') {
    clone.arguments = (expression as CallExpression).arguments.map((arg) => bindToday(arg, asOf));
  }
  if (expression.type === 'MemberExpression') {
    const member = expression as MemberExpression;
    clone.object = bindToday(member.object, asOf);
    if (member.computed) clone.property = bindToday(member.property, asOf);
  }
  return clone as Expression;
}

function assertAsOf(asOf: string): void {
  const parsed = parsePartialIsoDate(asOf);
  if (!parsed.valid || parsed.precision !== 'day') {
    throw new Error(`Derived field projection requires asOf as YYYY-MM-DD; received "${asOf}"`);
  }
}

function assertResultType(
  field: string,
  type: DerivedValueType,
  value: unknown,
  path: string | undefined
): void {
  const valid = value !== null && (
    (type === 'string' && typeof value === 'string') ||
    (type === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
    (type === 'boolean' && typeof value === 'boolean') ||
    (type === 'date' && isFullCalendarDate(value))
  );
  if (!valid) {
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    throw new Error(`${runtimeLabel(field, path)} result type mismatch: expected ${type}, received ${actual}`);
  }
}

function isFullCalendarDate(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const parsed = parsePartialIsoDate(value);
  return parsed.valid && parsed.precision === 'day';
}

function runtimeLabel(field: string, path: string | undefined): string {
  return path ? `Derived field "${field}" at ${path}` : `Derived field "${field}"`;
}
