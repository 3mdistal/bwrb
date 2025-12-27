import { Command } from 'commander';
import ignore, { type Ignore } from 'ignore';
import { readdir, readFile } from 'fs/promises';
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
  getDiscriminatorFieldsFromTypePath,
  getEnumForField,
} from '../lib/schema.js';
import { parseNote, writeNote } from '../lib/frontmatter.js';
import { resolveVaultDir, getOutputDir, getDirMode } from '../lib/vault.js';
import { suggestEnumValue, suggestFieldName } from '../lib/validation.js';
import { printError, promptSelection, promptConfirm, promptInput } from '../lib/prompt.js';
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
  /** For orphan-file issues: the expected type path inferred from directory location */
  inferredType?: string;
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
 * Fix result for a single issue.
 */
export type FixAction = 'fixed' | 'skipped' | 'failed';

export interface FixResult {
  file: string;
  issue: AuditIssue;
  action: FixAction;
  message?: string;
}

/**
 * Summary of fix operations.
 */
export interface FixSummary {
  fixed: number;
  skipped: number;
  failed: number;
  remaining: number;
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
  fix?: boolean;
  auto?: boolean;
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
  .option('--fix', 'Interactive repair mode')
  .option('--auto', 'With --fix: automatically apply unambiguous fixes')
  .action(async (typePath: string | undefined, options: AuditOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';
    const fixMode = options.fix ?? false;
    const autoMode = options.auto ?? false;

    // --auto requires --fix
    if (autoMode && !fixMode) {
      printError('--auto requires --fix');
      process.exit(1);
    }

    // --fix is not compatible with JSON output
    if (fixMode && jsonMode) {
      printError('--fix is not compatible with --output json');
      process.exit(1);
    }

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

      // Handle fix mode
      if (fixMode) {
        const fixSummary = autoMode
          ? await runAutoFix(results, schema, vaultDir)
          : await runInteractiveFix(results, schema, vaultDir);

        outputFixResults(fixSummary, autoMode);

        // Exit with error if there are remaining issues
        if (fixSummary.remaining > 0) {
          process.exit(ExitCodes.VALIDATION_ERROR);
        }
        return;
      }

      // Output results (report mode)
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
 * Discover files to audit.
 * When no type is specified, scans the entire vault.
 * When a type is specified, only scans that type's directories.
 */
async function discoverManagedFiles(
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
      autoFixable: Boolean(file.expectedType),
      inferredType: file.expectedType,
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
// Fix Operations
// ============================================================================

/**
 * Apply a single fix to a file.
 */
async function applyFix(
  schema: Schema,
  filePath: string,
  issue: AuditIssue,
  newValue?: unknown
): Promise<FixResult> {
  try {
    const parsed = await parseNote(filePath);
    const frontmatter = { ...parsed.frontmatter };

    switch (issue.code) {
      case 'orphan-file': {
        // newValue should be a type path (e.g., 'objective/task')
        if (typeof newValue !== 'string') {
          return { file: filePath, issue, action: 'failed', message: 'No type path provided' };
        }
        // Convert type path to discriminator fields and add them
        const discriminatorFields = getDiscriminatorFieldsFromTypePath(newValue);
        Object.assign(frontmatter, discriminatorFields);
        break;
      }
      case 'missing-required': {
        if (issue.field && newValue !== undefined) {
          frontmatter[issue.field] = newValue;
        } else {
          return { file: filePath, issue, action: 'failed', message: 'No value provided' };
        }
        break;
      }
      case 'invalid-enum': {
        if (issue.field && newValue !== undefined) {
          frontmatter[issue.field] = newValue;
        } else {
          return { file: filePath, issue, action: 'failed', message: 'No value provided' };
        }
        break;
      }
      default:
        return { file: filePath, issue, action: 'skipped', message: 'Not auto-fixable' };
    }

    // Write the updated frontmatter
    // Get the type path to determine frontmatter order
    const typePath = resolveTypePathFromFrontmatter(schema, frontmatter);
    const typeDef = typePath ? getTypeDefByPath(schema, typePath) : undefined;
    const order = typeDef?.frontmatter_order;

    await writeNote(filePath, frontmatter, parsed.body, order);
    return { file: filePath, issue, action: 'fixed' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { file: filePath, issue, action: 'failed', message };
  }
}

/**
 * Remove a field from a file's frontmatter.
 */
async function removeField(
  schema: Schema,
  filePath: string,
  fieldName: string
): Promise<FixResult> {
  try {
    const parsed = await parseNote(filePath);
    const frontmatter = { ...parsed.frontmatter };

    if (!(fieldName in frontmatter)) {
      return {
        file: filePath,
        issue: { severity: 'warning', code: 'unknown-field', message: '', autoFixable: false },
        action: 'skipped',
        message: 'Field not found',
      };
    }

    delete frontmatter[fieldName];

    // Get frontmatter order if available
    const typePath = resolveTypePathFromFrontmatter(schema, frontmatter);
    const typeDef = typePath ? getTypeDefByPath(schema, typePath) : undefined;
    const order = typeDef?.frontmatter_order;

    await writeNote(filePath, frontmatter, parsed.body, order);
    return {
      file: filePath,
      issue: { severity: 'warning', code: 'unknown-field', message: '', field: fieldName, autoFixable: false },
      action: 'fixed',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      file: filePath,
      issue: { severity: 'warning', code: 'unknown-field', message: '', autoFixable: false },
      action: 'failed',
      message,
    };
  }
}

/**
 * Get the default value for a missing required field.
 */
function getDefaultValue(
  schema: Schema,
  filePath: string,
  frontmatter: Record<string, unknown>,
  fieldName: string
): unknown | undefined {
  const typePath = resolveTypePathFromFrontmatter(schema, frontmatter);
  if (!typePath) return undefined;

  const fields = getFieldsForType(schema, typePath);
  const field = fields[fieldName];
  return field?.default;
}

/**
 * Run automatic fixes on all auto-fixable issues.
 */
async function runAutoFix(
  results: FileAuditResult[],
  schema: Schema,
  _vaultDir: string
): Promise<FixSummary> {
  console.log(chalk.bold('Auditing vault...\n'));
  console.log(chalk.bold('Auto-fixing unambiguous issues...\n'));

  let fixed = 0;
  let skipped = 0;
  let failed = 0;
  const manualReviewNeeded: { file: string; issue: AuditIssue }[] = [];

  for (const result of results) {
    const fixableIssues = result.issues.filter(i => i.autoFixable);
    const nonFixableIssues = result.issues.filter(i => !i.autoFixable);

    // Queue non-fixable issues for manual review
    for (const issue of nonFixableIssues) {
      manualReviewNeeded.push({ file: result.relativePath, issue });
    }

    // Apply auto-fixes
    for (const issue of fixableIssues) {
      if (issue.code === 'orphan-file' && issue.inferredType) {
        // Auto-fix orphan-file when we have inferred type from directory
        const fixResult = await applyFix(schema, result.path, issue, issue.inferredType);
        if (fixResult.action === 'fixed') {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          const fields = getDiscriminatorFieldsFromTypePath(issue.inferredType);
          const fieldStr = Object.entries(fields)
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ');
          console.log(chalk.green(`    ✓ Added ${fieldStr} (from directory)`));
          fixed++;
        } else {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.red(`    ✗ Failed to add type: ${fixResult.message}`));
          failed++;
        }
      } else if (issue.code === 'missing-required' && issue.field) {
        const parsed = await parseNote(result.path);
        const defaultValue = getDefaultValue(schema, result.path, parsed.frontmatter, issue.field);

        if (defaultValue !== undefined) {
          const fixResult = await applyFix(schema, result.path, issue, defaultValue);
          if (fixResult.action === 'fixed') {
            console.log(chalk.cyan(`  ${result.relativePath}`));
            console.log(chalk.green(`    ✓ Added ${issue.field}: ${JSON.stringify(defaultValue)} (default)`));
            fixed++;
          } else {
            console.log(chalk.cyan(`  ${result.relativePath}`));
            console.log(chalk.red(`    ✗ Failed to fix ${issue.field}: ${fixResult.message}`));
            failed++;
          }
        } else {
          skipped++;
          manualReviewNeeded.push({ file: result.relativePath, issue });
        }
      } else {
        skipped++;
      }
    }
  }

  // Show issues requiring manual review
  if (manualReviewNeeded.length > 0) {
    console.log('');
    console.log(chalk.bold('Issues requiring manual review:'));
    let currentFile = '';
    for (const { file, issue } of manualReviewNeeded) {
      if (file !== currentFile) {
        console.log(chalk.cyan(`  ${file}`));
        currentFile = file;
      }
      const symbol = issue.severity === 'error' ? chalk.red('✗') : chalk.yellow('⚠');
      console.log(`    ${symbol} ${issue.message}`);
    }
  }

  return {
    fixed,
    skipped,
    failed,
    remaining: manualReviewNeeded.length,
  };
}

/**
 * Run interactive fixes, prompting for each issue.
 */
async function runInteractiveFix(
  results: FileAuditResult[],
  schema: Schema,
  _vaultDir: string
): Promise<FixSummary> {
  console.log(chalk.bold('Auditing vault...\n'));

  if (results.length === 0) {
    console.log(chalk.green('✓ No issues found\n'));
    return { fixed: 0, skipped: 0, failed: 0, remaining: 0 };
  }

  let fixed = 0;
  let skipped = 0;
  let failed = 0;
  let quit = false;

  for (const result of results) {
    if (quit) break;

    console.log(chalk.cyan(result.relativePath));

    for (const issue of result.issues) {
      if (quit) break;

      const symbol = issue.severity === 'error' ? chalk.red('✗') : chalk.yellow('⚠');
      console.log(`  ${symbol} ${issue.message}`);

      // Handle based on issue type
      switch (issue.code) {
        case 'orphan-file': {
          // Handle missing type field
          let typePath: string | undefined;

          if (issue.inferredType) {
            // We know the expected type from the directory
            const confirm = await promptConfirm(
              `    → Add type fields for '${issue.inferredType}'?`
            );
            if (confirm) {
              typePath = issue.inferredType;
            }
          } else {
            // Need to prompt user to select type
            const typeEnum = getEnumValues(schema, 'type');
            if (typeEnum.length > 0) {
              const typeOptions = [...typeEnum, '[skip]', '[quit]'];
              const selectedType = await promptSelection(
                '    Select type:',
                typeOptions
              );

              if (selectedType === '[quit]') {
                quit = true;
                console.log(chalk.dim('    → Quit'));
                break;
              } else if (selectedType === '[skip]' || !selectedType) {
                console.log(chalk.dim('    → Skipped'));
                skipped++;
                break;
              }

              // Check if selected type has subtypes
              const typeDef = getTypeDefByPath(schema, selectedType);
              if (typeDef && hasSubtypes(typeDef)) {
                const subtypeEnumName = `${selectedType}-type`;
                const subtypeEnum = getEnumValues(schema, subtypeEnumName);
                if (subtypeEnum.length > 0) {
                  const subtypeOptions = [...subtypeEnum, '[skip]', '[quit]'];
                  const selectedSubtype = await promptSelection(
                    `    Select ${subtypeEnumName}:`,
                    subtypeOptions
                  );

                  if (selectedSubtype === '[quit]') {
                    quit = true;
                    console.log(chalk.dim('    → Quit'));
                    break;
                  } else if (selectedSubtype === '[skip]' || !selectedSubtype) {
                    console.log(chalk.dim('    → Skipped'));
                    skipped++;
                    break;
                  }

                  typePath = `${selectedType}/${selectedSubtype}`;
                } else {
                  typePath = selectedType;
                }
              } else {
                typePath = selectedType;
              }
            } else {
              console.log(chalk.dim('    (No type enum defined - skipping)'));
              skipped++;
              break;
            }
          }

          if (typePath) {
            const fixResult = await applyFix(schema, result.path, issue, typePath);
            if (fixResult.action === 'fixed') {
              const fields = getDiscriminatorFieldsFromTypePath(typePath);
              const fieldStr = Object.entries(fields)
                .map(([k, v]) => `${k}: ${v}`)
                .join(', ');
              console.log(chalk.green(`    ✓ Added ${fieldStr}`));
              fixed++;
            } else {
              console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
              failed++;
            }
          } else {
            console.log(chalk.dim('    → Skipped'));
            skipped++;
          }
          break;
        }
        case 'missing-required': {
          if (issue.field) {
            const parsed = await parseNote(result.path);
            const defaultValue = getDefaultValue(schema, result.path, parsed.frontmatter, issue.field);

            if (defaultValue !== undefined) {
              // Has default value - offer to use it
              const confirm = await promptConfirm(`    → Add with default '${JSON.stringify(defaultValue)}'?`);
              if (confirm) {
                const fixResult = await applyFix(schema, result.path, issue, defaultValue);
                if (fixResult.action === 'fixed') {
                  console.log(chalk.green(`    ✓ Added ${issue.field}: ${JSON.stringify(defaultValue)}`));
                  fixed++;
                } else {
                  console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
                  failed++;
                }
              } else {
                console.log(chalk.dim('    → Skipped'));
                skipped++;
              }
            } else {
              // No default - check if field has enum or allow text input
              const typePath = resolveTypePathFromFrontmatter(schema, parsed.frontmatter);
              const enumName = typePath ? getEnumForField(schema, typePath, issue.field) : undefined;
              const enumValues = enumName ? getEnumValues(schema, enumName) : [];

              if (enumValues.length > 0) {
                // Field has enum - prompt to select
                const options = [...enumValues, '[skip]', '[quit]'];
                const selected = await promptSelection(
                  `    Select value for ${issue.field}:`,
                  options
                );

                if (selected === '[quit]') {
                  quit = true;
                  console.log(chalk.dim('    → Quit'));
                } else if (selected === '[skip]' || !selected) {
                  console.log(chalk.dim('    → Skipped'));
                  skipped++;
                } else {
                  const fixResult = await applyFix(schema, result.path, issue, selected);
                  if (fixResult.action === 'fixed') {
                    console.log(chalk.green(`    ✓ Added ${issue.field}: ${selected}`));
                    fixed++;
                  } else {
                    console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
                    failed++;
                  }
                }
              } else {
                // No enum - prompt for text input
                const value = await promptInput(`    Enter value for ${issue.field}:`);
                if (value) {
                  const fixResult = await applyFix(schema, result.path, issue, value);
                  if (fixResult.action === 'fixed') {
                    console.log(chalk.green(`    ✓ Added ${issue.field}: ${value}`));
                    fixed++;
                  } else {
                    console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
                    failed++;
                  }
                } else {
                  console.log(chalk.dim('    → Skipped'));
                  skipped++;
                }
              }
            }
          }
          break;
        }
        case 'invalid-enum': {
          if (issue.field && issue.expected && Array.isArray(issue.expected)) {
            const options = [...issue.expected, '[skip]', '[quit]'];
            const selected = await promptSelection(
              `    Select valid value for ${issue.field}:`,
              options
            );

            if (selected === '[quit]') {
              quit = true;
              console.log(chalk.dim('    → Quit'));
            } else if (selected === '[skip]' || !selected) {
              console.log(chalk.dim('    → Skipped'));
              skipped++;
            } else {
              const fixResult = await applyFix(schema, result.path, issue, selected);
              if (fixResult.action === 'fixed') {
                console.log(chalk.green(`    ✓ Updated ${issue.field}: ${selected}`));
                fixed++;
              } else {
                console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
                failed++;
              }
            }
          } else {
            console.log(chalk.dim('    (Cannot fix - skipping)'));
            skipped++;
          }
          break;
        }
        case 'unknown-field': {
          if (issue.field) {
            if (issue.suggestion) {
              console.log(chalk.dim(`    ${issue.suggestion}`));
            }
            const options = ['[skip]', '[remove field]', '[quit]'];
            const selected = await promptSelection(
              `    Action for unknown field '${issue.field}':`,
              options
            );

            if (selected === '[quit]') {
              quit = true;
              console.log(chalk.dim('    → Quit'));
            } else if (selected === '[remove field]') {
              const fixResult = await removeField(schema, result.path, issue.field);
              if (fixResult.action === 'fixed') {
                console.log(chalk.green(`    ✓ Removed field: ${issue.field}`));
                fixed++;
              } else {
                console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
                failed++;
              }
            } else {
              console.log(chalk.dim('    → Skipped'));
              skipped++;
            }
          } else {
            skipped++;
          }
          break;
        }
        default: {
          // Truly non-fixable issues (orphan-file, invalid-type, wrong-directory)
          if (issue.suggestion) {
            console.log(chalk.dim(`    ${issue.suggestion}`));
          }
          console.log(chalk.dim('    (Manual fix required - skipping)'));
          skipped++;
        }
      }
    }

    console.log('');
  }

  // Count remaining issues (issues not fixed)
  let remaining = 0;
  for (const result of results) {
    remaining += result.issues.length;
  }
  remaining = remaining - fixed;

  return { fixed, skipped, failed, remaining };
}

/**
 * Output fix operation results.
 */
function outputFixResults(summary: FixSummary, autoMode: boolean): void {
  console.log('');
  console.log(chalk.bold('Summary:'));
  console.log(`  Fixed: ${summary.fixed} issues`);
  console.log(`  Skipped: ${summary.skipped} issues`);
  if (summary.failed > 0) {
    console.log(`  Failed: ${summary.failed} issues`);
  }
  console.log(`  Remaining: ${summary.remaining} issues`);

  if (summary.remaining > 0 && autoMode) {
    console.log('');
    console.log(chalk.dim("Run 'ovault audit --fix' to address remaining issues interactively."));
  }
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
