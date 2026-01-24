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
import { getGlobalOpts } from '../lib/command.js';
import { printError, printWarning } from '../lib/prompt.js';
import {
  printJson,
  jsonError,
  ExitCodes,
} from '../lib/output.js';
import {
  parsePositionalArg,
  hasAnyTargeting,
} from '../lib/targeting.js';

// Import from audit modules
import {
  type AuditIssue,
  type AuditSummary,
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
  orphan-file           File in managed directory but no 'type' field
  invalid-type          Type field value not recognized
  missing-required      Required field is missing
  invalid-option        Field value not in allowed option values
  unknown-field         Field not defined in schema (warning by default)
  wrong-directory       File location doesn't match its type
  owned-wrong-location  Owned note not in expected location
  parent-cycle          Cycle detected in parent references
  self-reference        Relation field references the same note
  ambiguous-link-target Relation target matches multiple files
  invalid-list-element  List field contains non-string values
  format-violation      Field value doesn't match expected format (wikilink, etc.)
  stale-reference       Wikilink points to non-existent file
  frontmatter-not-at-top Frontmatter block is not at top
  duplicate-frontmatter-keys Duplicate YAML keys in frontmatter
  malformed-wikilink    Near-wikilink bracket typo (frontmatter only)

Type Resolution:
  Audit resolves each file's type from its frontmatter 'type' field.
  If 'type' is missing or invalid, audit reports orphan-file/invalid-type
  and skips type-dependent checks (missing-required, invalid-option, etc.).
  Use --type to filter by type; it does not fix missing type fields.

Targeting Options:
  --type <type>     Filter by type (e.g., idea, objective/task)
  --path <glob>     Filter by file path pattern
  --where <expr>    Filter by frontmatter expression
  --body <query>    Filter by body content
  --all             Target all files (explicit vault-wide selector)

Examples:
  bwrb audit                      # Check all files (report only)
  bwrb audit --type objective/task  # Check only tasks
  bwrb audit --strict             # Error on unknown fields
  bwrb audit --path "Ideas/**"    # Check specific directory
  bwrb audit --where "status=active"  # Check files with specific status
  bwrb audit --body "TODO"        # Check files containing TODO
  bwrb audit --only missing-required
  bwrb audit --ignore unknown-field
  bwrb audit --output json        # JSON output for CI
  bwrb audit --allow-field custom # Allow specific extra field
  bwrb audit --all --fix                  # Interactive guided fixes across vault (writes)
  bwrb audit --fix --path "Ideas/**"      # Interactive guided fixes (writes)
  bwrb audit --fix --dry-run --path "Ideas/**"    # Preview guided fixes (no writes)
  bwrb audit --fix --auto --path "Ideas/**"      # Auto-fix unambiguous issues (writes)
  bwrb audit --fix --auto --dry-run --path "Ideas/**" # Preview auto-fixes (no writes)`)
  .argument('[target]', 'Type, path, or where expression (auto-detected)')
  .option('-t, --type <type>', 'Filter by type path (e.g., idea, objective/task)')
  .option('-p, --path <glob>', 'Filter by file path pattern')
  .option('-w, --where <expr...>', 'Filter by frontmatter expression')
  .option('-b, --body <query>', 'Filter by body content')
  .option('--text <query>', 'Filter by body content (deprecated: use --body)', undefined)
  .option('-a, --all', 'Target all files (explicit vault-wide selector)')
  .option('--strict', 'Treat unknown fields as errors instead of warnings')
  .option('--only <issue-type>', 'Only report specific issue type')
  .option('--ignore <issue-type>', 'Ignore specific issue type')
  .option('--output <format>', 'Output format: text (default) or json')
  .option('--fix', 'Interactive repair mode (writes by default; requires explicit targeting)')
  .option('--auto', 'With --fix: automatically apply unambiguous fixes')
  .option('--dry-run', 'With --fix: preview fixes without writing')
  .option('--execute', 'Deprecated (auto-fixes write by default; use --dry-run to preview)')
  .option('--allow-field <fields...>', 'Allow additional fields beyond schema (repeatable)')
  .action(async (target: string | undefined, options: AuditOptions & {
    type?: string;
    where?: string[];
    body?: string;
    text?: string; // deprecated
  }, cmd: Command) => {
    const jsonMode = options.output === 'json';
    const fixMode = options.fix ?? false;
    const autoMode = options.auto ?? false;
    const dryRunMode = options.dryRun ?? false;
    const executeMode = options.execute ?? false;

    // --auto requires --fix
    if (autoMode && !fixMode) {
      printError('--auto requires --fix');
      process.exit(1);
    }

    // --dry-run requires --fix
    if (dryRunMode && !fixMode) {
      printError('--dry-run requires --fix');
      process.exit(1);
    }

    // --execute requires --fix
    if (executeMode && !fixMode) {
      printError('--execute requires --fix');
      process.exit(1);
    }

    // --fix is not compatible with JSON output
    if (fixMode && jsonMode) {
      printError('--fix is not compatible with --output json');
      process.exit(1);
    }

    if (executeMode && dryRunMode) {
      printError('--execute cannot be used with --dry-run');
      process.exit(1);
    }

    try {
      const vaultDir = resolveVaultDir(getGlobalOpts(cmd));
      const schema = await loadSchema(vaultDir);

      // Handle --text deprecation
      if (options.text) {
        console.error('Warning: --text is deprecated, use --body instead');
      }

      // Build targeting options from flags
      let typePath = options.type;
      let pathGlob = options.path;
      let whereExprs = options.where;
      const bodyQuery = options.body ?? options.text;

      // Handle positional argument with smart detection
      if (target) {
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
        }
        if (parsed.options.path && !pathGlob) {
          pathGlob = parsed.options.path;
        }
        if (parsed.options.where && !whereExprs) {
          whereExprs = parsed.options.where;
        }
      }

      // Targeting gate: --fix requires explicit targeting or --all.
      if (fixMode) {
        const hasTargetingForFix = hasAnyTargeting({
          ...(typePath && { type: typePath }),
          ...(pathGlob && { path: pathGlob }),
          ...(whereExprs && whereExprs.length > 0 && { where: whereExprs }),
          ...(bodyQuery && { body: bodyQuery }),
          ...(options.all && { all: options.all }),
        });

        if (!hasTargetingForFix) {
          printError('No files selected. Refusing to run --fix without explicit targeting because it can write changes; use --all (vault-wide) or --type/--path/--where/--body. Example: bwrb audit --all --fix');
          process.exit(1);
        }
      }

      if (executeMode && autoMode) {
        printWarning('Warning: --execute is deprecated; auto-fixes write by default. Use --dry-run to preview changes.');
      } else if (executeMode) {
        printWarning('Warning: --execute is deprecated and has no effect without --auto; interactive --fix writes by default.');
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
          await showAvailableTypes(schema);
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
        textQuery: bodyQuery,
        onlyIssue: options.only as IssueCode | undefined,
        ignoreIssue: options.ignore as IssueCode | undefined,
        allowedFields,
        vaultDir,
        schema,
      });

      // Handle fix mode
      if (fixMode) {
        if (!autoMode && !process.stdin.isTTY && results.length > 0) {
          printError('audit --fix is interactive and requires a TTY; use --fix --auto or --output json');
          process.exit(1);
        }

        const executeRequiredIssueCodes = new Set<IssueCode>(['trailing-whitespace']);
        const hasExecuteRequiredIssues = autoMode && !executeMode && results.some(result =>
          result.issues.some(issue => issue.autoFixable && executeRequiredIssueCodes.has(issue.code))
        );
        const autoFixDryRun = dryRunMode || hasExecuteRequiredIssues;
        const autoFixDryRunReason = dryRunMode
          ? 'explicit'
          : hasExecuteRequiredIssues
            ? 'execute-required'
            : undefined;

        const fixSummary = autoMode
          ? await runAutoFix(results, schema, vaultDir, { dryRun: autoFixDryRun, dryRunReason: autoFixDryRunReason })
          : await runInteractiveFix(results, schema, vaultDir, { dryRun: dryRunMode });

        outputFixResults(fixSummary, autoMode);

        // Exit with error if there are remaining issues (interactive only)
        if (fixSummary.remaining > 0 && !autoMode) {
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
  type AuditSummary,
  type ManagedFile,
  type AuditRunOptions,
  type IssueCode,
  
  // Detection functions
  runAudit,
  discoverManagedFiles,
  auditFile,
  
  // Fix functions
  runAutoFix,
  runInteractiveFix,
  
  // Output functions
  calculateSummary,
  outputJsonResults,
  outputTextResults,
  outputFixResults,
};
