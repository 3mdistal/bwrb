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
import { parseFilters, matchesAllFilters, validateFilters } from '../lib/query.js';
import { printError } from '../lib/prompt.js';
import type { Schema } from '../types/schema.js';

export const listCommand = new Command('list')
  .description(`List notes of a given type

Filters:
  --field=value        Include where field equals value
  --field=a,b          Include where field equals a OR b
  --field!=value       Exclude where field equals value
  --field=             Include where field is empty/missing
  --field!=            Include where field exists

Examples:
  ovault list idea --status=raw
  ovault list objective/task --status!=settled
  ovault list idea --fields=status,priority`)
  .argument('[type]', 'Type path (e.g., idea, objective/task)')
  .option('--paths', 'Show file paths instead of names')
  .option('--fields <fields>', 'Show frontmatter fields in a table (comma-separated)')
  .allowUnknownOption(true)
  .action(async (typePath: string | undefined, options: { paths?: boolean; fields?: string }, cmd: Command) => {
    try {
      const parentOpts = cmd.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
      const schema = await loadSchema(vaultDir);

      if (!typePath) {
        showListUsage(schema);
        process.exit(1);
      }

      // Validate type exists
      const typeDef = getTypeDefByPath(schema, typePath);
      if (!typeDef) {
        printError(`Unknown type: ${typePath}`);
        process.exit(1);
      }

      // Parse filters from remaining arguments
      const filterArgs = cmd.args.slice(1); // Skip the type argument
      const filters = parseFilters(filterArgs);

      // Validate filters
      if (filters.length > 0) {
        const validation = validateFilters(schema, typePath, filters);
        if (!validation.valid) {
          for (const error of validation.errors) {
            printError(error);
          }
          process.exit(1);
        }
      }

      await listObjects(schema, vaultDir, typePath, {
        showPaths: options.paths ?? false,
        fields: options.fields?.split(',').map(f => f.trim()),
        filters,
      });
    } catch (err) {
      printError(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

interface ListOptions {
  showPaths: boolean;
  fields?: string[];
  filters: { field: string; operator: 'eq' | 'neq'; values: string[] }[];
}

/**
 * Show list command usage.
 */
function showListUsage(schema: Schema): void {
  console.log('Usage: ovault list [options] <type>[/<subtype>] [filters...]');
  console.log('');
  console.log('Options:');
  console.log('  --paths              Show file paths instead of names');
  console.log('  --fields=f1,f2,...   Show frontmatter fields in a table');
  console.log('');
  console.log('Filters:');
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

  // Apply filters
  const filteredFiles: { path: string; frontmatter: Record<string, unknown> }[] = [];
  for (const file of files) {
    try {
      const { frontmatter } = await parseNote(file);
      if (matchesAllFilters(frontmatter, options.filters)) {
        filteredFiles.push({ path: file, frontmatter });
      }
    } catch {
      // Skip files that can't be parsed
    }
  }

  // Sort by name
  filteredFiles.sort((a, b) => {
    const nameA = basename(a.path, '.md');
    const nameB = basename(b.path, '.md');
    return nameA.localeCompare(nameB);
  });

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
