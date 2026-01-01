/**
 * Audit detection logic.
 * 
 * This module handles issue detection for vault files.
 * File discovery functions are imported from the shared discovery module.
 */

import { dirname, basename } from 'path';
import {
  getType,
  getFieldsForType,
  getEnumValues,
  resolveTypeFromFrontmatter,
  getOutputDir,
  getTypeFamilies,
} from '../schema.js';
import { parseNote } from '../frontmatter.js';
import { suggestEnumValue, suggestFieldName } from '../validation.js';
import type { LoadedSchema } from '../../types/schema.js';
import {
  type AuditIssue,
  type FileAuditResult,
  type ManagedFile,
  type AuditRunOptions,
  ALLOWED_NATIVE_FIELDS,
  WIKILINK_PATTERN,
  isWikilink,
  isQuotedWikilink,
  extractWikilinkTarget,
} from './types.js';

// Import file discovery functions from shared module
import {
  discoverManagedFiles,
  collectAllMarkdownFilenames,
  findSimilarFiles,
} from '../discovery.js';

// ============================================================================
// Main Audit Runner
// ============================================================================

/**
 * Run audit on all managed files.
 */
export async function runAudit(
  schema: LoadedSchema,
  vaultDir: string,
  options: AuditRunOptions
): Promise<FileAuditResult[]> {
  // Discover all managed files
  const files = await discoverManagedFiles(schema, vaultDir, options.typePath);

  // Apply path filter
  const filteredFiles = options.pathFilter
    ? files.filter(f => f.relativePath.includes(options.pathFilter!))
    : files;

  // Build set of all markdown files for stale reference checking
  const allFiles = await collectAllMarkdownFilenames(vaultDir);

  // Audit each file
  const results: FileAuditResult[] = [];

  for (const file of filteredFiles) {
    const issues = await auditFile(schema, vaultDir, file, options, allFiles);

    // Apply issue filters
    let filteredIssues = issues;
    if (options.onlyIssue) {
      filteredIssues = issues.filter(i => i.code === options.onlyIssue);
    }
    if (options.ignoreIssue) {
      filteredIssues = filteredIssues.filter(i => i.code !== options.ignoreIssue);
    }

    if (filteredIssues.length > 0) {
      results.push({
        path: file.path,
        relativePath: file.relativePath,
        issues: filteredIssues,
      });
    }
  }

  return results;
}

// ============================================================================
// Issue Detection
// ============================================================================

/**
 * Audit a single file for issues.
 */
export async function auditFile(
  schema: LoadedSchema,
  _vaultDir: string,
  file: ManagedFile,
  options: AuditRunOptions,
  allFiles?: Set<string>
): Promise<AuditIssue[]> {
  const issues: AuditIssue[] = [];

  let frontmatter: Record<string, unknown>;
  let body: string;
  try {
    const parsed = await parseNote(file.path);
    frontmatter = parsed.frontmatter;
    body = parsed.body;
  } catch {
    issues.push({
      severity: 'error',
      code: 'orphan-file',
      message: 'Failed to parse frontmatter',
      autoFixable: false,
    });
    return issues;
  }

  // Check for type field
  const typeValue = frontmatter['type'];
  if (!typeValue) {
    issues.push({
      severity: 'error',
      code: 'orphan-file',
      message: "No 'type' field (in managed directory)",
      autoFixable: Boolean(file.expectedType),
      ...(file.expectedType && { inferredType: file.expectedType }),
    });
    return issues;
  }

  // Resolve full type path from frontmatter
  const resolvedTypePath = resolveTypeFromFrontmatter(schema, frontmatter);
  if (!resolvedTypePath) {
    const knownTypes = getTypeFamilies(schema);
    const suggestion = suggestFieldName(String(typeValue), knownTypes);
    issues.push({
      severity: 'error',
      code: 'invalid-type',
      message: `Invalid type: '${typeValue}'`,
      field: 'type',
      value: typeValue,
      ...(suggestion && { suggestion: `Did you mean '${suggestion}'?` }),
      autoFixable: false,
    });
    return issues;
  }

  // Verify type definition exists
  const typeDef = getType(schema, resolvedTypePath);
  if (!typeDef) {
    issues.push({
      severity: 'error',
      code: 'invalid-type',
      message: `Invalid type path: '${resolvedTypePath}'`,
      field: 'type',
      value: typeValue,
      autoFixable: false,
    });
    return issues;
  }

  // Check wrong directory
  const expectedOutputDir = getOutputDir(schema, resolvedTypePath);
  if (expectedOutputDir && file.expectedType) {
    const expectedPath = expectedOutputDir;
    const actualDir = dirname(file.relativePath);
    // Normalize for comparison
    const normalizedExpected = expectedPath.replace(/\/$/, '');
    const normalizedActual = actualDir.replace(/\/$/, '');
    
    if (!normalizedActual.startsWith(normalizedExpected)) {
      issues.push({
        severity: 'error',
        code: 'wrong-directory',
        message: `Wrong directory: type is '${resolvedTypePath}', expected in ${expectedOutputDir}`,
        expected: expectedOutputDir,
        autoFixable: false,
      });
    }
  }

  // Get field definitions for this type
  const fields = getFieldsForType(schema, resolvedTypePath);
  const fieldNames = new Set(Object.keys(fields));

  // Combine allowed fields from different sources
  const allowedFields = new Set([
    ...ALLOWED_NATIVE_FIELDS,
    ...(options.allowedFields ?? []),
    ...(schema.raw.audit?.allowed_extra_fields ?? []),
  ]);

  // Check required fields
  for (const [fieldName, field] of Object.entries(fields)) {
    const value = frontmatter[fieldName];
    const hasValue = value !== undefined && value !== null && value !== '';

    if (field.required && !hasValue) {
      const hasDefault = field.default !== undefined;
      issues.push({
        severity: 'error',
        code: 'missing-required',
        message: `Missing required field: ${fieldName}`,
        field: fieldName,
        autoFixable: hasDefault,
      });
    }
  }

  // Check enum values and format violations
  for (const [fieldName, value] of Object.entries(frontmatter)) {
    const field = fields[fieldName];
    if (!field) continue;

    // Check enum values
    if (field.enum) {
      const enumValues = getEnumValues(schema, field.enum);
      if (enumValues.length > 0) {
        const strValue = String(value);
        if (!enumValues.includes(strValue)) {
          const suggestion = suggestEnumValue(strValue, enumValues);
          issues.push({
            severity: 'error',
            code: 'invalid-enum',
            message: `Invalid ${fieldName} value: '${value}'`,
            field: fieldName,
            value,
            expected: enumValues,
            ...(suggestion && { suggestion: `Did you mean '${suggestion}'?` }),
            autoFixable: false,
          });
        }
      }
    }

    // Check format violations (wikilink, quoted-wikilink)
    if (field.format && value) {
      const formatIssue = checkFormatViolation(fieldName, value, field.format);
      if (formatIssue) {
        issues.push(formatIssue);
      }
    }

    // Check for stale wikilink references in frontmatter fields
    if (allFiles && field.format && (field.format === 'wikilink' || field.format === 'quoted-wikilink')) {
      const staleIssue = checkStaleReference(fieldName, value, allFiles, false);
      if (staleIssue) {
        issues.push(staleIssue);
      }
    }
  }

  // Check unknown fields
  for (const fieldName of Object.keys(frontmatter)) {
    // Skip discriminator fields (type, <type>-type, etc.)
    if (fieldName === 'type' || fieldName.endsWith('-type')) continue;
    
    // Skip allowed native fields and user-allowed fields
    if (allowedFields.has(fieldName)) continue;

    if (!fieldNames.has(fieldName)) {
      const suggestion = suggestFieldName(fieldName, Array.from(fieldNames));
      issues.push({
        severity: options.strict ? 'error' : 'warning',
        code: 'unknown-field',
        message: `Unknown field: ${fieldName}`,
        field: fieldName,
        value: frontmatter[fieldName],
        ...(suggestion && { suggestion: `Did you mean '${suggestion}'?` }),
        autoFixable: false,
      });
    }
  }

  // Check for stale references in body content
  if (allFiles && body) {
    const bodyStaleIssues = checkBodyStaleReferences(body, allFiles);
    issues.push(...bodyStaleIssues);
  }

  return issues;
}

/**
 * Check if a field value violates its expected format.
 * 
 * Note: After YAML parsing, quoted-wikilink values like `milestone: "[[Target]]"`
 * will have the value `[[Target]]` (outer quotes are YAML syntax, not part of value).
 * So both 'wikilink' and 'quoted-wikilink' formats expect a wikilink value after parsing.
 */
function checkFormatViolation(
  fieldName: string,
  value: unknown,
  expectedFormat: 'plain' | 'wikilink' | 'quoted-wikilink'
): AuditIssue | null {
  const strValue = String(value);
  if (!strValue) return null;

  switch (expectedFormat) {
    case 'wikilink':
    case 'quoted-wikilink':
      // Both wikilink and quoted-wikilink expect a wikilink value after YAML parsing.
      // The difference is only in serialization (whether to add quotes when writing).
      if (!isWikilink(strValue)) {
        return {
          severity: 'error',
          code: 'format-violation',
          message: `Format violation: '${fieldName}' should be ${expectedFormat}, got plain text`,
          field: fieldName,
          value: strValue,
          expected: expectedFormat === 'wikilink' 
            ? 'wikilink (e.g., [[value]])' 
            : 'quoted-wikilink (e.g., "[[value]]")',
          expectedFormat,
          autoFixable: true,
        };
      }
      break;
    case 'plain':
      // If format is plain but value contains wikilink brackets, warn
      if (isWikilink(strValue) || isQuotedWikilink(strValue)) {
        return {
          severity: 'warning',
          code: 'format-violation',
          message: `Format violation: '${fieldName}' should be plain text, got wikilink`,
          field: fieldName,
          value: strValue,
          expected: 'plain text (without [[brackets]])',
          expectedFormat: 'plain',
          autoFixable: false, // Don't auto-strip wikilinks - that could lose data
        };
      }
      break;
  }

  return null;
}

/**
 * Check if a wikilink reference points to a non-existent file.
 */
function checkStaleReference(
  fieldName: string,
  value: unknown,
  allFiles: Set<string>,
  inBody: boolean,
  lineNumber?: number
): AuditIssue | null {
  const strValue = String(value);
  const target = extractWikilinkTarget(strValue);
  
  if (!target) return null;
  
  // Check if target exists (by basename or full path)
  if (allFiles.has(target) || allFiles.has(basename(target))) {
    return null;
  }

  // Find similar files for suggestions
  const similarFiles = findSimilarFiles(target, allFiles);

  const issue: AuditIssue = {
    severity: 'warning',
    code: 'stale-reference',
    message: inBody
      ? `Stale reference on line ${lineNumber}: '[[${target}]]' not found`
      : `Stale reference: ${fieldName} '[[${target}]]' not found`,
    value: strValue,
    targetName: target,
    autoFixable: false,
    inBody,
  };
  
  if (!inBody && fieldName) {
    issue.field = fieldName;
  }
  if (similarFiles.length > 0) {
    issue.similarFiles = similarFiles;
  }
  if (lineNumber !== undefined) {
    issue.lineNumber = lineNumber;
  }
  
  return issue;
}

/**
 * Check body content for stale wikilink references.
 */
function checkBodyStaleReferences(body: string, allFiles: Set<string>): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const lines = body.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNumber = i + 1; // 1-based line numbers
    
    // Reset regex lastIndex for each line
    const regex = new RegExp(WIKILINK_PATTERN.source, 'g');
    let match;
    
    while ((match = regex.exec(line)) !== null) {
      const target = match[1]!;
      
      // Check if target exists
      if (!allFiles.has(target) && !allFiles.has(basename(target))) {
        const similarFiles = findSimilarFiles(target, allFiles);
        
        const staleIssue: AuditIssue = {
          severity: 'warning',
          code: 'stale-reference',
          message: `Stale reference on line ${lineNumber}: '[[${target}]]' not found`,
          value: match[0],
          targetName: target,
          autoFixable: false,
          inBody: true,
          lineNumber,
        };
        if (similarFiles.length > 0) {
          staleIssue.similarFiles = similarFiles;
        }
        issues.push(staleIssue);
      }
    }
  }
  
  return issues;
}

// ============================================================================
// Exports
// ============================================================================

// Re-export discovery functions for backward compatibility with existing imports
export { discoverManagedFiles } from '../discovery.js';

export { type ManagedFile, type AuditRunOptions };
