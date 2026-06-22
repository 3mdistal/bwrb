/**
 * `bwrb schema discover [path]` — deterministic frontmatter field-usage report.
 *
 * DESCRIPTIVE, not prescriptive. It reports facts about the frontmatter across a
 * folder of Markdown notes and never passes/fails. It exits non-zero only for
 * real errors (e.g. an unreadable path), never for "non-conforming" data.
 *
 * Two roles:
 *   - Pre-schema (onboarding): point it at any folder; get raw material for
 *     designing types — every field, its frequency, value-type consistency, and
 *     which files diverge.
 *   - Post-schema (drift): when a schema is found, it additionally reports
 *     fields used-but-undefined, defined-but-unused, and values diverging from
 *     declared `select` options.
 *
 * Contrast with `audit`, which is PRESCRIPTIVE (what is wrong vs the schema).
 */

import { Command } from 'commander';
import { resolve, dirname, join } from 'path';
import { stat } from 'fs/promises';
import { existsSync } from 'fs';
import chalk from 'chalk';
import { getGlobalOpts } from '../../lib/command.js';
import { printJson, jsonSuccess, jsonError, ExitCodes } from '../../lib/output.js';
import { printError } from '../../lib/prompt.js';
import { getTtyContext } from '../../lib/tty/context.js';
import { renderTable } from '../../lib/tty/table.js';
import { loadSchema } from '../../lib/schema.js';
import { SCHEMA_RELATIVE_PATH } from '../../lib/bwrb-paths.js';
import { buildDiscoverReport, type DiscoverReport, type FieldFacts } from '../../lib/discover.js';

interface DiscoverOptions {
  output?: string;
  /**
   * Commander stores `--no-schema` as `schema: false` (defaults to true).
   * When false, skip drift detection even if a schema is found.
   */
  schema?: boolean;
}

/**
 * Walk upward from `start` looking for a directory containing
 * `.bwrb/schema.json`. Returns that directory, or undefined if none is found.
 * Keeps the pre-schema role working on an arbitrary folder with no vault.
 */
function findSchemaVaultDir(start: string): string | undefined {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, SCHEMA_RELATIVE_PATH))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export const discoverCommand = new Command('discover')
  .description('Report frontmatter field-usage facts over a folder (descriptive)')
  .argument('[path]', 'Folder to scan (defaults to current directory)')
  .option('--output <format>', 'Output format: text (default) or json')
  .option('--no-schema', 'Skip drift detection; report raw field facts only')
  .addHelpText('after', `
Discover is DESCRIPTIVE: it reports facts and never passes/fails. It is safe to
run anytime, including on a messy folder that has no schema yet. (For a
PRESCRIPTIVE report of what is wrong vs the schema, use 'bwrb audit'.)

Roles:
  Before a schema exists  Onboarding — raw material for designing types.
  After a schema exists    Drift — fields used-but-undefined, defined-but-unused,
                           and values diverging from declared select options.

Examples:
  bwrb schema discover                  # Scan the current directory
  bwrb schema discover ./notes          # Scan an arbitrary folder
  bwrb schema discover --output json    # Structured facts for scripting/agents
  bwrb schema discover --no-schema      # Skip drift even if a schema is present`)
  .action(async (path: string | undefined, options: DiscoverOptions, cmd: Command) => {
    const globalOpts = getGlobalOpts(cmd);
    const jsonMode = options.output === 'json' || globalOpts.output === 'json';

    try {
      const root = resolve(path ?? globalOpts.vault ?? process.cwd());

      // Validate the path is a real, readable directory (a real error → non-zero).
      let info;
      try {
        info = await stat(root);
      } catch {
        throw new Error(`Path not found or unreadable: ${root}`);
      }
      if (!info.isDirectory()) {
        throw new Error(`Not a directory: ${root}`);
      }

      // Locate a schema for drift detection (optional). Prefer --vault, else
      // walk up from the scanned folder. Never required.
      const driftEnabled = options.schema !== false;
      let schema;
      if (driftEnabled) {
        const vaultDir = globalOpts.vault
          ? resolve(globalOpts.vault)
          : findSchemaVaultDir(root);
        if (vaultDir && existsSync(join(vaultDir, SCHEMA_RELATIVE_PATH))) {
          try {
            schema = await loadSchema(vaultDir);
          } catch {
            // A broken schema must not break a descriptive report; fall back to
            // the pre-schema (onboarding) view rather than erroring.
            schema = undefined;
          }
        }
      }

      const report = await buildDiscoverReport(root, { schema });

      if (jsonMode) {
        printJson(jsonSuccess({ data: report }));
        return;
      }

      printTextReport(report);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (jsonMode) {
        printJson(jsonError(message, { code: ExitCodes.IO_ERROR }));
        process.exit(ExitCodes.IO_ERROR);
      }
      printError(message);
      process.exit(ExitCodes.IO_ERROR);
    }
  });

// ============================================================================
// Text rendering
// ============================================================================

function formatTypes(field: FieldFacts): string {
  return field.types.map((t) => `${t.type} (${t.count})`).join(', ');
}

function formatNotes(field: FieldFacts): string {
  const notes: string[] = [];
  if (field.mixedTypes) {
    notes.push(`mixed types in ${field.divergingFiles.length} file(s)`);
  }
  if (field.defined === false) {
    notes.push('not in schema');
  }
  if (field.divergingOptions && field.divergingOptions.length > 0) {
    const total = field.divergingOptions.reduce((n, d) => n + d.files.length, 0);
    notes.push(`${field.divergingOptions.length} off-option value(s) in ${total} file(s)`);
  }
  return notes.join('; ');
}

function printTextReport(report: DiscoverReport): void {
  const context = getTtyContext();

  console.log('');
  console.log(chalk.bold(`Field usage in ${report.root}`));
  console.log(
    chalk.gray(
      `${report.totalFiles} markdown file(s), ` +
        `${report.filesWithFrontmatter} with frontmatter` +
        (report.schemaPresent ? ', schema loaded' : ', no schema')
    )
  );
  console.log('');

  if (report.fields.length === 0) {
    console.log(chalk.gray('No frontmatter fields found.'));
  } else {
    const rows = report.fields.map((f) => ({
      field: f.field,
      count: String(f.count),
      frequency: `${Math.round(f.frequency * 100)}%`,
      types: formatTypes(f),
      notes: formatNotes(f),
    }));

    const lines = renderTable({
      context,
      rows,
      columns: [
        { key: 'field', title: 'Field', minWidth: 6, style: chalk.cyan },
        { key: 'count', title: 'Count', align: 'right' },
        { key: 'frequency', title: 'Freq', align: 'right' },
        { key: 'types', title: 'Value types', mode: 'wrap', weight: 2 },
        { key: 'notes', title: 'Notes', mode: 'wrap', weight: 3, canDrop: true, style: chalk.yellow },
      ],
    });
    for (const line of lines) console.log(line);
  }

  if (report.drift) {
    printDriftSection(report);
  }

  if (report.unreadable.length > 0) {
    console.log('');
    console.log(chalk.gray(`Skipped ${report.unreadable.length} unreadable file(s):`));
    for (const u of report.unreadable) {
      console.log(chalk.gray(`  ${u.file}: ${u.error}`));
    }
  }

  console.log('');
}

function printDriftSection(report: DiscoverReport): void {
  const drift = report.drift!;
  console.log('');
  console.log(chalk.bold('Drift vs schema'));

  if (
    drift.usedButUndefined.length === 0 &&
    drift.definedButUnused.length === 0 &&
    drift.optionDivergences.length === 0
  ) {
    console.log(chalk.gray('  No drift observed.'));
    return;
  }

  if (drift.usedButUndefined.length > 0) {
    console.log(chalk.yellow('  Used but not defined in schema:'));
    for (const field of drift.usedButUndefined) {
      console.log(`    - ${field}`);
    }
  }
  if (drift.definedButUnused.length > 0) {
    console.log(chalk.yellow('  Defined in schema but unused:'));
    for (const field of drift.definedButUnused) {
      console.log(`    - ${field}`);
    }
  }
  if (drift.optionDivergences.length > 0) {
    console.log(chalk.yellow('  Values diverging from declared options:'));
    for (const entry of drift.optionDivergences) {
      const values = entry.values
        .map((v) => `"${v.value}" (${v.files.length} file(s))`)
        .join(', ');
      console.log(`    - ${entry.field}: ${values}`);
    }
  }
}
