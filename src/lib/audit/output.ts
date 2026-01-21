/**
 * Audit output formatting.
 * 
 * This module handles output formatting for audit results.
 */

import chalk from 'chalk';
import {
  printJson,
  jsonSuccess,
} from '../output.js';
import {
  type FileAuditResult,
  type AuditSummary,
  type FixSummary,
} from './types.js';

// ============================================================================
// Summary Calculation
// ============================================================================

/**
 * Calculate summary statistics from results.
 */
export function calculateSummary(results: FileAuditResult[]): AuditSummary {
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

// ============================================================================
// JSON Output
// ============================================================================

/**
 * Output results as JSON.
 */
export function outputJsonResults(results: FileAuditResult[], summary: AuditSummary): void {
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
        ...(i.inferredType && { inferredType: i.inferredType }),
        ...(i.expectedFormat && { expectedFormat: i.expectedFormat }),
        ...(i.targetName && { targetName: i.targetName }),
        ...(i.similarFiles && { similarFiles: i.similarFiles }),
        ...(i.inBody !== undefined && { inBody: i.inBody }),
        ...(i.lineNumber !== undefined && { lineNumber: i.lineNumber }),
        ...(i.expectedType && { expectedType: i.expectedType }),
        ...(i.actualType && { actualType: i.actualType }),
        ...(i.ownerPath && { ownerPath: i.ownerPath }),
        ...(i.ownedNotePath && { ownedNotePath: i.ownedNotePath }),
        ...(i.cyclePath && { cyclePath: i.cyclePath }),
        ...(i.currentDirectory && { currentDirectory: i.currentDirectory }),
        ...(i.expectedDirectory && { expectedDirectory: i.expectedDirectory }),
        ...(i.wikilinkCount !== undefined && { wikilinkCount: i.wikilinkCount }),
        // Phase 2: Hygiene fields
        ...(i.canonicalKey && { canonicalKey: i.canonicalKey }),
        ...(i.canonicalValue && { canonicalValue: i.canonicalValue }),
        ...(i.hasConflict !== undefined && { hasConflict: i.hasConflict }),
        ...(i.conflictValue !== undefined && { conflictValue: i.conflictValue }),
        // Phase 4: Structural integrity fields
        ...(i.duplicateKey && { duplicateKey: i.duplicateKey }),
        ...(i.duplicateCount !== undefined && { duplicateCount: i.duplicateCount }),
        ...(i.listIndex !== undefined && { listIndex: i.listIndex }),
        ...(i.fixedValue && { fixedValue: i.fixedValue }),
        ...(i.candidates && { candidates: i.candidates }),
      })),
    })),
    summary,
  };

  printJson(output);
}

// ============================================================================
// Text Output
// ============================================================================

/**
 * Output results as text.
 */
export function outputTextResults(
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

      // Show similar files for stale references
      if (issue.similarFiles && issue.similarFiles.length > 0) {
        const display = issue.similarFiles.length <= 3
          ? issue.similarFiles.join(', ')
          : `${issue.similarFiles.slice(0, 3).join(', ')}... (${issue.similarFiles.length} more)`;
        console.log(chalk.dim(`    Similar files: ${display}`));
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
    console.log(chalk.dim("Run 'bwrb audit --path \"Ideas/**\" --fix' (or use --type/--where/--body/--all), or add '--dry-run' to preview."));
  }
}

// ============================================================================
// Fix Results Output
// ============================================================================

/**
 * Output fix operation results.
 */
export function outputFixResults(summary: FixSummary, autoMode: boolean): void {
  console.log('');

  if (summary.dryRun) {
    console.log(chalk.yellow('Dry run - no changes will be made'));
  }

  console.log(chalk.bold('Summary:'));

  const fixedLabel = summary.dryRun ? 'Would fix' : 'Fixed';
  const skippedLabel = summary.dryRun ? 'Would skip' : 'Skipped';
  console.log(`  ${fixedLabel}: ${summary.fixed} issues`);
  console.log(`  ${skippedLabel}: ${summary.skipped} issues`);
  if (summary.failed > 0) {
    console.log(`  Failed: ${summary.failed} issues`);
  }
  console.log(`  Remaining: ${summary.remaining} issues`);

  if (summary.remaining > 0 && autoMode) {
    console.log('');
    console.log(chalk.dim("Re-run without '--auto' to resolve remaining issues interactively."));
  }

  if (summary.dryRun && autoMode) {
    console.log('');
    console.log(chalk.dim("Re-run with '--execute' to apply fixes."));
  }

  if (!autoMode && summary.remaining > 0) {
    console.log('');
    console.log(chalk.dim("Re-run with '--execute' to apply fixes."));
  }
}

// ============================================================================
// Helper Output
// ============================================================================

/**
 * Show available types when invalid type is specified.
 */
export async function showAvailableTypes(schema: import('../../types/schema.js').LoadedSchema): Promise<void> {
  // Import dynamically to avoid circular deps
  const { getTypeFamilies, getTypeDefByPath, hasSubtypes, getSubtypeKeys } = await import('../schema.js');
  
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
