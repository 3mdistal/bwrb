import { Command } from 'commander';
import { join, basename, relative } from 'path';
import Table from 'cli-table3';
import {
  loadSchema,
  getTypeFamilies,
  getTypeDefByPath,
  hasSubtypes,
  getSubtypeKeys,
} from '../lib/schema.js';
import { parseNote } from '../lib/frontmatter.js';
import { resolveVaultDir, listFilesInDir, getOutputDir } from '../lib/vault.js';
import { parseFilters, validateFilters, applyFrontmatterFilters } from '../lib/query.js';
import { printError } from '../lib/prompt.js';
import {
  printJson,
  jsonError,
  ExitCodes,
} from '../lib/output.js';
import type { Schema } from '../types/schema.js';

interface ListCommandOptions {
  paths?: boolean;
  fields?: string;
  where?: string[];
  output?: string;
}

export const listCommand = new Command('list')
  .description('List notes of a given type with optional filtering')
  .addHelpText('after', `
Expression Filters (--where):
  pika list task --where "status == 'in-progress'"
  pika list task --where "priority < 3 && !isEmpty(deadline)"
  pika list task --where "deadline < today() + '7d'"

Simple Filters:
  --field=value        Include where field equals value
  --field=a,b          Include where field equals a OR b  
  --field!=value       Exclude where field equals value
  --field=             Include where field is empty/missing
  --field!=            Include where field exists

Examples:
  pika list idea --status=raw
  pika list objective/task --status!=settled
  pika list idea --fields=status,priority
  pika list task --where "status == 'done' && !isEmpty(tags)"
  pika list task --output json

Note: In zsh, use single quotes for expressions with '!' to avoid history expansion:
  pika list task --where '!isEmpty(deadline)'`)
  .argument('[type]', 'Type path (e.g., idea, objective/task)')
  .option('--paths', 'Show file paths instead of names')
  .option('--fields <fields>', 'Show frontmatter fields in a table (comma-separated)')
  .option('-w, --where <expression...>', 'Filter with expression (multiple are ANDed)')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  .allowUnknownOption(true)
  .action(async (typePath: string | undefined, options: ListCommandOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
      const parentOpts = cmd.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
      const schema = await loadSchema(vaultDir);

      if (!typePath) {
        if (jsonMode) {
          printJson(jsonError('Type path is required'));
          process.exit(ExitCodes.VALIDATION_ERROR);
        }
        showListUsage(schema);
        process.exit(1);
      }

      // Validate type exists
      const typeDef = getTypeDefByPath(schema, typePath);
      if (!typeDef) {
        const error = `Unknown type: ${typePath}`;
        if (jsonMode) {
          printJson(jsonError(error));
          process.exit(ExitCodes.VALIDATION_ERROR);
        }
        printError(error);
        process.exit(1);
      }

      // Parse filters from remaining arguments
      const filterArgs = cmd.args.slice(1); // Skip the type argument
      const filters = parseFilters(filterArgs);

      // Validate filters
      if (filters.length > 0) {
        const validation = validateFilters(schema, typePath, filters);
        if (!validation.valid) {
          if (jsonMode) {
            printJson(jsonError(validation.errors.join('; ')));
            process.exit(ExitCodes.VALIDATION_ERROR);
          }
          for (const error of validation.errors) {
            printError(error);
          }
          process.exit(1);
        }
      }

      const fields = options.fields?.split(',').map(f => f.trim());
      await listObjects(schema, vaultDir, typePath, {
        showPaths: options.paths ?? false,
        ...(fields !== undefined && { fields }),
        filters,
        whereExpressions: options.where ?? [],
        jsonMode,
      });
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

interface ListOptions {
  showPaths: boolean;
  fields?: string[];
  filters: { field: string; operator: 'eq' | 'neq'; values: string[] }[];
  whereExpressions: string[];
  jsonMode: boolean;
}

/**
 * Show list command usage.
 */
function showListUsage(schema: Schema): void {
  console.log('Usage: pika list [options] <type>[/<subtype>] [filters...]');
  console.log('');
  console.log('Options:');
  console.log('  --paths              Show file paths instead of names');
  console.log('  --fields=f1,f2,...   Show frontmatter fields in a table');
  console.log('  --where "expr"       Filter with expression (can be repeated)');
  console.log('  --output json        Output as JSON');
  console.log('');
  console.log('Expression examples:');
  console.log('  --where "status == \'done\'"');
  console.log('  --where "priority < 3 && !isEmpty(deadline)"');
  console.log('  --where "deadline < today() + \'7d\'"');
  console.log('  --where "contains(tags, \'urgent\')"');
  console.log('');
  console.log('Simple Filters:');
  console.log('  --field=value        Include items where field equals value');
  console.log('  --field=val1,val2    Include items where field equals any value (OR)');
  console.log('  --field!=value       Exclude items where field equals value');
  console.log('  --field=             Include items where field is missing/empty');
  console.log('  --field!=            Include items where field exists (has a value)');
  console.log('');
  console.log('Available types:');
  for (const family of getTypeFamilies(schema)) {
    console.log(`  ${family}`);
  }
}

/**
 * List objects by type path.
 */
async function listObjects(
  schema: Schema,
  vaultDir: string,
  typePath: string,
  options: ListOptions
): Promise<void> {
  // Collect all files for this type
  const files = await collectFilesForType(schema, vaultDir, typePath);

  // Parse frontmatter for all files
  const filesWithFrontmatter: { path: string; frontmatter: Record<string, unknown> }[] = [];
  for (const file of files) {
    try {
      const { frontmatter } = await parseNote(file);
      filesWithFrontmatter.push({ path: file, frontmatter });
    } catch {
      // Skip files that can't be parsed
    }
  }

  // Apply filters using shared helper
  const filteredFiles = await applyFrontmatterFilters(filesWithFrontmatter, {
    filters: options.filters,
    whereExpressions: options.whereExpressions,
    vaultDir,
    silent: options.jsonMode,
  });

  // Sort by name
  filteredFiles.sort((a, b) => {
    const nameA = basename(a.path, '.md');
    const nameB = basename(b.path, '.md');
    return nameA.localeCompare(nameB);
  });

  // JSON output mode
  if (options.jsonMode) {
    const jsonOutput = filteredFiles.map(({ path, frontmatter }) => ({
      _path: relative(vaultDir, path),
      _name: basename(path, '.md'),
      ...frontmatter,
    }));
    console.log(JSON.stringify(jsonOutput, null, 2));
    return;
  }

  // Text output mode
  if (filteredFiles.length === 0) {
    return;
  }

  // Output based on format
  if (options.fields && options.fields.length > 0) {
    printTable(filteredFiles, vaultDir, options);
  } else if (options.showPaths) {
    for (const { path } of filteredFiles) {
      console.log(relative(vaultDir, path));
    }
  } else {
    for (const { path } of filteredFiles) {
      console.log(basename(path, '.md'));
    }
  }
}

/**
 * Recursively collect files for a type path.
 */
async function collectFilesForType(
  schema: Schema,
  vaultDir: string,
  typePath: string
): Promise<string[]> {
  const typeDef = getTypeDefByPath(schema, typePath);
  if (!typeDef) return [];

  if (hasSubtypes(typeDef)) {
    // Recurse into subtypes
    const files: string[] = [];
    for (const subtype of getSubtypeKeys(typeDef)) {
      const subFiles = await collectFilesForType(schema, vaultDir, `${typePath}/${subtype}`);
      files.push(...subFiles);
    }
    return files;
  } else {
    // Leaf type - list files from output_dir
    const outputDir = getOutputDir(schema, typePath);
    if (!outputDir) return [];
    return listFilesInDir(join(vaultDir, outputDir));
  }
}

/**
 * Print results as a table.
 */
function printTable(
  files: { path: string; frontmatter: Record<string, unknown> }[],
  vaultDir: string,
  options: ListOptions
): void {
  const fields = options.fields ?? [];
  const headers = [options.showPaths ? 'PATH' : 'NAME', ...fields.map(f => f.toUpperCase())];

  const table = new Table({
    head: headers,
    style: { head: [], border: [] },
  });

  for (const { path, frontmatter } of files) {
    const name = options.showPaths ? relative(vaultDir, path) : basename(path, '.md');
    const row: string[] = [name];

    for (const field of fields) {
      const value = frontmatter[field];
      row.push(formatValue(value));
    }

    table.push(row);
  }

  console.log(table.toString());
}

/**
 * Format a frontmatter value for display.
 */
function formatValue(value: unknown): string {
  if (value === undefined || value === null) {
    return '—';
  }
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  return String(value);
}
