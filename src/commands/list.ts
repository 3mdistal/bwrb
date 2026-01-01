import { Command } from 'commander';
import { join, basename, relative } from 'path';
import Table from 'cli-table3';
import {
  loadSchema,
  getTypeFamilies,
  getTypeDefByPath,
  hasSubtypes,
  getSubtypeKeys,
  getType,
} from '../lib/schema.js';
import { extractWikilinkTarget } from '../lib/audit/types.js';
import { parseNote } from '../lib/frontmatter.js';
import { resolveVaultDir, listFilesInDir, getOutputDir } from '../lib/vault.js';
import { parseFilters, validateFilters, applyFrontmatterFilters } from '../lib/query.js';
import { printError } from '../lib/prompt.js';
import {
  printJson,
  jsonError,
  ExitCodes,
} from '../lib/output.js';
import type { LoadedSchema } from '../types/schema.js';

interface ListCommandOptions {
  paths?: boolean;
  fields?: string;
  where?: string[];
  output?: string;
  // Hierarchy options for recursive types
  roots?: boolean;
  childrenOf?: string;
  descendantsOf?: string;
  tree?: boolean;
  depth?: string;
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
  // Hierarchy options for recursive types
  .option('--roots', 'Only show notes with no parent (root nodes)')
  .option('--children-of <note>', 'Only show direct children of the specified note (wikilink format)')
  .option('--descendants-of <note>', 'Only show all descendants of the specified note')
  .option('--tree', 'Display notes as a tree hierarchy')
  .option('--depth <n>', 'Limit tree/descendants depth (use with --tree or --descendants-of)')
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
      const depth = options.depth ? parseInt(options.depth, 10) : undefined;
      await listObjects(schema, vaultDir, typePath, {
        showPaths: options.paths ?? false,
        ...(fields !== undefined && { fields }),
        filters,
        whereExpressions: options.where ?? [],
        jsonMode,
        // Hierarchy options
        roots: options.roots,
        childrenOf: options.childrenOf,
        descendantsOf: options.descendantsOf,
        tree: options.tree,
        depth,
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
  fields?: string[] | undefined;
  filters: { field: string; operator: 'eq' | 'neq'; values: string[] }[];
  whereExpressions: string[];
  jsonMode: boolean;
  // Hierarchy options
  roots?: boolean | undefined;
  childrenOf?: string | undefined;
  descendantsOf?: string | undefined;
  tree?: boolean | undefined;
  depth?: number | undefined;
}

/**
 * Show list command usage.
 */
function showListUsage(schema: LoadedSchema): void {
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
  schema: LoadedSchema,
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
  let filteredFiles = await applyFrontmatterFilters(filesWithFrontmatter, {
    filters: options.filters,
    whereExpressions: options.whereExpressions,
    vaultDir,
    silent: options.jsonMode,
  });

  // Check if type is recursive for hierarchy options
  const typeDef = getType(schema, typePath);
  const isRecursive = typeDef?.recursive ?? false;

  // Apply hierarchy filters for recursive types
  if (isRecursive) {
    // Build parent map for hierarchy queries
    const parentMap = buildParentMap(filteredFiles);
    const childrenMap = buildChildrenMap(parentMap);

    if (options.roots) {
      // Only show notes with no parent
      filteredFiles = filteredFiles.filter(f => {
        const name = basename(f.path, '.md');
        return !parentMap.has(name);
      });
    }

    if (options.childrenOf) {
      // Only show direct children of the specified note
      const targetName = extractNoteName(options.childrenOf);
      if (targetName) {
        const children = childrenMap.get(targetName) ?? new Set();
        filteredFiles = filteredFiles.filter(f => {
          const name = basename(f.path, '.md');
          return children.has(name);
        });
      }
    }

    if (options.descendantsOf) {
      // Show all descendants of the specified note
      const targetName = extractNoteName(options.descendantsOf);
      if (targetName) {
        const descendants = collectDescendants(targetName, childrenMap, options.depth);
        filteredFiles = filteredFiles.filter(f => {
          const name = basename(f.path, '.md');
          return descendants.has(name);
        });
      }
    }
  }

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

  // Tree output for recursive types
  if (options.tree && isRecursive) {
    const parentMap = buildParentMap(filteredFiles);
    const tree = buildTree(filteredFiles, parentMap, options.depth);
    printTree(tree, vaultDir, options.showPaths ?? false);
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
  schema: LoadedSchema,
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

// ============================================================================
// Hierarchy Helpers for Recursive Types
// ============================================================================

type FileWithFrontmatter = { path: string; frontmatter: Record<string, unknown> };

/**
 * Build a map from note name -> parent note name from frontmatter.
 */
function buildParentMap(files: FileWithFrontmatter[]): Map<string, string> {
  const parentMap = new Map<string, string>();
  
  for (const file of files) {
    const name = basename(file.path, '.md');
    const parentValue = file.frontmatter['parent'];
    if (parentValue) {
      const parentName = extractNoteName(String(parentValue));
      if (parentName) {
        parentMap.set(name, parentName);
      }
    }
  }
  
  return parentMap;
}

/**
 * Build a map from note name -> set of children note names.
 */
function buildChildrenMap(parentMap: Map<string, string>): Map<string, Set<string>> {
  const childrenMap = new Map<string, Set<string>>();
  
  for (const [child, parent] of parentMap) {
    if (!childrenMap.has(parent)) {
      childrenMap.set(parent, new Set());
    }
    childrenMap.get(parent)!.add(child);
  }
  
  return childrenMap;
}

/**
 * Extract note name from a value (handles wikilinks and plain text).
 * Returns null if the value is empty or cannot be parsed.
 */
function extractNoteName(value: string): string | null {
  if (!value) return null;
  
  // Use the imported extractWikilinkTarget for wikilink handling
  const wikilinkTarget = extractWikilinkTarget(value);
  if (wikilinkTarget) {
    return wikilinkTarget;
  }
  
  // Plain text - just return trimmed value
  return value.trim() || null;
}

/**
 * Collect all descendants of a note up to a given depth.
 * @param rootName The root note name to start from
 * @param childrenMap Map of parent -> children
 * @param maxDepth Maximum depth to traverse (undefined = unlimited)
 * @returns Set of all descendant note names
 */
function collectDescendants(
  rootName: string,
  childrenMap: Map<string, Set<string>>,
  maxDepth?: number | undefined
): Set<string> {
  const descendants = new Set<string>();
  
  function traverse(name: string, currentDepth: number): void {
    if (maxDepth !== undefined && currentDepth >= maxDepth) {
      return;
    }
    
    const children = childrenMap.get(name);
    if (!children) return;
    
    for (const child of children) {
      descendants.add(child);
      traverse(child, currentDepth + 1);
    }
  }
  
  traverse(rootName, 0);
  return descendants;
}

/**
 * Build a tree structure from files and parent relationships.
 */
interface TreeNode {
  name: string;
  path: string;
  frontmatter: Record<string, unknown>;
  children: TreeNode[];
  depth: number;
}

function buildTree(
  files: FileWithFrontmatter[],
  parentMap: Map<string, string>,
  maxDepth?: number | undefined
): TreeNode[] {
  // Create nodes for all files
  const nodeMap = new Map<string, TreeNode>();
  for (const file of files) {
    const name = basename(file.path, '.md');
    nodeMap.set(name, {
      name,
      path: file.path,
      frontmatter: file.frontmatter,
      children: [],
      depth: 0,
    });
  }
  
  // Build parent-child relationships
  const roots: TreeNode[] = [];
  for (const [name, node] of nodeMap) {
    const parentName = parentMap.get(name);
    if (parentName && nodeMap.has(parentName)) {
      const parentNode = nodeMap.get(parentName)!;
      parentNode.children.push(node);
    } else {
      roots.push(node);
    }
  }
  
  // Compute depths and sort children
  function computeDepth(node: TreeNode, depth: number): void {
    node.depth = depth;
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of node.children) {
      computeDepth(child, depth + 1);
    }
  }
  
  for (const root of roots) {
    computeDepth(root, 0);
  }
  
  roots.sort((a, b) => a.name.localeCompare(b.name));
  
  // Filter by max depth if specified
  if (maxDepth !== undefined) {
    const depthLimit = maxDepth; // Capture for closure
    function filterByDepth(nodes: TreeNode[]): TreeNode[] {
      return nodes.map(node => ({
        ...node,
        children: node.depth < depthLimit - 1 ? filterByDepth(node.children) : [],
      }));
    }
    return filterByDepth(roots);
  }
  
  return roots;
}

/**
 * Print tree structure to console.
 */
function printTree(
  roots: TreeNode[],
  vaultDir: string,
  showPaths: boolean
): void {
  function printNode(node: TreeNode, prefix: string, isLast: boolean): void {
    const connector = isLast ? '└── ' : '├── ';
    const display = showPaths ? relative(vaultDir, node.path) : node.name;
    console.log(prefix + connector + display);
    
    const childPrefix = prefix + (isLast ? '    ' : '│   ');
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i]!;
      const childIsLast = i === node.children.length - 1;
      printNode(child, childPrefix, childIsLast);
    }
  }
  
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i]!;
    const isLast = i === roots.length - 1;
    printNode(root, '', isLast);
  }
}
