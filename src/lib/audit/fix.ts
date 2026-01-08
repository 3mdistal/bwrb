/**
 * Audit fix operations.
 * 
 * This module handles applying fixes to audit issues.
 */

import chalk from 'chalk';
import { join, dirname, basename } from 'path';
import {
  getType,
  getFieldsForType,
  resolveTypeFromFrontmatter,
  getDiscriminatorFieldsFromTypePath,
  getOptionsForField,
  getConcreteTypeNames,
  getTypeFamilies,
} from '../schema.js';
import { queryByType } from '../vault.js';
import { parseNote, writeNote } from '../frontmatter.js';
import { levenshteinDistance } from '../discovery.js';
import { promptSelection, promptConfirm, promptInput } from '../prompt.js';
import type { LoadedSchema } from '../../types/schema.js';
import {
  findAllMarkdownFiles,
  findWikilinksToFile,
  executeBulkMove,
} from '../bulk/move.js';

// Alias for backward compatibility
const resolveTypePathFromFrontmatter = resolveTypeFromFrontmatter;
const getTypeDefByPath = getType;
import {
  type AuditIssue,
  type FileAuditResult,
  type FixResult,
  type FixSummary,
  type FixContext,
  toWikilink,
  toMarkdownLink,
} from './types.js';

// ============================================================================
// Fix Application
// ============================================================================

/**
 * Apply a single fix to a file.
 */
async function applyFix(
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
      case 'invalid-option': {
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
            } else if (issue.expectedFormat === 'markdown') {
              frontmatter[issue.field] = toMarkdownLink(currentValue);
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
async function removeField(
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
function getDefaultValue(
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
// High-Confidence Match Detection
// ============================================================================

/**
 * Check if a similar file is a high-confidence match for auto-fix.
 * 
 * High confidence means:
 * - Levenshtein distance <= 2 (very similar names)
 * - OR one is a prefix/suffix of the other (typo at start/end)
 * - OR case-insensitive exact match
 */
function isHighConfidenceMatch(target: string, similar: string): boolean {
  const targetLower = target.toLowerCase();
  const similarLower = similar.toLowerCase();
  
  // Case-insensitive exact match
  if (targetLower === similarLower) {
    return true;
  }
  
  // Prefix/suffix relationship (handles singular/plural, minor additions)
  if (targetLower.startsWith(similarLower) || similarLower.startsWith(targetLower)) {
    const diff = Math.abs(target.length - similar.length);
    if (diff <= 2) {
      return true;
    }
  }
  
  // Levenshtein distance <= 2
  const distance = levenshteinDistance(targetLower, similarLower);
  if (distance <= 2) {
    return true;
  }
  
  return false;
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
  vaultDir: string,
  options?: { execute?: boolean }
): Promise<FixSummary> {
  const execute = options?.execute ?? false;
  
  console.log(chalk.bold('Auditing vault...\n'));
  console.log(chalk.bold('Auto-fixing unambiguous issues...\n'));

  let fixed = 0;
  let skipped = 0;
  let failed = 0;
  const manualReviewNeeded: { file: string; issue: AuditIssue }[] = [];

  for (const result of results) {
    const fixableIssues = result.issues.filter(i => i.autoFixable);
    const nonFixableIssues = result.issues.filter(i => !i.autoFixable);

    // Handle wrong-directory issues (require --execute)
    for (const issue of [...fixableIssues]) {
      if (issue.code === 'wrong-directory' && issue.expectedDirectory) {
        if (!execute) {
          // Show what would be done
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.yellow(`    ⚠ Would move to ${issue.expectedDirectory}/ (use --execute to apply)`));
          skipped++;
          // Remove from fixableIssues so we don't process it again
          const idx = fixableIssues.indexOf(issue);
          if (idx > -1) fixableIssues.splice(idx, 1);
          continue;
        }
        
        // Get wikilink count for warning
        const allFiles = await findAllMarkdownFiles(vaultDir);
        const refs = await findWikilinksToFile(vaultDir, result.path, allFiles);
        
        if (refs.length > 0) {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.yellow(`    ⚠ ${refs.length} wikilink(s) will be updated`));
        }
        
        // Execute the move
        const targetDir = join(vaultDir, issue.expectedDirectory);
        const moveResult = await executeBulkMove({
          vaultDir,
          targetDir,
          filesToMove: [result.path],
          execute: true,
          allVaultFiles: allFiles,
        });
        
        if (moveResult.errors.length === 0) {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.green(`    ✓ Moved to ${issue.expectedDirectory}/`));
          if (moveResult.totalLinksUpdated > 0) {
            console.log(chalk.green(`    ✓ Updated ${moveResult.totalLinksUpdated} wikilink(s)`));
          }
          fixed++;
        } else {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.red(`    ✗ Failed to move: ${moveResult.errors[0]}`));
          failed++;
        }
        
        // Remove from fixableIssues so we don't process it again
        const idx = fixableIssues.indexOf(issue);
        if (idx > -1) fixableIssues.splice(idx, 1);
        continue;
      }
      
      // Handle owned-wrong-location issues (require --execute)
      if (issue.code === 'owned-wrong-location' && issue.expectedDirectory) {
        if (!execute) {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.yellow(`    ⚠ Would move to ${issue.expectedDirectory}/ (use --execute to apply)`));
          skipped++;
          const idx = fixableIssues.indexOf(issue);
          if (idx > -1) fixableIssues.splice(idx, 1);
          continue;
        }
        
        // Get wikilink count for warning
        const allFiles = await findAllMarkdownFiles(vaultDir);
        const refs = await findWikilinksToFile(vaultDir, result.path, allFiles);
        
        if (refs.length > 0) {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.yellow(`    ⚠ ${refs.length} wikilink(s) will be updated`));
        }
        
        // Execute the move
        const targetDir = join(vaultDir, issue.expectedDirectory);
        const moveResult = await executeBulkMove({
          vaultDir,
          targetDir,
          filesToMove: [result.path],
          execute: true,
          allVaultFiles: allFiles,
        });
        
        if (moveResult.errors.length === 0) {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.green(`    ✓ Moved to ${issue.expectedDirectory}/`));
          if (moveResult.totalLinksUpdated > 0) {
            console.log(chalk.green(`    ✓ Updated ${moveResult.totalLinksUpdated} wikilink(s)`));
          }
          fixed++;
        } else {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.red(`    ✗ Failed to move: ${moveResult.errors[0]}`));
          failed++;
        }
        
        const idx = fixableIssues.indexOf(issue);
        if (idx > -1) fixableIssues.splice(idx, 1);
        continue;
      }
    }
    
    // Handle stale-reference issues with high-confidence matches
    for (const issue of nonFixableIssues) {
      if (issue.code === 'stale-reference' && !issue.inBody && issue.field) {
        // Check for high-confidence match
        if (issue.similarFiles?.length === 1 && 
            issue.targetName && 
            isHighConfidenceMatch(issue.targetName, issue.similarFiles[0]!)) {
          const replacement = `[[${issue.similarFiles[0]}]]`;
          const fixResult = await applyFix(schema, result.path, { ...issue, code: 'invalid-option' }, replacement);
          if (fixResult.action === 'fixed') {
            console.log(chalk.cyan(`  ${result.relativePath}`));
            console.log(chalk.green(`    ✓ Fixed ${issue.field}: [[${issue.targetName}]] → ${replacement}`));
            fixed++;
            continue; // Don't add to manual review
          } else {
            console.log(chalk.cyan(`  ${result.relativePath}`));
            console.log(chalk.red(`    ✗ Failed to fix ${issue.field}: ${fixResult.message}`));
            failed++;
            continue;
          }
        }
      }
      // Queue for manual review if not auto-fixed
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
  vaultDir: string,
  options?: { execute?: boolean }
): Promise<FixSummary> {
  const execute = options?.execute ?? false;
  const context: FixContext = { schema, vaultDir, execute };
  
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
      const fixOutcome = await handleInteractiveFix(context, result, issue);
      
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
  context: FixContext,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  const { schema } = context;
  
  switch (issue.code) {
    case 'orphan-file':
      return handleOrphanFileFix(schema, result, issue);
    case 'missing-required':
      return handleMissingRequiredFix(schema, result, issue);
    case 'invalid-option':
      return handleInvalidOptionFix(schema, result, issue);
    case 'invalid-type':
      return handleInvalidTypeFix(schema, result, issue);
    case 'unknown-field':
      return handleUnknownFieldFix(schema, result, issue);
    case 'format-violation':
      return handleFormatViolationFix(schema, result, issue);
    case 'stale-reference':
      return handleStaleReferenceFix(schema, result, issue);
    case 'owned-note-referenced':
      return handleOwnedNoteReferencedFix(schema, result, issue);
    case 'wrong-directory':
      return handleWrongDirectoryFix(context, result, issue);
    case 'owned-wrong-location':
      return handleOwnedWrongLocationFix(context, result, issue);
    case 'invalid-source-type':
      return handleInvalidSourceTypeFix(schema, result, issue);
    case 'parent-cycle':
      return handleParentCycleFix(schema, result, issue);
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
    // Need to prompt user to select type from available types
    const availableTypes = getConcreteTypeNames(schema);
    if (availableTypes.length > 0) {
      const typeOptions = [...availableTypes, '[skip]', '[quit]'];
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

      typePath = selectedType;
    } else {
      console.log(chalk.dim('    (No types defined - skipping)'));
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

  // No default - check if field has options or allow text input
  const typePath = resolveTypePathFromFrontmatter(schema, parsed.frontmatter);
  const fieldOptions = typePath ? getOptionsForField(schema, typePath, issue.field) : [];

  if (fieldOptions.length > 0) {
    // Field has options - prompt to select
    const options = [...fieldOptions, '[skip]', '[quit]'];
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

async function handleInvalidOptionFix(
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
    const fixResult = await applyFix(schema, result.path, { ...issue, code: 'invalid-option' }, '');
    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Cleared ${issue.field}`));
      return 'fixed';
    } else {
      console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
      return 'failed';
    }
  } else {
    // User selected a similar file
    const fixResult = await applyFix(schema, result.path, { ...issue, code: 'invalid-option' }, selected);
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
    const fixResult = await applyFix(schema, result.path, { ...issue, code: 'invalid-option' }, '');
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
 * Options:
 * 1. Move file to correct location (requires --execute)
 * 2. Skip (leave for manual fix)
 */
async function handleOwnedWrongLocationFix(
  context: FixContext,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  const { vaultDir, execute } = context;
  
  // Show context
  console.log(chalk.dim(`    Expected location: ${issue.expectedDirectory}/`));
  console.log(chalk.dim(`    Owner: ${issue.ownerPath}`));
  
  // Check for wikilinks that will be affected
  const allFiles = await findAllMarkdownFiles(vaultDir);
  const refs = await findWikilinksToFile(vaultDir, result.path, allFiles);
  
  if (refs.length > 0) {
    console.log(chalk.yellow(`    ⚠ ${refs.length} wikilink(s) will be updated`));
  }

  const options = execute 
    ? ['[move file]', '[skip]', '[quit]']
    : ['[skip] (use --execute to enable move)', '[quit]'];
  
  const selected = await promptSelection(
    `    Action for misplaced owned note:`,
    options
  );

  if (selected === null || selected === '[quit]') {
    return 'quit';
  } else if (selected === '[move file]' && issue.expectedDirectory) {
    // Execute the move
    const targetDir = join(vaultDir, issue.expectedDirectory);
    const moveResult = await executeBulkMove({
      vaultDir,
      targetDir,
      filesToMove: [result.path],
      execute: true,
      allVaultFiles: allFiles,
    });
    
    if (moveResult.errors.length === 0) {
      console.log(chalk.green(`    ✓ Moved to ${issue.expectedDirectory}/`));
      if (moveResult.totalLinksUpdated > 0) {
        console.log(chalk.green(`    ✓ Updated ${moveResult.totalLinksUpdated} wikilink(s)`));
      }
      return 'fixed';
    } else {
      console.log(chalk.red(`    ✗ Failed to move: ${moveResult.errors[0]}`));
      return 'failed';
    }
  }

  console.log(chalk.dim('    → Skipped'));
  return 'skipped';
}

/**
 * Handle wrong-directory fix.
 * 
 * This occurs when a file is in the wrong directory for its type.
 * 
 * Options:
 * 1. Move file to correct directory (requires --execute)
 * 2. Skip (leave for manual fix)
 */
async function handleWrongDirectoryFix(
  context: FixContext,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  const { vaultDir, execute } = context;
  
  // Show context
  console.log(chalk.dim(`    Current location: ${dirname(result.relativePath)}/`));
  console.log(chalk.dim(`    Expected location: ${issue.expectedDirectory}/`));
  
  // Check for wikilinks that will be affected
  const allFiles = await findAllMarkdownFiles(vaultDir);
  const refs = await findWikilinksToFile(vaultDir, result.path, allFiles);
  
  if (refs.length > 0) {
    console.log(chalk.yellow(`    ⚠ ${refs.length} wikilink(s) will be updated`));
  }

  const options = execute 
    ? ['[move file]', '[skip]', '[quit]']
    : ['[skip] (use --execute to enable move)', '[quit]'];
  
  const selected = await promptSelection(
    `    Action for wrong directory:`,
    options
  );

  if (selected === null || selected === '[quit]') {
    return 'quit';
  } else if (selected === '[move file]' && issue.expectedDirectory) {
    // Execute the move
    const targetDir = join(vaultDir, issue.expectedDirectory);
    const moveResult = await executeBulkMove({
      vaultDir,
      targetDir,
      filesToMove: [result.path],
      execute: true,
      allVaultFiles: allFiles,
    });
    
    if (moveResult.errors.length === 0) {
      console.log(chalk.green(`    ✓ Moved to ${issue.expectedDirectory}/`));
      if (moveResult.totalLinksUpdated > 0) {
        console.log(chalk.green(`    ✓ Updated ${moveResult.totalLinksUpdated} wikilink(s)`));
      }
      return 'fixed';
    } else {
      console.log(chalk.red(`    ✗ Failed to move: ${moveResult.errors[0]}`));
      return 'failed';
    }
  }

  console.log(chalk.dim('    → Skipped'));
  return 'skipped';
}

/**
 * Handle invalid-type fix.
 * 
 * This occurs when the type field value is not recognized.
 * 
 * Options:
 * 1. Select a valid type from the schema
 * 2. Skip (leave for manual fix)
 */
async function handleInvalidTypeFix(
  schema: LoadedSchema,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  // Get available types
  const availableTypes = getTypeFamilies(schema);
  
  if (availableTypes.length === 0) {
    console.log(chalk.dim('    (No types defined in schema - skipping)'));
    return 'skipped';
  }
  
  // Show current invalid value
  console.log(chalk.dim(`    Current value: ${issue.value}`));
  if (issue.suggestion) {
    console.log(chalk.dim(`    ${issue.suggestion}`));
  }
  
  const options = [...availableTypes, '[skip]', '[quit]'];
  const selected = await promptSelection(
    '    Select valid type:',
    options
  );

  if (selected === null || selected === '[quit]') {
    return 'quit';
  } else if (selected === '[skip]') {
    console.log(chalk.dim('    → Skipped'));
    return 'skipped';
  }

  // Apply the fix - update the type field
  const fixResult = await applyFix(schema, result.path, { ...issue, code: 'orphan-file' }, selected);
  if (fixResult.action === 'fixed') {
    const fields = getDiscriminatorFieldsFromTypePath(selected);
    const fieldStr = Object.entries(fields)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
    console.log(chalk.green(`    ✓ Updated ${fieldStr}`));
    return 'fixed';
  } else {
    console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
    return 'failed';
  }
}

/**
 * Handle parent-cycle fix.
 * 
 * This occurs when a recursive type has a cycle in its parent references.
 * E.g., A -> B -> A creates a cycle.
 * 
 * Options:
 * 1. Clear the parent field
 * 2. Select a different parent
 * 3. Skip (leave for manual fix)
 */
async function handleParentCycleFix(
  schema: LoadedSchema,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  // Show the cycle path
  if (issue.cyclePath && issue.cyclePath.length > 0) {
    console.log(chalk.dim(`    Cycle: ${issue.cyclePath.join(' → ')}`));
  }
  
  // Get the current note's name to exclude from parent options
  const noteName = basename(result.path, '.md');
  
  // Get notes of the same type to offer as alternative parents
  const parsed = await parseNote(result.path);
  const typePath = resolveTypePathFromFrontmatter(schema, parsed.frontmatter);
  let validParents: string[] = [];
  
  if (typePath) {
    const vaultDir = result.path.substring(0, result.path.indexOf(result.relativePath));
    const sameTypeNotes = await queryByType(schema, vaultDir, typePath);
    // Filter out the current note and notes in the cycle
    const cycleSet = new Set(issue.cyclePath ?? []);
    validParents = sameTypeNotes.filter(n => n !== noteName && !cycleSet.has(n));
  }
  
  // Build options
  const options: string[] = ['[clear parent]'];
  if (validParents.length > 0) {
    // Add up to 10 valid parent options as wikilinks
    options.push(...validParents.slice(0, 10).map(n => `[[${n}]]`));
    if (validParents.length > 10) {
      options.push(`... (${validParents.length - 10} more options)`);
    }
  }
  options.push('[skip]', '[quit]');
  
  const selected = await promptSelection(
    '    Action for parent cycle:',
    options
  );

  if (selected === null || selected === '[quit]') {
    return 'quit';
  } else if (selected === '[skip]' || selected.startsWith('... (')) {
    console.log(chalk.dim('    → Skipped'));
    return 'skipped';
  } else if (selected === '[clear parent]') {
    // Clear the parent field
    const fixResult = await applyFix(schema, result.path, { ...issue, code: 'invalid-option', field: 'parent' }, '');
    if (fixResult.action === 'fixed') {
      console.log(chalk.green('    ✓ Cleared parent field'));
      return 'fixed';
    } else {
      console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
      return 'failed';
    }
  } else {
    // User selected a new parent
    const fixResult = await applyFix(schema, result.path, { ...issue, code: 'invalid-option', field: 'parent' }, selected);
    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Updated parent: ${selected}`));
      return 'fixed';
    } else {
      console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
      return 'failed';
    }
  }
}
