/**
 * Audit detection logic.
 * 
 * This module handles issue detection for vault files.
 * File discovery functions are imported from the shared discovery module.
 */

import { dirname, basename } from 'path';
import { minimatch } from 'minimatch';
import {
  getType,
  getFieldsForType,
  resolveTypeFromFrontmatter,
  getOutputDir,
  getTypeFamilies,
  getDescendants,
} from '../schema.js';
import { parseNote } from '../frontmatter.js';
import { suggestOptionValue, suggestFieldName } from '../validation.js';
import { applyFrontmatterFilters } from '../query.js';
import { searchContent } from '../content-search.js';
import type { LoadedSchema, Field } from '../../types/schema.js';
import {
  type AuditIssue,
  type FileAuditResult,
  type ManagedFile,
  type AuditRunOptions,
  ALLOWED_NATIVE_FIELDS,
  isWikilink,
  isMarkdownLink,
  extractWikilinkTarget,
} from './types.js';

// Import file discovery functions from shared module
import {
  discoverManagedFiles,
  collectAllMarkdownFilenames,
  buildNotePathMap,
  buildNoteTypeMap,
  findSimilarFiles,
} from '../discovery.js';

// Import ownership tracking
import {
  buildOwnershipIndex,
  isNoteOwned,
  canReference,
  extractWikilinkReferences,
  type OwnershipIndex,
} from '../ownership.js';

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

  // Apply path filter (glob pattern or substring match)
  let filteredFiles = files;
  if (options.pathFilter) {
    const pattern = options.pathFilter;
    // If pattern contains glob characters, use minimatch; otherwise do substring match
    const isGlob = /[*?[\]]/.test(pattern);
    if (isGlob) {
      filteredFiles = files.filter(f => minimatch(f.relativePath, pattern, { matchBase: true }));
    } else {
      // Substring match for simple patterns
      filteredFiles = files.filter(f => f.relativePath.includes(pattern));
    }
  }

  // Apply where expressions (frontmatter filtering)
  if (options.whereExpressions && options.whereExpressions.length > 0) {
    const filesWithFrontmatter = await Promise.all(
      filteredFiles.map(async (f) => {
        try {
          const { frontmatter } = await parseNote(f.path);
          return { path: f.path, frontmatter, _managedFile: f };
        } catch {
          return { path: f.path, frontmatter: {}, _managedFile: f };
        }
      })
    );
    
    const filtered = await applyFrontmatterFilters(filesWithFrontmatter, {
      whereExpressions: options.whereExpressions,
      vaultDir,
      silent: true,
    });
    
    // Map back to ManagedFile
    const filteredPaths = new Set(filtered.map(f => f.path));
    filteredFiles = filteredFiles.filter(f => filteredPaths.has(f.path));
  }

  // Apply text filter (content search)
  if (options.textQuery) {
    const searchResult = await searchContent({
      pattern: options.textQuery,
      vaultDir,
      schema,
      ...(options.typePath && { typePath: options.typePath }),
      contextLines: 0,
      caseSensitive: false,
      regex: false,
      limit: 10000,
    });
    
    if (searchResult.success && searchResult.results) {
      const matchingPaths = new Set(searchResult.results.map(r => r.file.path));
      filteredFiles = filteredFiles.filter(f => matchingPaths.has(f.path));
    }
  }

  // Build set of all markdown files for stale reference checking
  const allFiles = await collectAllMarkdownFilenames(vaultDir);

  // Build map from note names to relative paths for ownership checking
  const notePathMap = await buildNotePathMap(vaultDir);

  // Build ownership index for ownership violation checking
  const ownershipIndex = await buildOwnershipIndex(schema, vaultDir);

  // Build map from note names to their types for context field validation
  const noteTypeMap = await buildNoteTypeMap(schema, vaultDir);

  // Build parent map for cycle detection on recursive types
  const parentMap = await buildParentMap(schema, vaultDir, filteredFiles);

  // Audit each file
  const results: FileAuditResult[] = [];

  for (const file of filteredFiles) {
    const issues = await auditFile(schema, vaultDir, file, options, allFiles, ownershipIndex, notePathMap, noteTypeMap, parentMap);

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
  allFiles?: Set<string>,
  ownershipIndex?: OwnershipIndex,
  notePathMap?: Map<string, string>,
  noteTypeMap?: Map<string, string>,
  parentMap?: Map<string, string>
): Promise<AuditIssue[]> {
  const issues: AuditIssue[] = [];

  let frontmatter: Record<string, unknown>;
  try {
    const parsed = await parseNote(file.path);
    frontmatter = parsed.frontmatter;
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
      message: "No 'type' field (in managed directory). Type-dependent checks skipped.",
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
      message: `Invalid type: '${typeValue}'. Type-dependent checks skipped.`,
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
      message: `Invalid type path: '${resolvedTypePath}'. Type-dependent checks skipped.`,
      field: 'type',
      value: typeValue,
      autoFixable: false,
    });
    return issues;
  }

  // Check wrong directory
  const expectedOutputDir = getOutputDir(schema, resolvedTypePath);
  if (expectedOutputDir) {
    const expectedPath = expectedOutputDir;
    const actualDir = dirname(file.relativePath);
    // Normalize for comparison
    const normalizedExpected = expectedPath.replace(/\/$/, '');
    const normalizedActual = actualDir.replace(/\/$/, '');
    
    // Segment-aware check: actualDir must be exactly expectedDir or a subdirectory
    const isCorrectLocation =
      normalizedActual === normalizedExpected ||
      normalizedActual.startsWith(normalizedExpected + '/');
    if (!isCorrectLocation) {
      issues.push({
        severity: 'error',
        code: 'wrong-directory',
        message: `Wrong directory: type is '${resolvedTypePath}', expected in ${expectedOutputDir}`,
        expected: expectedOutputDir,
        currentDirectory: actualDir,
        expectedDirectory: expectedOutputDir,
        autoFixable: true, // Can be auto-fixed with --execute
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

    // Check select field options
    if (field.options && field.options.length > 0) {
      const validOptions = field.options;
      const strValue = String(value);
      if (!validOptions.includes(strValue)) {
        const suggestion = suggestOptionValue(strValue, validOptions);
        issues.push({
          severity: 'error',
          code: 'invalid-option',
          message: `Invalid ${fieldName} value: '${value}'`,
          field: fieldName,
          value,
          expected: validOptions,
          ...(suggestion && { suggestion: `Did you mean '${suggestion}'?` }),
          autoFixable: false,
        });
      }
    }

    // Check format violations for relation fields (wikilink vs markdown)
    if (field.prompt === 'relation' && value) {
      const formatIssue = checkFormatViolation(fieldName, value, schema.config.linkFormat);
      if (formatIssue) {
        issues.push(formatIssue);
      }
    }

    // Check for stale wikilink/markdown references in frontmatter relation fields
    if (allFiles && field.prompt === 'relation') {
      const staleIssue = checkStaleReference(fieldName, value, allFiles, false);
      if (staleIssue) {
        issues.push(staleIssue);
      }
    }

    // Check context field source types (links must point to correct type)
    if (noteTypeMap && field.source && value && field.prompt === 'relation') {
      const sourceIssues = checkContextFieldSource(
        schema, fieldName, value, field.source, noteTypeMap
      );
      issues.push(...sourceIssues);
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

  // Note: Body stale-reference detection is deferred to v2.0
  // Per product scope, v1.0 only validates frontmatter relation fields

  // Check for ownership violations
  if (ownershipIndex && notePathMap) {
    const ownershipIssues = await checkOwnershipViolations(
      file,
      frontmatter,
      fields,
      ownershipIndex,
      notePathMap
    );
    issues.push(...ownershipIssues);
  }

  // Check for parent cycles in recursive types
  if (parentMap && typeDef.recursive) {
    const cycleIssue = checkParentCycle(file, parentMap);
    if (cycleIssue) {
      issues.push(cycleIssue);
    }
  }

  return issues;
}

/**
 * Check if a field value violates its expected format.
 * 
 * For wikilinks: After YAML parsing, the value should be [[Target]]
 * For markdown: After YAML parsing, the value should be [Target](Target.md)
 */
function checkFormatViolation(
  fieldName: string,
  value: unknown,
  expectedFormat: 'wikilink' | 'markdown'
): AuditIssue | null {
  const strValue = String(value);
  if (!strValue) return null;

  switch (expectedFormat) {
    case 'wikilink':
      // Wikilink values should be [[Target]] after YAML parsing
      if (!isWikilink(strValue)) {
        return {
          severity: 'error',
          code: 'format-violation',
          message: `Format violation: '${fieldName}' should be a wikilink, got plain text or markdown`,
          field: fieldName,
          value: strValue,
          expected: 'wikilink (e.g., [[value]])',
          expectedFormat: 'wikilink',
          autoFixable: true,
        };
      }
      break;
    case 'markdown':
      // Markdown links should be [Target](Target.md) after YAML parsing
      if (!isMarkdownLink(strValue)) {
        return {
          severity: 'error',
          code: 'format-violation',
          message: `Format violation: '${fieldName}' should be a markdown link, got plain text or wikilink`,
          field: fieldName,
          value: strValue,
          expected: 'markdown link (e.g., [value](value.md))',
          expectedFormat: 'markdown',
          autoFixable: true,
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

// ============================================================================
// Context Field Source Validation
// ============================================================================

/**
 * Check if a context field value matches its source type constraint.
 * 
 * The source property can specify:
 * - A type name (e.g., "milestone") - only that exact type is valid
 * - A parent type name (e.g., "objective") - that type and all descendants are valid
 * - "any" - any note is valid (no type checking)
 * - A dynamic_source name (legacy) - skip validation (handled by separate migration)
 * 
 * Handles both single values and arrays (for multiple: true fields).
 */
function checkContextFieldSource(
  schema: LoadedSchema,
  fieldName: string,
  value: unknown,
  source: string | string[],
  noteTypeMap: Map<string, string>
): AuditIssue[] {
  const issues: AuditIssue[] = [];
  
  // Normalize source to array
  const sources = Array.isArray(source) ? source : [source];
  
  // Handle "any" source - no type restriction
  if (sources.includes('any')) return issues;
  
  // Get all valid types (each source type + all their descendants)
  const validTypes = new Set<string>();
  for (const src of sources) {
    const sourceType = schema.types.get(src);
    if (sourceType) {
      validTypes.add(src);
      for (const descendant of getDescendants(schema, src)) {
        validTypes.add(descendant);
      }
    }
  }
  
  if (validTypes.size === 0) {
    // No valid source types found - schema validation should catch this
    return issues;
  }
  
  // Handle array values (multiple: true fields)
  const values = Array.isArray(value) ? value : [value];
  
  for (const v of values) {
    const issue = checkSingleContextValue(
      fieldName, v, sources, validTypes, noteTypeMap
    );
    if (issue) {
      issues.push(issue);
    }
  }
  
  return issues;
}

/**
 * Check a single context field value against the source type constraint.
 */
function checkSingleContextValue(
  fieldName: string,
  value: unknown,
  sources: string[],
  validTypes: Set<string>,
  noteTypeMap: Map<string, string>
): AuditIssue | null {
  const strValue = String(value);
  const target = extractWikilinkTarget(strValue);
  
  if (!target) return null;
  
  // Look up the referenced note's type
  const actualType = noteTypeMap.get(target);
  if (!actualType) {
    // Note doesn't exist or has no type - stale reference check handles this
    return null;
  }
  
  // Check if actual type is in the set of valid types
  if (validTypes.has(actualType)) {
    return null; // Valid
  }
  
  // Type mismatch!
  const validTypesArray = Array.from(validTypes);
  const suggestion = suggestOptionValue(actualType, validTypesArray);
  
  const sourceDisplay = sources.length === 1 ? sources[0] : sources.join(' or ');
  return {
    severity: 'error',
    code: 'invalid-source-type',
    message: `Type mismatch: '${fieldName}' expects ${sourceDisplay}${validTypesArray.length > sources.length ? ' (or descendant)' : ''}, but '${target}' is ${actualType}`,
    field: fieldName,
    value: strValue,
    expectedType: sources[0],
    actualType: actualType,
    expected: validTypesArray.length > 1 ? validTypesArray : sources[0],
    ...(suggestion && { suggestion: `Did you mean to link to a ${suggestion}?` }),
    autoFixable: false,
  };
}

// ============================================================================
// Ownership Violation Detection
// ============================================================================

/**
 * Check for ownership violations in frontmatter references.
 * 
 * Detects:
 * - owned-note-referenced: A note references an owned note via a schema field
 * - owned-wrong-location: An owned note is not in the expected location
 */
async function checkOwnershipViolations(
  file: ManagedFile,
  frontmatter: Record<string, unknown>,
  fields: Record<string, Field>,
  ownershipIndex: OwnershipIndex,
  notePathMap: Map<string, string>
): Promise<AuditIssue[]> {
  const issues: AuditIssue[] = [];
  
  // Check if this file is owned and in the wrong location
  const ownedInfo = isNoteOwned(ownershipIndex, file.relativePath);
  if (ownedInfo && file.ownership) {
    // Note is owned - verify it's in the correct location
    // The expected location is based on ownership relationship
    const ownerDir = dirname(ownedInfo.ownerPath);
    const expectedDir = `${ownerDir}/${ownedInfo.fieldName}`;
    const actualDir = dirname(file.relativePath);
    
    // Normalize paths for comparison
    const normalizedExpected = expectedDir.replace(/\/$/, '');
    const normalizedActual = actualDir.replace(/\/$/, '');
    
    if (normalizedActual !== normalizedExpected) {
      issues.push({
        severity: 'error',
        code: 'owned-wrong-location',
        message: `Owned note in wrong location: expected in ${expectedDir}`,
        expected: expectedDir,
        currentDirectory: actualDir,
        expectedDirectory: expectedDir,
        autoFixable: true, // Can be auto-fixed with --execute
        ownerPath: ownedInfo.ownerPath,
        ownedNotePath: file.relativePath,
      });
    }
  }
  
  // Check each relation field to see if it references an owned note
  for (const [fieldName, field] of Object.entries(fields)) {
    // Skip non-relation fields and owned fields (owner is allowed to reference its owned notes)
    if (field.prompt !== 'relation') {
      continue;
    }
    
    // If this field is marked as owned, the current note IS the owner - skip
    if (field.owned) {
      continue;
    }
    
    const value = frontmatter[fieldName];
    if (!value) continue;
    
    // Extract wikilink references from the field value
    const references = extractWikilinkReferences(value);
    
    for (const refName of references) {
      // Look up the referenced note's path using the path map
      const refPath = notePathMap.get(refName);
      
      if (!refPath) {
        // Note not found - stale reference check handles this
        continue;
      }
      
      // Check if referenced note is owned
      const validation = canReference(ownershipIndex, file.relativePath, refPath);
      
      if (!validation.valid) {
        for (const error of validation.errors) {
          issues.push({
            severity: 'error',
            code: 'owned-note-referenced',
            message: `Cannot reference owned note '${refName}' - it is owned by '${error.details?.existingOwnerPath}'`,
            field: fieldName,
            value: value,
            autoFixable: false,
            ownerPath: error.details?.existingOwnerPath,
            ownedNotePath: refPath,
          });
        }
      }
    }
  }
  
  return issues;
}

// ============================================================================
// Parent Cycle Detection
// ============================================================================

/**
 * Build a map from note names to their parent note names for recursive types.
 * Used to detect cycles in parent references (e.g., A -> B -> A).
 */
async function buildParentMap(
  schema: LoadedSchema,
  _vaultDir: string,
  files: ManagedFile[]
): Promise<Map<string, string>> {
  const parentMap = new Map<string, string>();
  
  for (const file of files) {
    try {
      const { frontmatter } = await parseNote(file.path);
      const typePath = resolveTypeFromFrontmatter(schema, frontmatter);
      if (!typePath) continue;
      
      const typeDef = getType(schema, typePath);
      if (!typeDef?.recursive) continue;
      
      // Get the parent field value
      const parentValue = frontmatter['parent'];
      if (!parentValue) continue;
      
      // Extract the parent note name from the wikilink
      const parentTarget = extractWikilinkTarget(String(parentValue));
      if (parentTarget) {
        const noteName = basename(file.path, '.md');
        parentMap.set(noteName, parentTarget);
      }
    } catch {
      // Skip files that can't be parsed
    }
  }
  
  return parentMap;
}

/**
 * Check if a note is part of a parent cycle.
 * Returns an AuditIssue if a cycle is detected, null otherwise.
 */
function checkParentCycle(
  file: ManagedFile,
  parentMap: Map<string, string>
): AuditIssue | null {
  const noteName = basename(file.path, '.md');
  const visited = new Set<string>();
  const path: string[] = [noteName];
  
  // Add the starting note to visited
  visited.add(noteName);
  
  let current = parentMap.get(noteName);
  
  while (current) {
    if (visited.has(current)) {
      // Found a cycle that includes the original note
      return {
        severity: 'error',
        code: 'parent-cycle',
        message: `Parent cycle detected: ${path.join(' → ')} → ${current}`,
        field: 'parent',
        autoFixable: false,
        cyclePath: [...path, current],
      };
    }
    
    visited.add(current);
    path.push(current);
    current = parentMap.get(current);
  }
  
  return null;
}

// ============================================================================
// Exports
// ============================================================================

// Re-export discovery functions for backward compatibility with existing imports
export { discoverManagedFiles } from '../discovery.js';

export { type ManagedFile, type AuditRunOptions };
