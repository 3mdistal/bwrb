/**
 * Expression validation for --where filters.
 *
 * This module validates select field values in filter expressions against
 * the schema. When --type is specified, we can validate that comparison
 * values match the allowed options for select fields.
 */

import type { Expression, BinaryExpression, UnaryExpression, CallExpression, Identifier, Literal, MemberExpression } from 'jsep';
import { parseExpression } from './expression.js';
import type { LoadedSchema } from '../types/schema.js';
import { getFieldsForType, getAllFieldsForType, getFieldOptions } from './schema.js';
import type { Field } from '../types/schema.js';
import { validateSelectOptionValue, suggestFieldName } from './validation.js';
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
 * Extract the field-name references passed as the FIRST argument to `under(...)`.
 *
 * `under(field, '[[Node]]')` dereferences a relation FIELD (arg 0) and walks the
 * target's ancestor chain; arg 1 is a node string, NOT a field. We collect only
 * arg 0 so it can be validated against the schema (must exist, must be a relation
 * field). The node string is deliberately ignored here.
 */
function extractUnderFieldRefs(expr: Expression): string[] {
  const fields: string[] = [];

  function walk(node: Expression): void {
    switch (node.type) {
      case 'BinaryExpression': {
        const binary = node as BinaryExpression;
        if (binary.operator === '&&' || binary.operator === '||') {
          walk(binary.left);
          walk(binary.right);
        }
        break;
      }
      case 'UnaryExpression': {
        walk((node as UnaryExpression).argument);
        break;
      }
      case 'CallExpression': {
        const call = node as CallExpression;
        const callee = call.callee as Identifier;
        if (callee?.type === 'Identifier' && callee.name === 'under') {
          const [arg1] = call.arguments;
          // Only the first argument is a field reference; the second is a node.
          const fieldName = arg1 ? getFieldName(arg1) : null;
          if (fieldName) fields.push(fieldName);
        }
        // `under` is never nested inside another call's args in practice, but
        // walk any call arguments that are themselves logical/call expressions
        // so a future `... && under(...)` inside a call still gets validated.
        for (const arg of call.arguments) {
          walk(arg);
        }
        break;
      }
    }
  }

  walk(expr);
  return fields;
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
  const allowedFields = new Set<string>([...allFieldNames, 'id', 'name', 'type']);

  for (const exprString of expressions) {
    try {
      const normalized = normalizeWhereExpression(exprString, allFieldNames);
      const expr = parseExpression(normalized);

      // Validate the FIRST argument of any `under(field, '[[Node]]')` call: it
      // must be a known field on the type, and a relation-typed field (since
      // `under` dereferences a relation). The node string (arg 2) is not a field
      // and is not validated here.
      for (const underField of extractUnderFieldRefs(expr)) {
        const underError = validateUnderFieldRef(
          exprString,
          underField,
          typeName,
          allowedFields,
          fields
        );
        if (underError) errors.push(underError);
      }

      const comparisons = extractFieldComparisons(expr);

      for (const comparison of comparisons) {
        // Skip if no literal value to validate
        if (comparison.value === null) continue;

        // Error if field is not in this type's schema (strict mode when type is specified)
        if (!allowedFields.has(comparison.field)) {
          const fieldList = Array.from(allowedFields);
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
        const validOptions = getFieldOptions(field);
        if (validOptions.length === 0) continue;

        // Validate the value against options
        const error = validateFieldValue(
          exprString,
          comparison.field,
          comparison.value,
          validOptions
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
 * Validate the first argument of an `under(field, ...)` call.
 *
 * Returns an error when:
 * - the field is unknown for the type (consistent with how other field
 *   references are flagged when `--type` is known), or
 * - the field exists but is not a relation field (so `under` would have nothing
 *   to dereference).
 *
 * Returns null when the field is a valid relation field, or when the field
 * definition isn't available to inspect (e.g. inherited/synthetic fields whose
 * `prompt` we can't see) — we only flag what we can verify, to avoid breaking
 * valid usage.
 */
function validateUnderFieldRef(
  expression: string,
  fieldName: string,
  typeName: string,
  allowedFields: Set<string>,
  fields: Record<string, Field>
): WhereValidationError | null {
  // Unknown field for this type.
  if (!allowedFields.has(fieldName)) {
    const fieldList = Array.from(allowedFields);
    const suggestion = suggestFieldName(fieldName, fieldList);
    return {
      expression,
      field: fieldName,
      value: '',
      message: `Unknown field '${fieldName}' for type '${typeName}' in under()`,
      validOptions: fieldList,
      ...(suggestion && { suggestion }),
    };
  }

  // Known field — verify it's a relation field when we can see its definition.
  const field = fields[fieldName];
  if (field && field.prompt !== 'relation') {
    return {
      expression,
      field: fieldName,
      value: '',
      message: `under() expects a relation field, but '${fieldName}' is a '${field.prompt ?? 'non-relation'}' field on type '${typeName}'`,
      validOptions: [],
    };
  }

  return null;
}

/**
 * Validate a single field value against its options.
 */
function validateFieldValue(
  expression: string,
  fieldName: string,
  value: string,
  allowedOptions: string[]
): WhereValidationError | null {
  const invalid = validateSelectOptionValue(value, allowedOptions);
  if (!invalid) return null;

  return {
    expression,
    field: fieldName,
    value: invalid.value,
    message: `Invalid value '${invalid.value}' for field '${fieldName}'`,
    validOptions: invalid.allowedOptions,
    ...(invalid.suggestion && { suggestion: invalid.suggestion }),
  };
}

/**
 * Format validation errors for human-readable output.
 */
export function formatWhereValidationErrors(errors: WhereValidationError[]): string {
  if (errors.length === 0) return '';

  if (errors.length === 1) {
    const err = errors[0]!;
    let msg = `Error: ${err.message}.`;
    if (err.validOptions.length > 0) {
      msg += `\n  Valid options: ${err.validOptions.join(', ')}`;
    }
    if (err.suggestion) {
      msg += `\n  Did you mean '${err.suggestion}'?`;
    }
    return msg;
  }

  const lines: string[] = ['Expression validation errors:'];
  for (const err of errors) {
    let line = `  - ${err.message}`;
    if (err.validOptions.length === 0) {
      // No options to suggest (e.g. a relation-field-type error).
    } else if (err.validOptions.length <= 5) {
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
