/**
 * Audit command - validate vault files against schema.
 * 
 * This command checks all managed files for schema violations and
 * offers various modes for fixing issues.
 */

import { Command } from 'commander';
import {
  loadSchema,
  getTypeDefByPath,
} from '../lib/schema.js';
import { resolveVaultDir } from '../lib/vault.js';
import { printError } from '../lib/prompt.js';
import {
  printJson,
  jsonError,
  ExitCodes,
} from '../lib/output.js';
// Schema type used only in re-exports

// Import from audit modules
import {
  type AuditIssue,
  type FileAuditResult,
  type AuditSummary,
  type FixSummary,
  type ManagedFile,
  type AuditRunOptions,
  type IssueCode,
  type AuditOptions,
} from '../lib/audit/types.js';
import {
  runAudit,
  discoverManagedFiles,
  auditFile,
} from '../lib/audit/detection.js';
import {
  collectPooledFiles,
  collectInstanceGroupedFiles,
} from '../lib/discovery.js';
import {
  runAutoFix,
  runInteractiveFix,
} from '../lib/audit/fix.js';
import {
  calculateSummary,
  outputJsonResults,
  outputTextResults,
  outputFixResults,
  showAvailableTypes,
} from '../lib/audit/output.js';

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
  format-violation  Field value doesn't match expected format (wikilink, etc.)
  stale-reference   Wikilink points to non-existent file

Examples:
  ovault audit                      # Check all files (report only)
  ovault audit objective/task       # Check only tasks
  ovault audit --strict             # Error on unknown fields
  ovault audit --path "Ideas/"      # Check specific directory
  ovault audit --only missing-required
  ovault audit --ignore unknown-field
  ovault audit --output json        # JSON output for CI
  ovault audit --allow-field custom # Allow specific extra field`)
  .argument('[type]', 'Type path to audit (e.g., idea, objective/task)')
  .option('--strict', 'Treat unknown fields as errors instead of warnings')
  .option('--path <path>', 'Limit audit to files matching path pattern')
  .option('--only <issue-type>', 'Only report specific issue type')
  .option('--ignore <issue-type>', 'Ignore specific issue type')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .option('--fix', 'Interactive repair mode')
  .option('--auto', 'With --fix: automatically apply unambiguous fixes')
  .option('--allow-field <fields...>', 'Allow additional fields beyond schema (repeatable)')
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

      // Build allowed fields set from CLI option
      const allowedFields = options.allowField
        ? new Set(options.allowField)
        : undefined;

      // Run audit
      const results = await runAudit(schema, vaultDir, {
        typePath,
        strict: options.strict ?? false,
        pathFilter: options.path,
        onlyIssue: options.only as IssueCode | undefined,
        ignoreIssue: options.ignore as IssueCode | undefined,
        allowedFields,
        vaultDir,
        schema,
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
// Re-exports for Testing
// ============================================================================

export {
  // Types
  type AuditIssue,
  type FileAuditResult,
  type AuditSummary,
  type FixSummary,
  type ManagedFile,
  type AuditRunOptions,
  type IssueCode,
  
  // Detection functions
  runAudit,
  discoverManagedFiles,
  auditFile,
  collectPooledFiles,
  collectInstanceGroupedFiles,
  
  // Fix functions
  runAutoFix,
  runInteractiveFix,
  
  // Output functions
  calculateSummary,
  outputJsonResults,
  outputTextResults,
  outputFixResults,
};
