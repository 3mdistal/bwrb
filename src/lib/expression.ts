import jsep from 'jsep';
import type { Expression, BinaryExpression, UnaryExpression, CallExpression, Identifier, Literal, MemberExpression } from 'jsep';
import { formatLocalDate } from './local-date.js';
import { FRONTMATTER_IDENTIFIER } from './where-constants.js';
import { extractLinkTargets } from './links.js';
import { resolveRelationTarget, type NoteTargetIndex } from './discovery.js';
import type { LoadedSchema } from '../types/schema.js';
import { compareCalendarDateValues, isCalendarDateValue, parseCalendarDate } from './calendar-date.js';

// Configure jsep for our expression language
jsep.addBinaryOp('&&', 2);
jsep.addBinaryOp('||', 1);
jsep.addBinaryOp('==', 6);
jsep.addBinaryOp('!=', 6);
jsep.addBinaryOp('=~', 6);
jsep.addBinaryOp('<', 7);
jsep.addBinaryOp('>', 7);
jsep.addBinaryOp('<=', 7);
jsep.addBinaryOp('>=', 7);
jsep.addUnaryOp('!');

/**
 * Hierarchy data for hierarchy-aware expression functions.
 * Built once per query and passed through context.
 */
export interface HierarchyData {
  /**
   * Map from note name to STRUCTURAL parent note name, sourced ONLY from the
   * literal `parent` frontmatter field. This is the chain walked by `isChildOf`,
   * `isDescendantOf`, and `under` (after dereferencing the relation), and it is
   * the same chain `--output tree` renders. Parent-LIKE relations (e.g.
   * `task.milestone`) are intentionally NOT folded in here — query them with the
   * `under` operator instead, and see `nonRootNames` for `isRoot`'s broader
   * notion of "attached".
   */
  parentMap: Map<string, string>;
  /**
   * Optional path-keyed structural parent map. Keys and values are vault-relative
   * note paths without `.md` (for example `Objectives/Tasks/Child`). This lets a
   * chain climb through the exact note named by a path-qualified parent link,
   * instead of collapsing duplicate intermediate basenames into one global edge.
   * The basename `parentMap` above remains the compatibility fallback for bare
   * links and direct unit-test contexts.
   */
  parentPathMap?: Map<string, string>;
  /**
   * Vault-relative note path (without `.md`) to basename. Used with
   * `parentPathMap` so path-keyed walks can still satisfy supported bare-node
   * queries such as `isDescendantOf('[[Parent]]')`.
   */
  pathNameMap?: Map<string, string>;
  /**
   * Unambiguous basename -> vault-relative note path (without `.md`). Duplicate
   * basenames are omitted so a bare link never silently chooses one duplicate.
   */
  uniquePathByName?: Map<string, string>;
  /**
   * Internal raw structural parent targets by path, populated while query builds
   * hierarchy data and resolved into `parentPathMap` after the vault snapshot is
   * available.
   */
  parentTargetByPath?: Map<string, string>;
  /** Map from note name to set of child note names (structural `parent` only). */
  childrenMap: Map<string, Set<string>>;
  /**
   * Names of notes that are NOT roots because they carry ANY parent-like note
   * link — the literal `parent`, an `owner`, or a single-valued same-ancestry
   * relation (e.g. `task.milestone`). `isRoot()` consults this set rather than
   * `parentMap`, so a task attached only via its `milestone` relation is
   * correctly not a root even though that relation is not its structural parent.
   * Built from the candidate set only (it answers a question about the candidate
   * note itself, not about ancestors elsewhere in the vault).
   *
   * Optional: when absent (e.g. a direct unit-test context that only models a
   * structural `parent` map), `isRoot` falls back to "has no structural parent"
   * via `parentMap`.
   */
  nonRootNames?: Set<string>;
  /**
   * Optional map from a declared alias to the canonical note name it resolves
   * to. Used by `under` to canonicalize aliased relation targets and aliased
   * query nodes before walking the parent chain, so aliases never silently
   * drop out of subtree queries. Built from the same alias index that drives
   * navigation (`getEntityAliases`). Ambiguous aliases (claimed by more than
   * one note) are intentionally omitted, so they resolve to nothing rather than
   * silently picking one note's subtree.
   */
  aliasMap?: Map<string, string>;
  /** Full-vault relation target index, shared with audit/validation. */
  noteTargetIndex?: NoteTargetIndex;
  /** Schema needed for source-aware relation target resolution. */
  schema?: LoadedSchema;
  /**
   * Basenames of the CANDIDATE notes being filtered/evaluated. A candidate's own
   * hierarchy identity is authoritative: the full-vault augmentation pass must
   * NOT overwrite a candidate's `parent` entry, nor invent a `parent` for a
   * parentless candidate, just because a DIFFERENT note elsewhere in the vault
   * shares its basename (`parentMap` is basename-keyed). Reserving every
   * candidate basename here keeps a parentless candidate at the root and stops a
   * same-basename note elsewhere from hijacking its hierarchy
   * (`isChildOf`/`isDescendantOf` false positives). Non-candidate intermediate
   * ancestors are NOT reserved, so the vault pass still fills chains that climb
   * through filtered-out notes (#709).
   */
  reservedNames?: Set<string>;
}

/**
 * Context for expression evaluation.
 */
export interface EvalContext {
  frontmatter: Record<string, unknown>;
  /** One immutable local-calendar observation date for the enclosing command. */
  asOf?: string;
  file?: {
    name: string;
    path: string;
    folder: string;
    ext: string;
    size?: number;
    ctime?: Date;
    mtime?: Date;
  };
  /** Optional hierarchy data for hierarchy functions (isRoot, isChildOf, isDescendantOf, under) */
  hierarchyData?: HierarchyData;
  /** Source constraints for relation fields on the current note's resolved type. */
  relationSourcesByField?: Map<string, string | string[] | undefined>;
  /** Pre-resolved one-hop targets for all()/any(). Built once by the query layer. */
  relationQuantifiers?: RelationQuantifierContext;
}

export interface RelationQuantifierTarget {
  path: string;
  frontmatter: Record<string, unknown>;
}

export interface RelationQuantifierContext {
  targetsByField: Map<string, RelationQuantifierTarget[]>;
}

const RELATION_PREDICATE_FUNCTIONS = new Set([
  'contains', 'startsWith', 'endsWith', 'lower', 'upper', 'length', 'trim', 'replace',
  'today', 'date', 'year', 'month', 'day', 'isEmpty', 'isNull', 'isDefined',
]);

/**
 * Parse an expression string into an AST.
 */
export function parseExpression(expr: string): Expression {
  try {
    return jsep(expr);
  } catch (e) {
    const error = e as Error;
    throw new Error(`Expression parse error: ${error.message}`);
  }
}

/**
 * Evaluate an expression against a context.
 */
export function evaluateExpression(expr: Expression, context: EvalContext): unknown {
  switch (expr.type) {
    case 'BinaryExpression':
      return evaluateBinary(expr as BinaryExpression, context);

    case 'UnaryExpression':
      return evaluateUnary(expr as UnaryExpression, context);

    case 'CallExpression':
      return evaluateCall(expr as CallExpression, context);

    case 'Identifier':
      return evaluateIdentifier(expr as Identifier, context);

    case 'Literal':
      return (expr as Literal).value;

    case 'MemberExpression':
      return evaluateMember(expr as MemberExpression, context);

    case 'ThisExpression':
      // 'this' refers to the current field value in constraint validation
      return context.frontmatter['this'];

    default:
      throw new Error(`Unknown expression type: ${expr.type}`);
  }
}

/**
 * Check if an expression matches a context (returns truthy value).
 */
export function matchesExpression(exprString: string, context: EvalContext): boolean {
  const expr = parseExpression(exprString);
  const result = evaluateExpression(expr, context);
  return Boolean(result);
}

/**
 * Build evaluation context for expression filtering.
 * Creates an EvalContext from a file path and its frontmatter.
 */
export async function buildEvalContext(
  filePath: string,
  vaultDir: string,
  frontmatter: Record<string, unknown>,
  asOf?: string
): Promise<EvalContext> {
  const { stat } = await import('fs/promises');
  const { basename, dirname, relative } = await import('path');

  const relativePath = relative(vaultDir, filePath);
  const fileName = basename(filePath, '.md');
  const folder = dirname(relativePath);

  let fileInfo: EvalContext['file'] = {
    name: fileName,
    path: relativePath,
    folder,
    ext: '.md',
  };

  // Try to get file stats
  try {
    const stats = await stat(filePath);
    fileInfo = {
      ...fileInfo,
      size: stats.size,
      ctime: stats.birthtime,
      mtime: stats.mtime,
    };
  } catch {
    // Ignore stat errors
  }

  return {
    frontmatter,
    ...(asOf ? { asOf } : {}),
    file: fileInfo,
  };
}

// ============================================================================
// Expression evaluators
// ============================================================================

function evaluateBinary(expr: BinaryExpression, context: EvalContext): unknown {
  const left = evaluateExpression(expr.left, context);
  const right = evaluateExpression(expr.right, context);

  switch (expr.operator) {
    case '==':
      return compareValues(left, right) === 0;
    case '!=':
      return compareValues(left, right) !== 0;
    case '=~':
      return matchesRegex(left, right);
    case '<':
      if (isEmptyComparisonOperand(left) || isEmptyComparisonOperand(right)) return false;
      return compareValues(left, right) < 0;
    case '>':
      if (isEmptyComparisonOperand(left) || isEmptyComparisonOperand(right)) return false;
      return compareValues(left, right) > 0;
    case '<=':
      if (isEmptyComparisonOperand(left) || isEmptyComparisonOperand(right)) return false;
      return compareValues(left, right) <= 0;
    case '>=':
      if (isEmptyComparisonOperand(left) || isEmptyComparisonOperand(right)) return false;
      return compareValues(left, right) >= 0;
    case '&&':
      return Boolean(left) && Boolean(right);
    case '||':
      return Boolean(left) || Boolean(right);
    case '+':
      return add(left, right);
    case '-':
      return subtract(left, right);
    case '*':
      return toNumber(left) * toNumber(right);
    case '/':
      return toNumber(left) / toNumber(right);
    default:
      throw new Error(`Unknown operator: ${expr.operator}`);
  }
}

function evaluateUnary(expr: UnaryExpression, context: EvalContext): unknown {
  const arg = evaluateExpression(expr.argument, context);

  switch (expr.operator) {
    case '!':
      return !arg;
    case '-':
      return -toNumber(arg);
    default:
      throw new Error(`Unknown unary operator: ${expr.operator}`);
  }
}

function evaluateCall(expr: CallExpression, context: EvalContext): unknown {
  const callee = expr.callee as Identifier;
  const fnName = callee.name;
  if (fnName === 'all' || fnName === 'any') {
    return evaluateRelationQuantifier(fnName, expr, context);
  }
  const args = expr.arguments.map(arg => evaluateExpression(arg, context));

  const fn = FUNCTIONS[fnName];
  if (!fn) {
    throw new Error(`Unknown function: ${fnName}`);
  }

  return fn(args, context, expr);
}

/** Validate the intentionally narrow predicate grammar used by all()/any(). */
export function getRelationQuantifierField(call: CallExpression): string {
  if (call.arguments.length !== 2) throw new Error('all()/any() expects exactly two arguments');
  const field = call.arguments[0] ? getRelationFieldNameFromExpression(call.arguments[0]) : null;
  if (!field) throw new Error('all()/any() expects a direct relation field as its first argument');
  validateRelationQuantifierPredicate(call.arguments[1]!);
  return field;
}

export function collectRelationQuantifierFields(expr: Expression): string[] {
  const fields: string[] = [];
  const visit = (node: Expression): void => {
    if (node.type === 'CallExpression') {
      const call = node as CallExpression;
      const name = call.callee.type === 'Identifier' ? (call.callee as Identifier).name : '';
      if (name === 'all' || name === 'any') fields.push(getRelationQuantifierField(call));
      for (const arg of call.arguments) visit(arg);
      return;
    }
    if (node.type === 'BinaryExpression' || node.type === 'LogicalExpression') {
      const binary = node as Expression & { left: Expression; right: Expression };
      visit(binary.left); visit(binary.right);
    } else if (node.type === 'UnaryExpression') visit((node as Expression & { argument: Expression }).argument);
    else if (node.type === 'MemberExpression') {
      const member = node as MemberExpression;
      visit(member.object); if (member.computed) visit(member.property);
    }
  };
  visit(expr);
  return fields;
}

function validateRelationQuantifierPredicate(predicate: Expression): void {
  const visit = (node: Expression, isCallee = false): void => {
    if (node.type === 'Identifier') {
      const name = (node as Identifier).name;
      if (!isCallee && !['true', 'false', 'null'].includes(name)) {
        throw new Error(`all()/any() predicate fields must use target.<field>; found "${name}"`);
      }
      return;
    }
    if (node.type === 'MemberExpression') {
      const member = node as MemberExpression;
      if (member.object.type !== 'Identifier' || (member.object as Identifier).name !== 'target') {
        throw new Error('all()/any() predicate only permits target.field access');
      }
      if (member.computed && (
        member.property.type !== 'Literal' ||
        typeof (member.property as Literal).value !== 'string'
      )) {
        throw new Error('all()/any() predicate computed target access requires a string literal');
      }
      return;
    }
    if (node.type === 'CallExpression') {
      const call = node as CallExpression;
      if (call.callee.type !== 'Identifier') throw new Error('all()/any() predicate only permits named functions');
      const name = (call.callee as Identifier).name;
      if (name === 'all' || name === 'any') throw new Error('nested all()/any() predicates are not supported');
      if (!RELATION_PREDICATE_FUNCTIONS.has(name)) {
        throw new Error(`all()/any() predicate does not permit ${name}()`);
      }
      for (const arg of call.arguments) visit(arg);
      return;
    }
    if (node.type === 'BinaryExpression' || node.type === 'LogicalExpression') {
      const binary = node as Expression & { left: Expression; right: Expression };
      visit(binary.left); visit(binary.right); return;
    }
    if (node.type === 'UnaryExpression') { visit((node as Expression & { argument: Expression }).argument); return; }
    if (node.type === 'ThisExpression') throw new Error('all()/any() predicate only permits target fields');
  };
  visit(predicate);
}

function evaluateRelationQuantifier(kind: 'all' | 'any', call: CallExpression, context: EvalContext): boolean {
  const field = getRelationQuantifierField(call);
  const targets = context.relationQuantifiers?.targetsByField.get(field);
  if (!targets) throw new Error(`all()/any() relation context is unavailable for field "${field}"`);
  if (targets.length === 0) return kind === 'all';
  for (const target of targets) {
    const value = evaluateExpression(call.arguments[1]!, { ...context, frontmatter: { target: target.frontmatter } });
    if (typeof value !== 'boolean') throw new Error(`all()/any() predicate for "${field}" must return boolean`);
    if (kind === 'all' && !value) return false;
    if (kind === 'any' && value) return true;
  }
  return kind === 'all';
}

function evaluateIdentifier(expr: Identifier, context: EvalContext): unknown {
  const name = expr.name;

  // Check for special identifiers
  if (name === 'true') return true;
  if (name === 'false') return false;
  if (name === 'null') return null;

  // Special 'file' object
  if (name === 'file') return context.file;
  if (name === FRONTMATTER_IDENTIFIER) return context.frontmatter;

  if (name === 'name' && context.frontmatter['name'] === undefined) {
    return context.file?.name;
  }

  // Look up in frontmatter
  return context.frontmatter[name];
}

function evaluateMember(expr: MemberExpression, context: EvalContext): unknown {
  const obj = evaluateExpression(expr.object, context);
  const prop = expr.computed
    ? evaluateExpression(expr.property, context)
    : (expr.property as Identifier).name;

  if (obj === null || obj === undefined) {
    return undefined;
  }

  // Handle property access on objects
  if (typeof obj === 'object') {
    return (obj as Record<string, unknown>)[String(prop)];
  }

  return undefined;
}

// ============================================================================
// Built-in functions
// ============================================================================

type FunctionImpl = (args: unknown[], context: EvalContext, call?: CallExpression) => unknown;

const FUNCTIONS: Record<string, FunctionImpl> = {
  // String functions
  contains: (args) => {
    const [str, substr] = args;
    if (Array.isArray(str)) {
      return str.includes(substr);
    }
    return String(str ?? '').includes(String(substr ?? ''));
  },

  startsWith: (args) => {
    const [str, prefix] = args;
    return String(str ?? '').startsWith(String(prefix ?? ''));
  },

  endsWith: (args) => {
    const [str, suffix] = args;
    return String(str ?? '').endsWith(String(suffix ?? ''));
  },

  lower: (args) => String(args[0] ?? '').toLowerCase(),

  upper: (args) => String(args[0] ?? '').toUpperCase(),

  length: (args) => {
    const val = args[0];
    if (Array.isArray(val)) return val.length;
    return String(val ?? '').length;
  },

  trim: (args) => String(args[0] ?? '').trim(),

  replace: (args) => {
    const [str, oldVal, newVal] = args;
    return String(str ?? '').replace(String(oldVal ?? ''), String(newVal ?? ''));
  },

  // Date functions
  today: (_args, context) => {
    return context.asOf ?? formatLocalDate();
  },

  now: () => new Date(),

  date: (args) => {
    const str = args[0];
    if (str instanceof Date) return str;
    return new Date(String(str));
  },

  year: (args) => toDate(args[0]).getFullYear(),

  month: (args) => toDate(args[0]).getMonth() + 1,

  day: (args) => toDate(args[0]).getDate(),

  // Null/empty functions
  isEmpty: (args) => {
    const val = args[0];
    if (val === null || val === undefined) return true;
    if (val === '') return true;
    if (Array.isArray(val) && val.length === 0) return true;
    return false;
  },

  isNull: (args) => args[0] === null || args[0] === undefined,

  isDefined: (args) => args[0] !== undefined,

  // File functions (require context)
  inFolder: (args, context) => {
    const folder = String(args[0]);
    return context.file?.folder?.startsWith(folder) ?? false;
  },

  hasTag: (args, context) => {
    const tag = String(args[0]);
    const tags = context.frontmatter.tags;
    if (Array.isArray(tags)) {
      return tags.includes(tag);
    }
    return false;
  },

  // Hierarchy functions (require hierarchyData in context)
  /**
   * Check if the current note is a root (has no parent).
   * Returns false if hierarchyData is not available.
   */
  isRoot: (_args, context) => {
    const noteName = context.file?.name;
    if (!noteName || !context.hierarchyData) return false;
    // A note is a root when it has NO parent-like note link of any kind — not
    // just no structural `parent`. `nonRootNames` captures the broader notion
    // (parent / owner / single-valued same-ancestry relation), so a task
    // attached only via its `milestone` relation is correctly not a root. When
    // `nonRootNames` is absent (a minimal context), fall back to the structural
    // `parent` map.
    const nonRootNames = context.hierarchyData.nonRootNames;
    if (nonRootNames) return !nonRootNames.has(noteName);
    return !context.hierarchyData.parentMap.has(noteName);
  },

  /**
   * Check if the current note is a direct child of the specified note.
   * Accepts wikilink format: isChildOf('[[Parent Note]]') or plain: isChildOf('Parent Note')
   *
   * Aliases are canonicalized on BOTH sides via `hierarchyData.aliasMap` (the
   * same machinery `under` uses, #636/#659): if the note's own `parent` value is
   * written as an alias of the real parent, it resolves to the canonical note
   * before comparison, and an aliased query node likewise resolves to its
   * canonical note. Canonical names pass through untouched, so non-aliased
   * hierarchies behave exactly as before. An ambiguous alias is never in the map
   * (the query layer drops it), so it stays literal and simply fails to match.
   */
  isChildOf: (args, context) => {
    const aliasMap = context.hierarchyData?.aliasMap;
    const targetParent = canonicalizeAlias(
      extractNoteNameFromArg(String(args[0] ?? '')),
      aliasMap
    );
    const noteName = context.file?.name;
    const notePath = normalizeNotePath(context.file?.path);
    if (!noteName || !targetParent || !context.hierarchyData) return false;
    const parent = getHierarchyParent(noteName, notePath, context.hierarchyData, aliasMap);
    if (!parent) return false;
    return hierarchyNodeMatches(parent, targetParent, context.hierarchyData);
  },

  /**
   * Check if the current note is a descendant (at any depth) of the specified note.
   * Accepts wikilink format: isDescendantOf('[[Ancestor]]') or plain: isDescendantOf('Ancestor')
   *
   * Aliases are canonicalized on BOTH sides via `hierarchyData.aliasMap` (the
   * same machinery `under` uses, #636/#659): each step of the note's own
   * `parent` chain is resolved through the alias map as it is walked, and the
   * query node is resolved too, so an aliased link anywhere in the chain (or an
   * aliased query node) still matches the true ancestor instead of silently
   * missing. Cycle-safe and case-preserving exactly as before.
   */
  isDescendantOf: (args, context) => {
    const aliasMap = context.hierarchyData?.aliasMap;
    const targetAncestor = canonicalizeAlias(
      extractNoteNameFromArg(String(args[0] ?? '')),
      aliasMap
    );
    const noteName = context.file?.name;
    const notePath = normalizeNotePath(context.file?.path);
    if (!noteName || !targetAncestor || !context.hierarchyData) return false;

    // Walk up the CURRENT note's own parent chain checking for the target.
    const startParent = getHierarchyParent(
      noteName,
      notePath,
      context.hierarchyData,
      aliasMap
    );
    if (!startParent) return false;
    return ancestorChainContains(
      startParent.name,
      targetAncestor,
      context.hierarchyData.parentMap,
      aliasMap,
      context.hierarchyData,
      startParent.path
    );
  },

  /**
   * Dereference a RELATION FIELD on the current note, then walk each target's
   * own ancestor (`parent`) chain, returning true if the given node is the
   * target itself or anywhere in that chain (at any depth).
   *
   * Distinct from `isDescendantOf`, which walks the *current note's own* parent
   * chain. `under` follows a field to ANOTHER note, then walks THAT note's
   * ancestors. Generalizes to any relation field, not just `context`.
   *
   * Usage: under(context, '[[career]]')
   *   - args[0]: the relation field value(s) (e.g. the value of `context`,
   *     which may be a single wikilink/markdown link or a list of them)
   *   - args[1]: the node to test for, in wikilink or plain form
   *
   * Semantics are INCLUSIVE of the direct target: `under(context, '[[career]]')`
   * matches notes whose `context` is `[[career]]` itself OR any descendant of
   * career. For multi-valued relation fields, matches if ANY target is under
   * the node.
   *
   * Aliases are canonicalized on BOTH sides via `hierarchyData.aliasMap`: an
   * aliased relation target (e.g. `[[BuilderProject]]`, an alias of `Builder`)
   * resolves to its canonical note so its ancestor chain is walked, and an
   * aliased query node resolves to the canonical note so subtree matching works.
   * This makes `under` consistent with canonical alias resolution. A dangling alias
   * (claimed by no note) or an ambiguous alias (claimed by several) is left
   * as-is, so it simply fails to match rather than crashing or guessing.
   */
  under: (args, context, call) => {
    const relationField = call?.arguments[0]
      ? getRelationFieldNameFromExpression(call.arguments[0])
      : null;
    const relationSource = relationField
      ? context.relationSourcesByField?.get(relationField)
      : undefined;
    const aliasMap = context.hierarchyData?.aliasMap;
    const queryTarget = resolveHierarchyQueryTarget(
      extractNoteNameFromArg(String(args[1] ?? '')),
      context,
      relationSource
    );
    const targetNode = queryTarget
      ? canonicalizeAlias(noteNameFromTarget(queryTarget.target), aliasMap)
      : null;
    if (!targetNode || !context.hierarchyData) return false;

    // Resolve the relation field value(s) to note names. extractLinkTargets
    // handles single values, arrays, wikilinks, and markdown links uniformly.
    const relationTargets = extractLinkTargets(args[0]);
    if (relationTargets.length === 0) return false;

    const parentMap = context.hierarchyData.parentMap;
    for (const rawTarget of relationTargets) {
      const resolved = resolveHierarchyRelationTarget(rawTarget, context, relationSource);
      const relationTarget = canonicalizeAlias(noteNameFromTarget(resolved.target), aliasMap);
      if (!relationTarget) continue;
      const relationTargetPath = resolved.path ?? resolveHierarchyPath(rawTarget, context.hierarchyData);
      // Inclusive of the direct target (depth 0).
      if (
        hierarchyNodeMatches(
          hierarchyNode(relationTarget, relationTargetPath),
          queryTarget?.path ?? targetNode,
          context.hierarchyData
        )
      ) {
        return true;
      }
      // Otherwise walk the target's own ancestor chain. Pass the alias map so a
      // mid-chain `parent` written as an alias still resolves while walking.
      if (
        ancestorChainContains(
          relationTarget,
          queryTarget?.path ?? targetNode,
          parentMap,
          aliasMap,
          context.hierarchyData,
          relationTargetPath
        )
      ) {
        return true;
      }
    }
    return false;
  },
};

function resolveHierarchyQueryTarget(
  rawTarget: string | null,
  context: EvalContext,
  source: string | string[] | undefined
): { target: string; path?: string } | null {
  if (!rawTarget) return null;

  const index = context.hierarchyData?.noteTargetIndex;
  const schema = context.hierarchyData?.schema;
  if (!index || !schema) {
    return { target: rawTarget };
  }

  const resolved = resolveRelationTarget(index, rawTarget, { schema, source });
  if (!resolved.resolvedPath) {
    return null;
  }

  const path = resolved.resolvedPath.replace(/\.md$/, '');
  return {
    target: path,
    path,
  };
}

function resolveHierarchyRelationTarget(
  rawTarget: string,
  context: EvalContext,
  source: string | string[] | undefined
): { target: string; path?: string } {
  const index = context.hierarchyData?.noteTargetIndex;
  const schema = context.hierarchyData?.schema;
  if (!index || !schema) {
    return { target: rawTarget };
  }

  const resolved = resolveRelationTarget(index, rawTarget, { schema, source });
  if (!resolved.resolvedPath) {
    return { target: rawTarget };
  }

  const path = resolved.resolvedPath.replace(/\.md$/, '');
  return {
    target: path,
    path,
  };
}

function getRelationFieldNameFromExpression(expr: Expression): string | null {
  if (expr.type === 'Identifier') {
    return (expr as Identifier).name;
  }

  if (expr.type !== 'MemberExpression') {
    return null;
  }

  const member = expr as MemberExpression;
  if (member.object.type !== 'Identifier') {
    return null;
  }
  if ((member.object as Identifier).name !== FRONTMATTER_IDENTIFIER) {
    return null;
  }

  if (member.computed && member.property.type === 'Literal') {
    const value = (member.property as Literal).value;
    return typeof value === 'string' ? value : null;
  }

  if (!member.computed && member.property.type === 'Identifier') {
    return (member.property as Identifier).name;
  }

  return null;
}

/**
 * Resolve a note name through the alias map, if present.
 *
 * If `name` is a declared alias that unambiguously resolves to a canonical note,
 * return that canonical name; otherwise return `name` unchanged. A real note
 * name always wins over an alias (the alias map never contains keys that shadow
 * real notes), so canonical names pass through untouched.
 */
function canonicalizeAlias(
  name: string | null,
  aliasMap: Map<string, string> | undefined
): string | null {
  if (!name) return name;
  if (!aliasMap) return name;
  return aliasMap.get(name) ?? name;
}

/**
 * Walk a parent chain starting from `start`, returning true if `target` is
 * found anywhere in that chain. Cycle-safe via a visited set, so a malformed
 * `parent` cycle never causes an infinite loop.
 *
 * Each step is canonicalized through `aliasMap` (when provided) before it is
 * compared and used to look up the next parent, so a `parent` value written as
 * an alias of the real note still resolves to the canonical note and continues
 * the walk (#636/#659). `target` is expected to be already canonical (callers
 * canonicalize the query node). Canonical names pass through untouched, so a
 * walk with no alias map — or over a fully canonical chain — is unchanged. The
 * visited set tracks canonical names, keeping cycle detection correct even when
 * aliases and canonical names are mixed in the same chain.
 */
function ancestorChainContains(
  start: string,
  target: string,
  parentMap: Map<string, string>,
  aliasMap?: Map<string, string>,
  hierarchyData?: HierarchyData,
  startPath?: string
): boolean {
  const visited = new Set<string>();
  const data = hierarchyData ?? { parentMap, childrenMap: new Map<string, Set<string>>() };
  let current: HierarchyNode | undefined = hierarchyNode(
    canonicalizeAlias(noteNameFromTarget(start), aliasMap) ?? noteNameFromTarget(start),
    startPath ?? resolveHierarchyPath(start, hierarchyData)
  );
  while (current && !visited.has(hierarchyVisitKey(current))) {
    if (hierarchyNodeMatches(current, target, hierarchyData)) return true;
    visited.add(hierarchyVisitKey(current));
    current = getHierarchyParent(current.name, current.path, data, aliasMap);
  }
  return false;
}

interface HierarchyNode {
  name: string;
  path?: string;
}

function getHierarchyParent(
  noteName: string,
  notePath: string | undefined,
  hierarchyData: HierarchyData,
  aliasMap?: Map<string, string>
): HierarchyNode | undefined {
  const pathParent = notePath ? hierarchyData.parentPathMap?.get(notePath) : undefined;
  if (pathParent) {
    return {
      name: canonicalizeAlias(
        hierarchyData.pathNameMap?.get(pathParent) ?? noteNameFromTarget(pathParent),
        aliasMap
      ) ?? noteNameFromTarget(pathParent),
      path: pathParent,
    };
  }

  const rawParent = hierarchyData.parentMap.get(noteName);
  if (rawParent === undefined) return undefined;
  const parentName = canonicalizeAlias(noteNameFromTarget(rawParent), aliasMap) ?? noteNameFromTarget(rawParent);
  return hierarchyNode(parentName, resolveHierarchyPath(rawParent, hierarchyData));
}

function hierarchyNode(name: string, path: string | undefined): HierarchyNode {
  return path ? { name, path } : { name };
}

function hierarchyNodeMatches(
  node: HierarchyNode,
  target: string,
  hierarchyData?: HierarchyData
): boolean {
  const targetPath = resolveHierarchyPath(target, hierarchyData);
  if (targetPath && node.path === targetPath) return true;
  return node.name === noteNameFromTarget(target);
}

function resolveHierarchyPath(
  target: string | undefined,
  hierarchyData: HierarchyData | undefined
): string | undefined {
  if (!target || !hierarchyData) return undefined;
  const normalized = normalizeNotePath(target);
  if (!normalized) return undefined;
  if (normalized.includes('/')) {
    return hierarchyData.pathNameMap?.has(normalized) ? normalized : undefined;
  }
  return hierarchyData.uniquePathByName?.get(normalized);
}

function normalizeNotePath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const target = value.replace(/\\/g, '/').replace(/\.md$/i, '').trim();
  return target || undefined;
}

function noteNameFromTarget(target: string): string {
  const normalized = normalizeNotePath(target) ?? target;
  const parts = normalized.split('/');
  return parts[parts.length - 1] ?? normalized;
}

function hierarchyVisitKey(node: HierarchyNode): string {
  return node.path ? `path:${node.path}` : `name:${node.name}`;
}

/**
 * Extract a note name from an argument that may be in wikilink format.
 * Handles: '[[Note Name]]', "[[Note Name]]", '[[Note Name]]', or plain 'Note Name'
 */
function extractNoteNameFromArg(value: string): string | null {
  if (!value) return null;
  // Match wikilink format: [[Note Name]]
  const match = value.match(/\[\[([^\]]+)\]\]/);
  if (match) return match[1] ?? null;
  // Plain note name
  return value.trim() || null;
}

// ============================================================================
// Type coercion and comparison
// ============================================================================

function toNumber(val: unknown): number {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    // Check for duration literal
    const duration = parseDuration(val);
    if (duration !== null) return duration;
    return parseFloat(val) || 0;
  }
  if (val instanceof Date) return val.getTime();
  return 0;
}

function toDate(val: unknown): Date {
  if (val instanceof Date) return val;
  if (typeof val === 'string') return new Date(val);
  if (typeof val === 'number') return new Date(val);
  return new Date();
}

function compareValues(a: unknown, b: unknown): number {
  // Handle null/undefined
  if (a === null || a === undefined) {
    return b === null || b === undefined ? 0 : -1;
  }
  if (b === null || b === undefined) {
    return 1;
  }

  if (isCalendarDateValue(a) || isCalendarDateValue(b)) {
    if (isCalendarDateValue(a) && isCalendarDateValue(b)) {
      return compareCalendarDateValues(a, b) ?? Number.NaN;
    }
    if (isCalendarDateValue(a) && typeof b === 'string' && a.calendarDef) {
      const parsed = parseCalendarDate(b, a.calendar, a.calendarDef);
      return parsed.valid ? a.linear - parsed.date.linear : Number.NaN;
    }
    if (isCalendarDateValue(b) && typeof a === 'string' && b.calendarDef) {
      const parsed = parseCalendarDate(a, b.calendar, b.calendarDef);
      return parsed.valid ? parsed.date.linear - b.linear : Number.NaN;
    }
    return Number.NaN;
  }

  // Handle dates
  if (a instanceof Date || b instanceof Date) {
    const dateA = toDate(a);
    const dateB = toDate(b);
    return dateA.getTime() - dateB.getTime();
  }

  // Handle numbers
  if (typeof a === 'number' || typeof b === 'number') {
    return toNumber(a) - toNumber(b);
  }

  // Handle strings (including duration comparison)
  const strA = String(a);
  const strB = String(b);

  // Check if either is a duration literal
  const durA = parseDuration(strA);
  const durB = parseDuration(strB);
  if (durA !== null || durB !== null) {
    return (durA ?? 0) - (durB ?? 0);
  }

  // Regular string comparison
  return strA.localeCompare(strB);
}

function isEmptyComparisonOperand(value: unknown): boolean {
  return value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0);
}

function matchesRegex(value: unknown, pattern: unknown): boolean {
  const raw = String(pattern ?? '');
  if (!raw) return false;

  let regex: RegExp;
  if (raw.startsWith('/') && raw.lastIndexOf('/') > 0) {
    const lastSlash = raw.lastIndexOf('/');
    const body = raw.slice(1, lastSlash);
    const flags = raw.slice(lastSlash + 1);
    regex = new RegExp(body, flags);
  } else {
    regex = new RegExp(raw);
  }

  return regex.test(String(value ?? ''));
}

/**
 * Add two values, handling dates and durations.
 */
function add(left: unknown, right: unknown): unknown {
  // Date + duration
  if (left instanceof Date || (typeof left === 'string' && isDateString(left))) {
    const date = toDate(left);
    const duration = typeof right === 'string' ? parseDuration(right) : null;
    if (duration !== null) {
      return new Date(date.getTime() + duration);
    }
  }

  // String + duration (date string)
  if (typeof left === 'string' && typeof right === 'string') {
    const leftDur = parseDuration(left);
    const rightDur = parseDuration(right);
    if (leftDur !== null && rightDur !== null) {
      return leftDur + rightDur;
    }
  }

  // Numeric addition
  return toNumber(left) + toNumber(right);
}

/**
 * Subtract two values, handling dates and durations.
 */
function subtract(left: unknown, right: unknown): unknown {
  // Date - duration
  if (left instanceof Date || (typeof left === 'string' && isDateString(left))) {
    const date = toDate(left);
    const duration = typeof right === 'string' ? parseDuration(right) : null;
    if (duration !== null) {
      return new Date(date.getTime() - duration);
    }
  }

  // Numeric subtraction
  return toNumber(left) - toNumber(right);
}

/**
 * Parse a duration literal (e.g., '7d', '1w', '2h') into milliseconds.
 * 
 * Supported units:
 * - min: minutes
 * - h: hours
 * - d: days
 * - w: weeks
 * - mon: months (30 days)
 * - y: years (365 days)
 */
export function parseDuration(str: string): number | null {
  const match = str.match(/^'?(\d+)(min|h|d|w|mon|y)'?$/);
  if (!match) return null;

  const value = parseInt(match[1] ?? '0', 10);
  const unit = match[2];

  const MS_PER: Record<string, number> = {
    min: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
    mon: 30 * 24 * 60 * 60 * 1000,
    y: 365 * 24 * 60 * 60 * 1000,
  };

  const multiplier = unit ? MS_PER[unit] : 0;
  return multiplier ? value * multiplier : null;
}

/**
 * Check if a string looks like a date (YYYY-MM-DD format).
 */
function isDateString(str: string): boolean {
  return /^\d{4}-\d{2}-\d{2}/.test(str);
}
