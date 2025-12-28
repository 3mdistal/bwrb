/**
 * Audit detection logic.
 * 
 * This module handles file discovery and issue detection.
 */

import ignore, { type Ignore } from 'ignore';
import { readdir, readFile } from 'fs/promises';
import { join, dirname, basename } from 'path';
import { existsSync } from 'fs';
import {
  getTypeDefByPath,
  hasSubtypes,
  getSubtypeKeys,
  getFieldsForType,
  getEnumValues,
  resolveTypePathFromFrontmatter,
  getTypeFamilies,
} from '../schema.js';
import { parseNote } from '../frontmatter.js';
import { getOutputDir, getDirMode } from '../vault.js';
import { suggestEnumValue, suggestFieldName } from '../validation.js';
import type { Schema } from '../../types/schema.js';
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

// ============================================================================
// Main Audit Runner
// ============================================================================

/**
 * Run audit on all managed files.
 */
export async function runAudit(
  schema: Schema,
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
// File Discovery
// ============================================================================

/**
 * Load and parse .gitignore file if it exists.
 */
async function loadGitignore(vaultDir: string): Promise<Ignore | null> {
  const gitignorePath = join(vaultDir, '.gitignore');
  try {
    const content = await readFile(gitignorePath, 'utf-8');
    return ignore().add(content);
  } catch {
    return null; // No .gitignore or can't read it
  }
}

/**
 * Get directories to exclude from vault-wide audit.
 * Combines defaults, schema config, and env var.
 */
function getExcludedDirectories(schema: Schema): Set<string> {
  const excluded = new Set<string>();
  
  // Always exclude .ovault
  excluded.add('.ovault');
  
  // Add schema-configured exclusions
  const schemaExclusions = schema.audit?.ignored_directories;
  if (schemaExclusions) {
    for (const dir of schemaExclusions) {
      excluded.add(dir.replace(/\/$/, '')); // Normalize trailing slash
    }
  }
  
  // Add env var exclusions (comma-separated)
  const envExclusions = process.env.OVAULT_AUDIT_EXCLUDE;
  if (envExclusions) {
    for (const dir of envExclusions.split(',')) {
      const trimmed = dir.trim().replace(/\/$/, '');
      if (trimmed) excluded.add(trimmed);
    }
  }
  
  return excluded;
}

/**
 * Recursively collect all markdown files in a directory.
 */
async function collectAllMarkdownFiles(
  dir: string,
  baseDir: string,
  excluded: Set<string>,
  gitignore: Ignore | null
): Promise<ManagedFile[]> {
  const files: ManagedFile[] = [];
  
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files; // Directory doesn't exist or can't be read
  }
  
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relativePath = fullPath.slice(baseDir.length + 1); // +1 for leading slash
    
    // Check if this path should be excluded by explicit exclusions
    const shouldExclude = Array.from(excluded).some(excl => 
      relativePath === excl || relativePath.startsWith(excl + '/')
    );
    
    if (shouldExclude) continue;
    
    // Skip hidden directories (starting with .)
    if (entry.isDirectory() && entry.name.startsWith('.')) continue;
    
    // Check gitignore
    if (gitignore && gitignore.ignores(relativePath)) continue;
    
    if (entry.isDirectory()) {
      const subFiles = await collectAllMarkdownFiles(fullPath, baseDir, excluded, gitignore);
      files.push(...subFiles);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push({
        path: fullPath,
        relativePath,
      });
    }
  }
  
  return files;
}

/**
 * Collect all markdown filenames for stale reference checking.
 * Returns a set of basenames (without .md extension) for fast lookup.
 */
async function collectAllMarkdownFilenames(vaultDir: string): Promise<Set<string>> {
  const filenames = new Set<string>();
  const excluded = new Set(['.ovault']);
  const gitignore = await loadGitignore(vaultDir);
  
  const allFiles = await collectAllMarkdownFiles(vaultDir, vaultDir, excluded, gitignore);
  for (const file of allFiles) {
    // Add basename without extension
    filenames.add(basename(file.relativePath, '.md'));
    // Also add relative path without extension for path-based links
    filenames.add(file.relativePath.replace(/\.md$/, ''));
  }
  
  return filenames;
}

/**
 * Discover files to audit.
 * When no type is specified, scans the entire vault.
 * When a type is specified, only scans that type's directories.
 */
export async function discoverManagedFiles(
  schema: Schema,
  vaultDir: string,
  typePath?: string
): Promise<ManagedFile[]> {
  if (typePath) {
    // Specific type - only check that type's files
    return collectFilesForType(schema, vaultDir, typePath);
  }
  
  // No type specified - scan entire vault
  const excluded = getExcludedDirectories(schema);
  const gitignore = await loadGitignore(vaultDir);
  return collectAllMarkdownFiles(vaultDir, vaultDir, excluded, gitignore);
}

/**
 * Recursively collect files for a type path.
 */
async function collectFilesForType(
  schema: Schema,
  vaultDir: string,
  typePath: string
): Promise<ManagedFile[]> {
  const typeDef = getTypeDefByPath(schema, typePath);
  if (!typeDef) return [];

  if (hasSubtypes(typeDef)) {
    // Recurse into subtypes
    const files: ManagedFile[] = [];
    for (const subtype of getSubtypeKeys(typeDef)) {
      const subFiles = await collectFilesForType(schema, vaultDir, `${typePath}/${subtype}`);
      files.push(...subFiles);
    }
    return files;
  }

  // Leaf type - collect files from output_dir
  const outputDir = getOutputDir(schema, typePath);
  if (!outputDir) return [];

  const dirMode = getDirMode(schema, typePath);

  if (dirMode === 'instance-grouped') {
    return collectInstanceGroupedFiles(vaultDir, outputDir, typePath);
  } else {
    return collectPooledFiles(vaultDir, outputDir, typePath);
  }
}

/**
 * Collect files from a pooled (flat) directory.
 */
export async function collectPooledFiles(
  vaultDir: string,
  outputDir: string,
  expectedType: string
): Promise<ManagedFile[]> {
  const fullDir = join(vaultDir, outputDir);
  if (!existsSync(fullDir)) return [];

  const files: ManagedFile[] = [];
  const entries = await readdir(fullDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      const fullPath = join(fullDir, entry.name);
      files.push({
        path: fullPath,
        relativePath: join(outputDir, entry.name),
        expectedType,
      });
    }
  }

  return files;
}

/**
 * Collect files from instance-grouped directories.
 */
export async function collectInstanceGroupedFiles(
  vaultDir: string,
  outputDir: string,
  expectedType: string
): Promise<ManagedFile[]> {
  const fullDir = join(vaultDir, outputDir);
  if (!existsSync(fullDir)) return [];

  const files: ManagedFile[] = [];
  const entries = await readdir(fullDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const instanceDir = join(fullDir, entry.name);
      const instanceFiles = await readdir(instanceDir, { withFileTypes: true });

      for (const file of instanceFiles) {
        if (file.isFile() && file.name.endsWith('.md')) {
          const fullPath = join(instanceDir, file.name);
          files.push({
            path: fullPath,
            relativePath: join(outputDir, entry.name, file.name),
            expectedType,
            instance: entry.name,
          });
        }
      }
    }
  }

  return files;
}

// ============================================================================
// Issue Detection
// ============================================================================

/**
 * Audit a single file for issues.
 */
export async function auditFile(
  schema: Schema,
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
  const resolvedTypePath = resolveTypePathFromFrontmatter(schema, frontmatter);
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
  const typeDef = getTypeDefByPath(schema, resolvedTypePath);
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
    ...(schema.audit?.allowed_extra_fields ?? []),
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

/**
 * Find files with similar names to a target.
 * Uses simple string matching for now.
 */
function findSimilarFiles(target: string, allFiles: Set<string>, maxResults = 5): string[] {
  const targetLower = target.toLowerCase();
  const results: { file: string; score: number }[] = [];
  
  for (const file of allFiles) {
    const fileLower = file.toLowerCase();
    const fileBasename = basename(file).toLowerCase();
    
    // Exact case-insensitive match (shouldn't happen if we're here, but just in case)
    if (fileLower === targetLower) continue;
    
    // Calculate similarity score
    let score = 0;
    
    // Prefix match
    if (fileBasename.startsWith(targetLower) || targetLower.startsWith(fileBasename)) {
      score += 50;
    }
    
    // Contains match
    if (fileBasename.includes(targetLower) || targetLower.includes(fileBasename)) {
      score += 30;
    }
    
    // Word overlap
    const targetWords = targetLower.split(/[\s\-_]+/);
    const fileWords = fileBasename.split(/[\s\-_]+/);
    const overlap = targetWords.filter(w => fileWords.some(fw => fw.includes(w) || w.includes(fw)));
    score += overlap.length * 10;
    
    // Levenshtein distance for short strings
    if (targetLower.length < 20 && fileBasename.length < 20) {
      const dist = levenshteinDistance(targetLower, fileBasename);
      if (dist <= 3) {
        score += (4 - dist) * 15;
      }
    }
    
    if (score > 0) {
      results.push({ file, score });
    }
  }
  
  // Sort by score descending and return top results
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, maxResults).map(r => r.file);
}

/**
 * Calculate Levenshtein distance between two strings.
 */
function levenshteinDistance(a: string, b: string): number {
  const aLen = a.length;
  const bLen = b.length;
  
  const matrix: number[][] = Array.from({ length: aLen + 1 }, () => 
    Array.from({ length: bLen + 1 }, () => 0)
  );

  for (let i = 0; i <= aLen; i++) {
    matrix[i]![0] = i;
  }
  
  for (let j = 0; j <= bLen; j++) {
    matrix[0]![j] = j;
  }

  for (let i = 1; i <= aLen; i++) {
    for (let j = 1; j <= bLen; j++) {
      if (a[i - 1] === b[j - 1]) {
        matrix[i]![j] = matrix[i - 1]![j - 1]!;
      } else {
        matrix[i]![j] = Math.min(
          matrix[i - 1]![j - 1]! + 1,
          matrix[i]![j - 1]! + 1,
          matrix[i - 1]![j]! + 1
        );
      }
    }
  }

  return matrix[aLen]![bLen]!;
}

// ============================================================================
// Exports
// ============================================================================

export { type ManagedFile, type AuditRunOptions };
