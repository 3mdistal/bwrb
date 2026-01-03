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
import { printError, printWarning } from '../lib/prompt.js';
import {
  printJson,
  jsonError,
  ExitCodes,
} from '../lib/output.js';
import {
  parsePositionalArg,
  getTypePositionalDeprecationWarning,
} from '../lib/targeting.js';

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

Targeting Options:
  --type <type>     Filter by type (e.g., idea, objective/task)
  --path <glob>     Filter by file path pattern
  --where <expr>    Filter by frontmatter expression
  --text <query>    Filter by body content

Examples:
  pika audit                      # Check all files (report only)
  pika audit --type objective/task  # Check only tasks
  pika audit --strict             # Error on unknown fields
  pika audit --path "Ideas/**"    # Check specific directory
  pika audit --where "status=active"  # Check files with specific status
  pika audit --text "TODO"        # Check files containing TODO
  pika audit --only missing-required
  pika audit --ignore unknown-field
  pika audit --output json        # JSON output for CI
  pika audit --allow-field custom # Allow specific extra field`)
  .argument('[target]', 'Type, path, or where expression (auto-detected)')
  .option('-t, --type <type>', 'Filter by type path (e.g., idea, objective/task)')
  .option('-p, --path <glob>', 'Filter by file path pattern')
  .option('-w, --where <expr...>', 'Filter by frontmatter expression')
  .option('--text <query>', 'Filter by body content')
  .option('--strict', 'Treat unknown fields as errors instead of warnings')
  .option('--only <issue-type>', 'Only report specific issue type')
  .option('--ignore <issue-type>', 'Ignore specific issue type')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .option('--fix', 'Interactive repair mode')
  .option('--auto', 'With --fix: automatically apply unambiguous fixes')
  .option('--allow-field <fields...>', 'Allow additional fields beyond schema (repeatable)')
  .action(async (target: string | undefined, options: AuditOptions & {
    type?: string;
    where?: string[];
    text?: string;
  }, cmd: Command) => {
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

      // Build targeting options from flags
      let typePath = options.type;
      let pathGlob = options.path;
      let whereExprs = options.where;

      // Handle positional argument with smart detection
      if (target) {
        if (typePath || pathGlob || whereExprs) {
          // Positional provided along with explicit flags - emit deprecation warning
          const deprecation = getTypePositionalDeprecationWarning('audit');
          if (deprecation) {
            printWarning(deprecation);
          }
        }
        
        const existingOpts: Record<string, string | string[] | undefined> = {};
        if (typePath) existingOpts.type = typePath;
        if (pathGlob) existingOpts.path = pathGlob;
        if (whereExprs) existingOpts.where = whereExprs;
        const parsed = parsePositionalArg(target, schema, existingOpts as import('../lib/targeting.js').TargetingOptions);
        if (parsed.error) {
          if (jsonMode) {
            printJson(jsonError(parsed.error));
            process.exit(ExitCodes.VALIDATION_ERROR);
          }
          printError(parsed.error);
          process.exit(1);
        }
        
        // Apply parsed positional to appropriate option
        if (parsed.options.type && !typePath) {
          typePath = parsed.options.type;
          // Emit deprecation warning for positional type
          const deprecation = getTypePositionalDeprecationWarning('audit');
          if (deprecation) {
            printWarning(deprecation);
          }
        }
        if (parsed.options.path && !pathGlob) {
          pathGlob = parsed.options.path;
        }
        if (parsed.options.where && !whereExprs) {
          whereExprs = parsed.options.where;
        }
      }

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

      // Run audit with unified targeting options
      const results = await runAudit(schema, vaultDir, {
        typePath,
        strict: options.strict ?? false,
        pathFilter: pathGlob,
        whereExpressions: whereExprs,
        textQuery: options.text,
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
