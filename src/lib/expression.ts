import jsep from 'jsep';
import type { Expression, BinaryExpression, UnaryExpression, CallExpression, Identifier, Literal, MemberExpression } from 'jsep';

// Configure jsep for our expression language
jsep.addBinaryOp('&&', 2);
jsep.addBinaryOp('||', 1);
jsep.addBinaryOp('==', 6);
jsep.addBinaryOp('!=', 6);
jsep.addBinaryOp('<', 7);
jsep.addBinaryOp('>', 7);
jsep.addBinaryOp('<=', 7);
jsep.addBinaryOp('>=', 7);
jsep.addUnaryOp('!');

/**
 * Context for expression evaluation.
 */
export interface EvalContext {
  frontmatter: Record<string, unknown>;
  file?: {
    name: string;
    path: string;
    folder: string;
    ext: string;
    size?: number;
    ctime?: Date;
    mtime?: Date;
  };
}

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
  frontmatter: Record<string, unknown>
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
    case '<':
      return compareValues(left, right) < 0;
    case '>':
      return compareValues(left, right) > 0;
    case '<=':
      return compareValues(left, right) <= 0;
    case '>=':
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
  const args = expr.arguments.map(arg => evaluateExpression(arg, context));

  const fn = FUNCTIONS[fnName];
  if (!fn) {
    throw new Error(`Unknown function: ${fnName}`);
  }

  return fn(args, context);
}

function evaluateIdentifier(expr: Identifier, context: EvalContext): unknown {
  const name = expr.name;

  // Check for special identifiers
  if (name === 'true') return true;
  if (name === 'false') return false;
  if (name === 'null') return null;

  // Special 'file' object
  if (name === 'file') return context.file;

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

type FunctionImpl = (args: unknown[], context: EvalContext) => unknown;

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
  today: () => {
    const now = new Date();
    return now.toISOString().split('T')[0];
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
};

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
