import { Command } from 'commander';
import { readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import chalk from 'chalk';
import {
  loadSchema,
  getTypeDefByPath,
  getTypeFamilies,
  hasSubtypes,
  getSubtypeKeys,
  getFieldsForType,
  getEnumValues,
  resolveTypePathFromFrontmatter,
} from '../lib/schema.js';
import { parseNote } from '../lib/frontmatter.js';
import { resolveVaultDir, getOutputDir, getDirMode } from '../lib/vault.js';
import { suggestEnumValue, suggestFieldName } from '../lib/validation.js';
import { printError } from '../lib/prompt.js';
import {
  printJson,
  jsonError,
  jsonSuccess,
  ExitCodes,
} from '../lib/output.js';
import type { Schema } from '../types/schema.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Issue severity levels.
 */
export type IssueSeverity = 'error' | 'warning';

/**
 * Issue codes for audit findings.
 */
export type IssueCode =
  | 'orphan-file'
  | 'invalid-type'
  | 'missing-required'
  | 'invalid-enum'
  | 'unknown-field'
  | 'wrong-directory'
  | 'type-mismatch';

/**
 * A single audit issue.
 */
export interface AuditIssue {
  severity: IssueSeverity;
  code: IssueCode;
  message: string;
  field?: string;
  value?: unknown;
  expected?: string[] | string;
  suggestion?: string;
  autoFixable: boolean;
}

/**
 * Audit result for a single file.
 */
export interface FileAuditResult {
  path: string;
  relativePath: string;
  issues: AuditIssue[];
}

/**
 * Overall audit summary.
 */
export interface AuditSummary {
  filesChecked: number;
  filesWithErrors: number;
  filesWithWarnings: number;
  totalErrors: number;
  totalWarnings: number;
}

/**
 * Managed file with expected type context.
 */
interface ManagedFile {
  path: string;
  relativePath: string;
  expectedType?: string;
  instance?: string;
}

/**
 * Audit command options.
 */
interface AuditOptions {
  strict?: boolean;
  path?: string;
  only?: string;
  ignore?: string;
  output?: string;
}

// ============================================================================
// Native fields that are always allowed (Obsidian-specific)
// ============================================================================

const ALLOWED_NATIVE_FIELDS = new Set([
  'tags',
  'aliases',
  'cssclasses',
  'publish',
  'type',  // type discriminator
]);

// ============================================================================
// Command Definition
// ============================================================================

export const auditCommand = new Command('audit')
  .description('Validate vault files against schema and report issues')
  .addHelpText('after', `
Issue Types:
  orphan-file       File in managed directory but no 'type' field
  invalid-type      Type field value not recognized
  missing-required  Required field is missing
  invalid-enum      Field value not in allowed enum values
  unknown-field     Field not defined in schema (warning by default)
  wrong-directory   File location doesn't match its type

Examples:
  ovault audit                      # Check all files (report only)
  ovault audit objective/task       # Check only tasks
  ovault audit --strict             # Error on unknown fields
  ovault audit --path "Ideas/"      # Check specific directory
  ovault audit --only missing-required
  ovault audit --ignore unknown-field
  ovault audit --output json        # JSON output for CI`)
  .argument('[type]', 'Type path to audit (e.g., idea, objective/task)')
  .option('--strict', 'Treat unknown fields as errors instead of warnings')
  .option('--path <path>', 'Limit audit to files matching path pattern')
  .option('--only <issue-type>', 'Only report specific issue type')
  .option('--ignore <issue-type>', 'Ignore specific issue type')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .action(async (typePath: string | undefined, options: AuditOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
      const parentOpts = cmd.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
      const schema = await loadSchema(vaultDir);

      // Validate type if specified
      if (typePath) {
        const typeDef = getTypeDefByPath(schema, typePath);
        if (!typeDef) {
          const error = `Unknown type: ${typePath}`;
          if (jsonMode) {
            printJson(jsonError(error));
            process.exit(ExitCodes.VALIDATION_ERROR);
          }
          printError(error);
          showAvailableTypes(schema);
          process.exit(1);
        }
      }

      // Run audit
      const results = await runAudit(schema, vaultDir, {
        typePath,
        strict: options.strict ?? false,
        pathFilter: options.path,
        onlyIssue: options.only as IssueCode | undefined,
        ignoreIssue: options.ignore as IssueCode | undefined,
      });

      // Output results
      const summary = calculateSummary(results);

      if (jsonMode) {
        outputJsonResults(results, summary);
      } else {
        outputTextResults(results, summary, vaultDir);
      }

      // Exit code based on errors
      if (summary.totalErrors > 0) {
        process.exit(ExitCodes.VALIDATION_ERROR);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (jsonMode) {
        printJson(jsonError(message));
        process.exit(ExitCodes.VALIDATION_ERROR);
      }
      printError(message);
      process.exit(1);
    }
  });

// ============================================================================
// Core Audit Logic
// ============================================================================

interface AuditRunOptions {
  typePath?: string | undefined;
  strict: boolean;
  pathFilter?: string | undefined;
  onlyIssue?: IssueCode | undefined;
  ignoreIssue?: IssueCode | undefined;
}

/**
 * Run audit on all managed files.
 */
async function runAudit(
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

  // Audit each file
  const results: FileAuditResult[] = [];

  for (const file of filteredFiles) {
    const issues = await auditFile(schema, vaultDir, file, options);

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

/**
 * Discover all files in managed directories.
 */
async function discoverManagedFiles(
  schema: Schema,
  vaultDir: string,
  typePath?: string
): Promise<ManagedFile[]> {
  const files: ManagedFile[] = [];

  if (typePath) {
    // Specific type - only check that type's files
    const typeFiles = await collectFilesForType(schema, vaultDir, typePath);
    files.push(...typeFiles);
  } else {
    // All types - check all managed directories
    for (const family of getTypeFamilies(schema)) {
      const typeFiles = await collectFilesForType(schema, vaultDir, family);
      files.push(...typeFiles);
    }
  }

  return files;
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
async function collectPooledFiles(
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
async function collectInstanceGroupedFiles(
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

/**
 * Audit a single file for issues.
 */
async function auditFile(
  schema: Schema,
  _vaultDir: string,
  file: ManagedFile,
  options: AuditRunOptions
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
      message: "No 'type' field (in managed directory)",
      autoFixable: false,
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

  // Check required fields
  for (const [fieldName, field] of Object.entries(fields)) {
    const value = frontmatter[fieldName];
    const hasValue = value !== undefined && value !== null && value !== '';

    if (field.required && !hasValue && field.default === undefined) {
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

  // Check enum values
  for (const [fieldName, value] of Object.entries(frontmatter)) {
    const field = fields[fieldName];
    if (!field?.enum) continue;

    const enumValues = getEnumValues(schema, field.enum);
    if (enumValues.length === 0) continue;

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

  // Check unknown fields
  for (const fieldName of Object.keys(frontmatter)) {
    // Skip discriminator fields (type, <type>-type, etc.)
    if (fieldName === 'type' || fieldName.endsWith('-type')) continue;
    
    // Skip allowed native fields
    if (ALLOWED_NATIVE_FIELDS.has(fieldName)) continue;

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

  return issues;
}

// ============================================================================
// Output Formatting
// ============================================================================

/**
 * Calculate summary statistics from results.
 */
function calculateSummary(results: FileAuditResult[]): AuditSummary {
  let filesWithErrors = 0;
  let filesWithWarnings = 0;
  let totalErrors = 0;
  let totalWarnings = 0;

  for (const result of results) {
    const errors = result.issues.filter(i => i.severity === 'error');
    const warnings = result.issues.filter(i => i.severity === 'warning');

    if (errors.length > 0) filesWithErrors++;
    if (warnings.length > 0 && errors.length === 0) filesWithWarnings++;

    totalErrors += errors.length;
    totalWarnings += warnings.length;
  }

  return {
    filesChecked: results.length > 0 ? results.length : 0,
    filesWithErrors,
    filesWithWarnings,
    totalErrors,
    totalWarnings,
  };
}

/**
 * Output results as JSON.
 */
function outputJsonResults(results: FileAuditResult[], summary: AuditSummary): void {
  const output = {
    ...jsonSuccess(),
    files: results.map(r => ({
      path: r.relativePath,
      issues: r.issues.map(i => ({
        severity: i.severity,
        code: i.code,
        message: i.message,
        ...(i.field && { field: i.field }),
        ...(i.value !== undefined && { value: i.value }),
        ...(i.expected && { expected: i.expected }),
        ...(i.suggestion && { suggestion: i.suggestion }),
        autoFixable: i.autoFixable,
      })),
    })),
    summary,
  };

  printJson(output);
}

/**
 * Output results as text.
 */
function outputTextResults(
  results: FileAuditResult[],
  summary: AuditSummary,
  _vaultDir: string
): void {
  console.log(chalk.bold('Auditing vault...\n'));

  if (results.length === 0) {
    console.log(chalk.green('✓ No issues found\n'));
    return;
  }

  // Group and output by file
  for (const result of results) {
    console.log(chalk.cyan(result.relativePath));

    for (const issue of result.issues) {
      const symbol = issue.severity === 'error' ? chalk.red('✗') : chalk.yellow('⚠');
      console.log(`  ${symbol} ${issue.message}`);

      if (issue.expected && Array.isArray(issue.expected)) {
        const display = issue.expected.length <= 6
          ? issue.expected.join(', ')
          : `${issue.expected.slice(0, 6).join(', ')}... (${issue.expected.length} options)`;
        console.log(chalk.dim(`    Expected: ${display}`));
      }

      if (issue.suggestion) {
        console.log(chalk.dim(`    ${issue.suggestion}`));
      }
    }

    console.log('');
  }

  // Summary
  console.log(chalk.bold('Summary:'));
  console.log(`  Files with issues: ${results.length}`);
  console.log(`  Files with errors: ${summary.filesWithErrors}`);
  console.log(`  Total errors: ${summary.totalErrors}`);
  console.log(`  Total warnings: ${summary.totalWarnings}`);

  if (summary.totalErrors > 0) {
    console.log('');
    console.log(chalk.dim("Run 'ovault audit --fix' to repair interactively."));
  }
}

/**
 * Show available types when invalid type is specified.
 */
function showAvailableTypes(schema: Schema): void {
  console.log('');
  console.log('Available types:');
  for (const family of getTypeFamilies(schema)) {
    console.log(`  ${family}`);
    const typeDef = getTypeDefByPath(schema, family);
    if (typeDef && hasSubtypes(typeDef)) {
      for (const subtype of getSubtypeKeys(typeDef)) {
        console.log(`    ${family}/${subtype}`);
      }
    }
  }
}

// ============================================================================
// Exports for Testing
// ============================================================================

export {
  discoverManagedFiles,
  auditFile,
  calculateSummary,
  collectPooledFiles,
  collectInstanceGroupedFiles,
  type ManagedFile,
  type AuditRunOptions,
};
