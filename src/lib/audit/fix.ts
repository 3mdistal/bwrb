/**
 * Audit fix operations.
 * 
 * This module handles applying fixes to audit issues.
 */

import chalk from 'chalk';
import {
  getType,
  getFieldsForType,
  getEnumValues,
  resolveTypeFromFrontmatter,
  getDiscriminatorFieldsFromTypePath,
  getEnumForField,
  hasSubtypes,
} from '../schema.js';
import { queryByType } from '../vault.js';
import { parseNote, writeNote } from '../frontmatter.js';
import { promptSelection, promptConfirm, promptInput } from '../prompt.js';
import type { LoadedSchema } from '../../types/schema.js';

// Alias for backward compatibility
const resolveTypePathFromFrontmatter = resolveTypeFromFrontmatter;
const getTypeDefByPath = getType;
import {
  type AuditIssue,
  type FileAuditResult,
  type FixResult,
  type FixSummary,
  toWikilink,
  toQuotedWikilink,
} from './types.js';

// ============================================================================
// Fix Application
// ============================================================================

/**
 * Apply a single fix to a file.
 */
export async function applyFix(
  schema: LoadedSchema,
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
      case 'format-violation': {
        if (issue.field && issue.expectedFormat) {
          const currentValue = frontmatter[issue.field];
          if (typeof currentValue === 'string') {
            if (issue.expectedFormat === 'wikilink') {
              frontmatter[issue.field] = toWikilink(currentValue);
            } else if (issue.expectedFormat === 'quoted-wikilink') {
              frontmatter[issue.field] = toQuotedWikilink(currentValue);
            }
          } else {
            return { file: filePath, issue, action: 'failed', message: 'Cannot fix non-string value' };
          }
        } else {
          return { file: filePath, issue, action: 'failed', message: 'No field or format specified' };
        }
        break;
      }
      case 'unknown-field': {
        // This is handled by removeField instead
        return { file: filePath, issue, action: 'skipped', message: 'Use removeField for unknown-field issues' };
      }
      case 'invalid-source-type': {
        // Fix invalid source type by updating the field value
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
    const order = typeDef?.fieldOrder;

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
export async function removeField(
  schema: LoadedSchema,
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
    const order = typeDef?.fieldOrder;

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
export function getDefaultValue(
  schema: LoadedSchema,
  frontmatter: Record<string, unknown>,
  fieldName: string
): unknown | undefined {
  const typePath = resolveTypePathFromFrontmatter(schema, frontmatter);
  if (!typePath) return undefined;

  const fields = getFieldsForType(schema, typePath);
  const field = fields[fieldName];
  return field?.default;
}

// ============================================================================
// Auto-Fix Mode
// ============================================================================

/**
 * Run automatic fixes on all auto-fixable issues.
 */
export async function runAutoFix(
  results: FileAuditResult[],
  schema: LoadedSchema,
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
        const defaultValue = getDefaultValue(schema, parsed.frontmatter, issue.field);

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
      } else if (issue.code === 'format-violation' && issue.field && issue.expectedFormat) {
        // Auto-fix format violations
        const fixResult = await applyFix(schema, result.path, issue);
        if (fixResult.action === 'fixed') {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.green(`    ✓ Fixed ${issue.field} format to ${issue.expectedFormat}`));
          fixed++;
        } else {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.red(`    ✗ Failed to fix ${issue.field}: ${fixResult.message}`));
          failed++;
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

// ============================================================================
// Interactive Fix Mode
// ============================================================================

/**
 * Run interactive fixes, prompting for each issue.
 */
export async function runInteractiveFix(
  results: FileAuditResult[],
  schema: LoadedSchema,
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
      const fixOutcome = await handleInteractiveFix(schema, result, issue);
      
      if (fixOutcome === 'quit') {
        quit = true;
        console.log(chalk.dim('    → Quit'));
      } else if (fixOutcome === 'fixed') {
        fixed++;
      } else if (fixOutcome === 'failed') {
        failed++;
      } else {
        skipped++;
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
 * Handle interactive fix for a single issue.
 * Returns the outcome: 'fixed', 'skipped', 'failed', or 'quit'.
 */
async function handleInteractiveFix(
  schema: LoadedSchema,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  switch (issue.code) {
    case 'orphan-file':
      return handleOrphanFileFix(schema, result, issue);
    case 'missing-required':
      return handleMissingRequiredFix(schema, result, issue);
    case 'invalid-enum':
      return handleInvalidEnumFix(schema, result, issue);
    case 'unknown-field':
      return handleUnknownFieldFix(schema, result, issue);
    case 'format-violation':
      return handleFormatViolationFix(schema, result, issue);
    case 'stale-reference':
      return handleStaleReferenceFix(schema, result, issue);
    case 'owned-note-referenced':
      return handleOwnedNoteReferencedFix(schema, result, issue);
    case 'owned-wrong-location':
      return handleOwnedWrongLocationFix(schema, result, issue);
    case 'invalid-source-type':
      return handleInvalidSourceTypeFix(schema, result, issue);
    default:
      // Truly non-fixable issues
      if (issue.suggestion) {
        console.log(chalk.dim(`    ${issue.suggestion}`));
      }
      console.log(chalk.dim('    (Manual fix required - skipping)'));
      return 'skipped';
  }
}

async function handleOrphanFileFix(
  schema: LoadedSchema,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  let typePath: string | undefined;

  if (issue.inferredType) {
    // We know the expected type from the directory
    const confirm = await promptConfirm(
      `    → Add type fields for '${issue.inferredType}'?`
    );
    if (confirm === null) {
      return 'quit';
    }
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

      if (selectedType === null || selectedType === '[quit]') {
        return 'quit';
      } else if (selectedType === '[skip]') {
        console.log(chalk.dim('    → Skipped'));
        return 'skipped';
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

          if (selectedSubtype === null || selectedSubtype === '[quit]') {
            return 'quit';
          } else if (selectedSubtype === '[skip]') {
            console.log(chalk.dim('    → Skipped'));
            return 'skipped';
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
      return 'skipped';
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
      return 'fixed';
    } else {
      console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
      return 'failed';
    }
  }

  console.log(chalk.dim('    → Skipped'));
  return 'skipped';
}

async function handleMissingRequiredFix(
  schema: LoadedSchema,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  if (!issue.field) return 'skipped';

  const parsed = await parseNote(result.path);
  const defaultValue = getDefaultValue(schema, parsed.frontmatter, issue.field);

  if (defaultValue !== undefined) {
    // Has default value - offer to use it
    const confirm = await promptConfirm(`    → Add with default '${JSON.stringify(defaultValue)}'?`);
    if (confirm === null) {
      return 'quit';
    }
    if (confirm) {
      const fixResult = await applyFix(schema, result.path, issue, defaultValue);
      if (fixResult.action === 'fixed') {
        console.log(chalk.green(`    ✓ Added ${issue.field}: ${JSON.stringify(defaultValue)}`));
        return 'fixed';
      } else {
        console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
        return 'failed';
      }
    }
    console.log(chalk.dim('    → Skipped'));
    return 'skipped';
  }

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

    if (selected === null || selected === '[quit]') {
      return 'quit';
    } else if (selected === '[skip]') {
      console.log(chalk.dim('    → Skipped'));
      return 'skipped';
    }

    const fixResult = await applyFix(schema, result.path, issue, selected);
    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Added ${issue.field}: ${selected}`));
      return 'fixed';
    } else {
      console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
      return 'failed';
    }
  }

  // No enum - prompt for text input
  const value = await promptInput(`    Enter value for ${issue.field}:`);
  if (value === null) {
    return 'quit';
  }
  if (value) {
    const fixResult = await applyFix(schema, result.path, issue, value);
    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Added ${issue.field}: ${value}`));
      return 'fixed';
    } else {
      console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
      return 'failed';
    }
  }

  console.log(chalk.dim('    → Skipped'));
  return 'skipped';
}

async function handleInvalidEnumFix(
  schema: LoadedSchema,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  if (!issue.field || !issue.expected || !Array.isArray(issue.expected)) {
    console.log(chalk.dim('    (Cannot fix - skipping)'));
    return 'skipped';
  }

  const options = [...issue.expected, '[skip]', '[quit]'];
  const selected = await promptSelection(
    `    Select valid value for ${issue.field}:`,
    options
  );

  if (selected === null || selected === '[quit]') {
    return 'quit';
  } else if (selected === '[skip]') {
    console.log(chalk.dim('    → Skipped'));
    return 'skipped';
  }

  const fixResult = await applyFix(schema, result.path, issue, selected);
  if (fixResult.action === 'fixed') {
    console.log(chalk.green(`    ✓ Updated ${issue.field}: ${selected}`));
    return 'fixed';
  } else {
    console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
    return 'failed';
  }
}

async function handleUnknownFieldFix(
  schema: LoadedSchema,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  if (!issue.field) return 'skipped';

  if (issue.suggestion) {
    console.log(chalk.dim(`    ${issue.suggestion}`));
  }

  const options = ['[skip]', '[remove field]', '[quit]'];
  const selected = await promptSelection(
    `    Action for unknown field '${issue.field}':`,
    options
  );

  if (selected === null || selected === '[quit]') {
    return 'quit';
  } else if (selected === '[remove field]') {
    const fixResult = await removeField(schema, result.path, issue.field);
    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Removed field: ${issue.field}`));
      return 'fixed';
    } else {
      console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
      return 'failed';
    }
  }

  console.log(chalk.dim('    → Skipped'));
  return 'skipped';
}

async function handleFormatViolationFix(
  schema: LoadedSchema,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  if (!issue.field || !issue.expectedFormat || !issue.autoFixable) {
    console.log(chalk.dim('    (Cannot auto-fix - skipping)'));
    return 'skipped';
  }

  const confirm = await promptConfirm(
    `    → Convert to ${issue.expectedFormat} format?`
  );
  if (confirm === null) {
    return 'quit';
  }
  if (!confirm) {
    console.log(chalk.dim('    → Skipped'));
    return 'skipped';
  }

  const fixResult = await applyFix(schema, result.path, issue);
  if (fixResult.action === 'fixed') {
    console.log(chalk.green(`    ✓ Converted ${issue.field} to ${issue.expectedFormat}`));
    return 'fixed';
  } else {
    console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
    return 'failed';
  }
}

async function handleStaleReferenceFix(
  schema: LoadedSchema,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  // Stale references in body content can't be auto-fixed easily
  if (issue.inBody) {
    console.log(chalk.dim('    (Body reference - manual fix required)'));
    if (issue.similarFiles && issue.similarFiles.length > 0) {
      console.log(chalk.dim(`    Similar files: ${issue.similarFiles.slice(0, 3).join(', ')}`));
    }
    return 'skipped';
  }

  // For frontmatter fields, offer to select a similar file or clear
  if (!issue.field) {
    console.log(chalk.dim('    (Cannot fix - skipping)'));
    return 'skipped';
  }

  const options: string[] = [];
  if (issue.similarFiles && issue.similarFiles.length > 0) {
    options.push(...issue.similarFiles.slice(0, 5).map(f => `[[${f}]]`));
  }
  options.push('[clear field]', '[skip]', '[quit]');

  const selected = await promptSelection(
    `    Select replacement for '${issue.targetName}':`,
    options
  );

  if (selected === null || selected === '[quit]') {
    return 'quit';
  } else if (selected === '[skip]') {
    console.log(chalk.dim('    → Skipped'));
    return 'skipped';
  } else if (selected === '[clear field]') {
    // Clear the field by setting it to empty
    const fixResult = await applyFix(schema, result.path, { ...issue, code: 'invalid-enum' }, '');
    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Cleared ${issue.field}`));
      return 'fixed';
    } else {
      console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
      return 'failed';
    }
  } else {
    // User selected a similar file
    const fixResult = await applyFix(schema, result.path, { ...issue, code: 'invalid-enum' }, selected);
    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Updated ${issue.field}: ${selected}`));
      return 'fixed';
    } else {
      console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
      return 'failed';
    }
  }
}

/**
 * Handle owned-note-referenced fix.
 * 
 * This occurs when a note references an owned note via a schema field.
 * Owned notes can only be referenced by their owner.
 * 
 * Options:
 * 1. Clear the reference field
 * 2. Skip (requires manual resolution)
 * 
 * Moving the owned note to shared space would require:
 * - Removing it from owner's field
 * - Moving the file
 * - Updating the reference here
 * This is too complex for automatic fix.
 */
async function handleOwnedNoteReferencedFix(
  schema: LoadedSchema,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  if (!issue.field) {
    console.log(chalk.dim('    (Cannot fix - no field specified)'));
    return 'skipped';
  }

  // Show context
  console.log(chalk.dim(`    Owned by: ${issue.ownerPath}`));
  console.log(chalk.dim('    Options: Clear reference or manually move the note to shared location'));

  const options = ['[clear reference]', '[skip]', '[quit]'];
  const selected = await promptSelection(
    `    Action for reference to owned note:`,
    options
  );

  if (selected === null || selected === '[quit]') {
    return 'quit';
  } else if (selected === '[clear reference]') {
    // Clear the field
    const fixResult = await applyFix(schema, result.path, { ...issue, code: 'invalid-enum' }, '');
    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Cleared ${issue.field}`));
      return 'fixed';
    } else {
      console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
      return 'failed';
    }
  }

  console.log(chalk.dim('    → Skipped'));
  return 'skipped';
}

/**
 * Handle invalid-source-type fix.
 * 
 * This occurs when a context field references a note of the wrong type.
 * For example, a task's milestone field referencing an objective instead of a milestone.
 * 
 * Options:
 * 1. Select a valid note of the correct type
 * 2. Clear the field
 * 3. Skip (leave for manual fix)
 */
async function handleInvalidSourceTypeFix(
  schema: LoadedSchema,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  if (!issue.field) {
    console.log(chalk.dim('    (Cannot fix - no field specified)'));
    return 'skipped';
  }

  // Get the source type constraint from the schema
  const parsed = await parseNote(result.path);
  const typePath = resolveTypePathFromFrontmatter(schema, parsed.frontmatter);
  if (!typePath) {
    console.log(chalk.dim('    (Cannot fix - unknown type)'));
    return 'skipped';
  }

  const fields = getFieldsForType(schema, typePath);
  const field = fields[issue.field];
  if (!field || !field.source) {
    console.log(chalk.dim('    (Cannot fix - field source not defined)'));
    return 'skipped';
  }

  // Show context about the type mismatch
  console.log(chalk.dim(`    Current value: ${issue.value}`));
  console.log(chalk.dim(`    Target type: ${issue.actualType}`));
  const expectedTypes = Array.isArray(issue.expected) ? issue.expected.join(', ') : issue.expected;
  console.log(chalk.dim(`    Expected types: ${expectedTypes || field.source}`));

  // Query for valid notes of the correct source type
  const vaultDir = result.path.substring(0, result.path.indexOf(result.relativePath));
  const validNotes = await queryByType(schema, vaultDir, field.source);

  // Build options
  const options: string[] = [];
  if (validNotes.length > 0) {
    // Format as wikilinks
    options.push(...validNotes.slice(0, 20).map(n => `[[${n}]]`));
    if (validNotes.length > 20) {
      options.push(`... (${validNotes.length - 20} more)`);
    }
  }
  options.push('[clear field]', '[skip]', '[quit]');

  const selected = await promptSelection(
    `    Select valid ${field.source}:`,
    options
  );

  if (selected === null || selected === '[quit]') {
    return 'quit';
  } else if (selected === '[skip]' || selected.startsWith('... (')) {
    console.log(chalk.dim('    → Skipped'));
    return 'skipped';
  } else if (selected === '[clear field]') {
    const fixResult = await applyFix(schema, result.path, issue, '');
    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Cleared ${issue.field}`));
      return 'fixed';
    } else {
      console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
      return 'failed';
    }
  } else {
    // User selected a valid note
    const fixResult = await applyFix(schema, result.path, issue, selected);
    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Updated ${issue.field}: ${selected}`));
      return 'fixed';
    } else {
      console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
      return 'failed';
    }
  }
}

/**
 * Handle owned-wrong-location fix.
 * 
 * This occurs when an owned note is not in the expected location
 * (e.g., should be in owner's folder but isn't).
 * 
 * Automatic fix would require:
 * 1. Moving the file to correct location
 * 2. Updating all wikilinks that reference the moved file
 * 
 * This is complex and risky, so we just provide guidance.
 */
async function handleOwnedWrongLocationFix(
  _schema: LoadedSchema,
  _result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  // Show context
  console.log(chalk.dim(`    Expected location: ${issue.expected}`));
  console.log(chalk.dim(`    Owner: ${issue.ownerPath}`));
  console.log(chalk.dim('    To fix: Move the file manually and update any wikilinks'));

  const options = ['[skip]', '[quit]'];
  const selected = await promptSelection(
    `    Action for misplaced owned note:`,
    options
  );

  if (selected === null || selected === '[quit]') {
    return 'quit';
  }

  console.log(chalk.dim('    → Skipped (manual fix required)'));
  return 'skipped';
}
