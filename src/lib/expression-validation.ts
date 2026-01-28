/**
 * Expression validation for --where filters.
 *
 * This module validates select field values in filter expressions against
 * the schema. When --type is specified, we can validate that comparison
 * values match the allowed options for select fields.
 */

import type { Expression, BinaryExpression, UnaryExpression, CallExpression, Identifier, Literal, MemberExpression } from 'jsep';
import { parseExpression } from './expression.js';
import type { LoadedSchema, Field } from '../types/schema.js';
import { getFieldsForType, getAllFieldsForType } from './schema.js';
import { suggestOptionValue, suggestFieldName } from './validation.js';
import { normalizeWhereExpression } from './where-normalize.js';
import { FRONTMATTER_IDENTIFIER } from './where-constants.js';

// ============================================================================
// Types
// ============================================================================

/**
 * A field comparison extracted from an expression.
 */
export interface FieldComparison {
  /** The field name being compared */
  field: string;
  /** The comparison operator (==, !=, contains, etc.) */
  operator: string;
  /** The literal value being compared against (null if not a literal) */
  value: string | null;
}

/**
 * A single validation error for a --where expression.
 */
export interface WhereValidationError {
  /** The original expression string */
  expression: string;
  /** The field that has an invalid value */
  field: string;
  /** The invalid value */
  value: string;
  /** Human-readable error message */
  message: string;
  /** List of valid options for this field */
  validOptions: string[];
  /** Suggested correction (if a close match exists) */
  suggestion?: string;
}

/**
 * Result of validating --where expressions.
 */
export interface WhereValidationResult {
  /** Whether all expressions are valid */
  valid: boolean;
  /** List of validation errors */
  errors: WhereValidationError[];
}

// ============================================================================
// Expression Analysis
// ============================================================================

/**
 * Extract field comparisons from a parsed expression.
 * Walks the AST to find patterns like:
 * - field == 'value'
 * - field != 'value'
 * - contains(field, 'value')
 */
export function extractFieldComparisons(expr: Expression): FieldComparison[] {
  const comparisons: FieldComparison[] = [];

  function walk(node: Expression): void {
    switch (node.type) {
      case 'BinaryExpression': {
        const binary = node as BinaryExpression;

        // Handle comparison operators: ==, !=
        if (binary.operator === '==' || binary.operator === '!=') {
          const comparison = extractBinaryComparison(binary);
          if (comparison) {
            comparisons.push(comparison);
          }
        }

        // Handle logical operators: &&, ||
        if (binary.operator === '&&' || binary.operator === '||') {
          walk(binary.left);
          walk(binary.right);
        }
        break;
      }

      case 'CallExpression': {
        const call = node as CallExpression;
        const comparison = extractCallComparison(call);
        if (comparison) {
          comparisons.push(comparison);
        }
        break;
      }

      case 'UnaryExpression': {
        // Handle !expression
        const unary = node as UnaryExpression;
        walk(unary.argument);
        break;
      }
    }
  }

  walk(expr);
  return comparisons;
}

/**
 * Extract a comparison from a binary expression (field == 'value').
 */
function extractBinaryComparison(expr: BinaryExpression): FieldComparison | null {
  let field: string | null = null;
  let value: string | null = null;

  // Check if left is identifier and right is literal
  if (expr.right.type === 'Literal') {
    field = getFieldName(expr.left);
    value = getLiteralValue(expr.right as Literal);
  } else if (expr.left.type === 'Literal') {
    field = getFieldName(expr.right);
    value = getLiteralValue(expr.left as Literal);
  }

  if (field && value !== null) {
    return { field, operator: expr.operator, value };
  }

  return null;
}

/**
 * Extract a comparison from a function call (contains(field, 'value')).
 */
function extractCallComparison(expr: CallExpression): FieldComparison | null {
  const callee = expr.callee as Identifier;
  if (!callee || callee.type !== 'Identifier') return null;

  const fnName = callee.name;

  // Handle contains(field, 'value') pattern
  if (fnName === 'contains' && expr.arguments.length >= 2) {
    const [arg1, arg2] = expr.arguments;
    const fieldName = arg1 ? getFieldName(arg1) : null;
    if (fieldName && arg2?.type === 'Literal') {
      return {
        field: fieldName,
        operator: 'contains',
        value: getLiteralValue(arg2 as Literal),
      };
    }
  }

  // Handle hasTag('value') pattern - tags is implicit
  if (fnName === 'hasTag' && expr.arguments.length >= 1) {
    const [arg] = expr.arguments;
    if (arg?.type === 'Literal') {
      return {
        field: 'tags',
        operator: 'hasTag',
        value: getLiteralValue(arg as Literal),
      };
    }
  }

  return null;
}

/**
 * Get the string value from a literal node.
 */
function getLiteralValue(literal: Literal): string | null {
  const val = literal.value;
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return String(val);
  if (typeof val === 'boolean') return String(val);
  return null;
}

function getFieldName(node: Expression): string | null {
  if (node.type === 'Identifier') {
    return (node as Identifier).name;
  }

  if (node.type !== 'MemberExpression') {
    return null;
  }

  const member = node as MemberExpression;
  if (member.object.type !== 'Identifier') {
    return null;
  }

  const objectName = (member.object as Identifier).name;
  if (objectName !== FRONTMATTER_IDENTIFIER) {
    return null;
  }

  if (member.computed && member.property.type === 'Literal') {
    const literalValue = (member.property as Literal).value;
    return typeof literalValue === 'string' ? literalValue : null;
  }

  if (!member.computed && member.property.type === 'Identifier') {
    return (member.property as Identifier).name;
  }

  return null;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate --where expressions against a schema type.
 *
 * When a type is specified, this validates that:
 * 1. Fields with select options use valid option values
 * 2. Invalid values get helpful error messages with suggestions
 *
 * @param expressions - Array of --where expression strings
 * @param schema - The loaded schema
 * @param typeName - The type to validate against
 * @returns Validation result with any errors
 */
export function validateWhereExpressions(
  expressions: string[],
  schema: LoadedSchema,
  typeName: string
): WhereValidationResult {
  const errors: WhereValidationError[] = [];
  const fields = getFieldsForType(schema, typeName);
  const allFieldNames = getAllFieldsForType(schema, typeName);

  for (const exprString of expressions) {
    try {
      const normalized = normalizeWhereExpression(exprString, allFieldNames);
      const expr = parseExpression(normalized);
      const comparisons = extractFieldComparisons(expr);

      for (const comparison of comparisons) {
        // Skip if no literal value to validate
        if (comparison.value === null) continue;

        // Error if field is not in this type's schema (strict mode when type is specified)
        if (!allFieldNames.has(comparison.field)) {
          const fieldList = Array.from(allFieldNames);
          const suggestion = suggestFieldName(comparison.field, fieldList);
          errors.push({
            expression: exprString,
            field: comparison.field,
            value: comparison.value ?? '',
            message: `Unknown field '${comparison.field}' for type '${typeName}'`,
            validOptions: fieldList,
            ...(suggestion && { suggestion }),
          });
          continue;
        }

        // Get the field definition
        const field = fields[comparison.field];
        if (!field) continue;

        // Only validate fields with options (select fields)
        if (!field.options || field.options.length === 0) continue;

        // Validate the value against options
        const error = validateFieldValue(
          exprString,
          comparison.field,
          comparison.value,
          field
        );

        if (error) {
          errors.push(error);
        }
      }
    } catch {
      // Parse errors are handled separately by the expression evaluator
      // We skip validation for unparseable expressions
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate a single field value against its options.
 */
function validateFieldValue(
  expression: string,
  fieldName: string,
  value: string,
  field: Field
): WhereValidationError | null {
  const options = field.options ?? [];
  if (options.length === 0) return null;

  // Check if value is valid
  if (options.includes(value)) {
    return null; // Valid
  }

  // Invalid value - build error with suggestion
  const suggestion = suggestOptionValue(value, options);

  return {
    expression,
    field: fieldName,
    value,
    message: `Invalid value '${value}' for field '${fieldName}'`,
    validOptions: options,
    ...(suggestion && { suggestion }),
  };
}

/**
 * Format validation errors for human-readable output.
 */
export function formatWhereValidationErrors(errors: WhereValidationError[]): string {
  if (errors.length === 0) return '';

  if (errors.length === 1) {
    const err = errors[0]!;
    let msg = `Error: ${err.message}.\n`;
    msg += `  Valid options: ${err.validOptions.join(', ')}`;
    if (err.suggestion) {
      msg += `\n  Did you mean '${err.suggestion}'?`;
    }
    return msg;
  }

  const lines: string[] = ['Expression validation errors:'];
  for (const err of errors) {
    let line = `  - ${err.message}`;
    if (err.validOptions.length <= 5) {
      line += `. Valid options: ${err.validOptions.join(', ')}`;
    } else {
      line += `. Valid options: ${err.validOptions.slice(0, 5).join(', ')}... (${err.validOptions.length} total)`;
    }
    if (err.suggestion) {
      line += ` Did you mean '${err.suggestion}'?`;
    }
    lines.push(line);
  }

  return lines.join('\n');
}
