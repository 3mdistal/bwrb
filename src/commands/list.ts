import { Command } from 'commander';
import { basename, relative } from 'path';
import Table from 'cli-table3';
import {
  loadSchema,
  getTypeFamilies,
  getTypeDefByPath,
  getType,
} from '../lib/schema.js';
import { extractWikilinkTarget } from '../lib/audit/types.js';

import { resolveVaultDir } from '../lib/vault.js';
import { validateFilters, applyFrontmatterFilters } from '../lib/query.js';
import { printError, printWarning } from '../lib/prompt.js';
import {
  printJson,
  jsonError,
  ExitCodes,
} from '../lib/output.js';
import { openNote } from './open.js';
import { pickFile, parsePickerMode } from '../lib/picker.js';
import type { LoadedSchema } from '../types/schema.js';
import {
  resolveTargets,
  parsePositionalArg,
  checkDeprecatedFilters,
  hasAnyTargeting,
  formatTargetingSummary,
  type TargetingOptions,
} from '../lib/targeting.js';

interface ListCommandOptions {
  type?: string;
  path?: string;
  body?: string;
  text?: string; // deprecated
  paths?: boolean;
  fields?: string;
  where?: string[];
  output?: string;
  // Open options
  open?: boolean;
  app?: string;
  // Hierarchy options for recursive types
  roots?: boolean;
  childrenOf?: string;
  descendantsOf?: string;
  tree?: boolean;
  depth?: string;
}

export const listCommand = new Command('list')
  .description('List notes with optional filtering')
  .addHelpText('after', `
Targeting Selectors (compose via AND):
  --type <type>        Filter by type (e.g., task, objective/milestone)
  --path <glob>        Filter by file path (e.g., Projects/**, Ideas/)
  --where <expr>       Filter by frontmatter expression (can repeat)
  --body <query>       Filter by body content (uses ripgrep)

Expression Filters (--where):
  bwrb list --type task --where "status == 'in-progress'"
  bwrb list --type task --where "priority < 3 && !isEmpty(deadline)"
  bwrb list --type task --where "deadline < today() + '7d'"

Smart Positional Detection:
  bwrb list task                    # Detected as --type task
  bwrb list Projects/**             # Detected as --path Projects/**
  bwrb list "status=active"         # Detected as --where "status=active"

Examples:
  bwrb list --type idea
  bwrb list --type task --where "status == 'done'"
  bwrb list --path "Projects/**" --body "TODO"
  bwrb list --type task --output json
  bwrb list --type task --open                    # Pick from tasks and open
  bwrb list --type task --where "status=inbox" --open

Open Options:
  --open               Open a note from the results (picker if multiple)
  --app <mode>         How to open: obsidian (default), editor, system, print

Note: In zsh, use single quotes for expressions with '!' to avoid history expansion:
  bwrb list --type task --where '!isEmpty(deadline)'`)
  .argument('[positional]', 'Smart positional: type, path (contains /), or where expression (contains =<>~)')
  .option('-t, --type <type>', 'Filter by type path (e.g., idea, objective/task)')
  .option('-p, --path <glob>', 'Filter by file path glob (e.g., Projects/**, Ideas/)')
  .option('-b, --body <query>', 'Filter by body content search')
  .option('--text <query>', 'Filter by body content search (deprecated: use --body)', undefined)
  .option('--paths', 'Show file paths instead of names')
  .option('--fields <fields>', 'Show frontmatter fields in a table (comma-separated)')
  .option('-w, --where <expression...>', 'Filter with expression (multiple are ANDed)')
  .option('-o, --output <format>', 'Output format: text (default) or json')
  // Open options
  .option('--open', 'Open the first result (or pick from results interactively)')
  .option('--app <mode>', 'How to open: obsidian (default), editor, system, print')
  // Hierarchy options for recursive types
  .option('--roots', 'Only show notes with no parent (root nodes)')
  .option('--children-of <note>', 'Only show direct children of the specified note (wikilink format)')
  .option('--descendants-of <note>', 'Only show all descendants of the specified note')
  .option('--tree', 'Display notes as a tree hierarchy')
  .option('--depth <n>', 'Limit tree/descendants depth (use with --tree or --descendants-of)')
  .allowUnknownOption(true)
  .action(async (positional: string | undefined, options: ListCommandOptions, cmd: Command) => {
    const jsonMode = options.output === 'json';

    try {
      const parentOpts = cmd.parent?.opts() as { vault?: string } | undefined;
      const vaultDir = resolveVaultDir(parentOpts ?? {});
      const schema = await loadSchema(vaultDir);

      // Build targeting options from flags
      const targeting: TargetingOptions = {};
      if (options.type) targeting.type = options.type;
      if (options.path) targeting.path = options.path;
      if (options.where) targeting.where = options.where;
      // Handle --body (new) and --text (deprecated)
      if (options.text) {
        console.error('Warning: --text is deprecated, use --body instead');
      }
      const bodyQuery = options.body ?? options.text;
      if (bodyQuery) targeting.body = bodyQuery;

      // Check for deprecated simple filter flags (--field=value)
      const filterArgs = cmd.args.slice(positional ? 1 : 0);
      const deprecatedCheck = checkDeprecatedFilters(filterArgs);
      if (deprecatedCheck.warnings.length > 0 && !jsonMode) {
        for (const warning of deprecatedCheck.warnings) {
          printWarning(warning);
        }
      }

      // Handle smart positional detection
      if (positional) {
        const positionalResult = parsePositionalArg(positional, schema, targeting);
        if (positionalResult.error) {
          if (jsonMode) {
            printJson(jsonError(positionalResult.error));
            process.exit(ExitCodes.VALIDATION_ERROR);
          }
          printError(positionalResult.error);
          process.exit(1);
        }
        
        // Merge parsed options
        Object.assign(targeting, positionalResult.options);
      }

      // Validate type if specified
      if (targeting.type) {
        const typeDef = getTypeDefByPath(schema, targeting.type);
        if (!typeDef) {
          const error = `Unknown type: ${targeting.type}`;
          if (jsonMode) {
            printJson(jsonError(error));
            process.exit(ExitCodes.VALIDATION_ERROR);
          }
          printError(error);
          process.exit(1);
        }
      }

      // Use the deprecated filters directly (already parsed)
      const filters = deprecatedCheck.filters;

      // Validate filters if type is specified
      if (filters.length > 0 && targeting.type) {
        const validation = validateFilters(schema, targeting.type, filters);
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

      // Resolve targets using shared targeting module
      const targetResult = await resolveTargets(targeting, schema, vaultDir);
      
      if (targetResult.error) {
        if (jsonMode) {
          printJson(jsonError(targetResult.error));
          process.exit(ExitCodes.VALIDATION_ERROR);
        }
        printError(targetResult.error);
        process.exit(1);
      }

      // Show targeting summary if no results
      if (targetResult.files.length === 0 && !jsonMode && hasAnyTargeting(targeting)) {
        console.log(`No notes found matching: ${formatTargetingSummary(targeting)}`);
      }

      const fields = options.fields?.split(',').map(f => f.trim());
      const depth = options.depth ? parseInt(options.depth, 10) : undefined;
      
      await listObjects(schema, vaultDir, targeting.type, targetResult.files, {
        showPaths: options.paths ?? false,
        ...(fields !== undefined && { fields }),
        filters,
        whereExpressions: [], // Already applied by resolveTargets
        jsonMode,
        // Open options
        open: options.open,
        app: options.app,
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
  // Open options
  open?: boolean | undefined;
  app?: string | undefined;
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
  console.log('Usage: bwrb list [options] [positional]');
  console.log('');
  console.log('Targeting Selectors:');
  console.log('  --type <type>        Filter by type path');
  console.log('  --path <glob>        Filter by file path glob');
  console.log('  --where "expr"       Filter with expression (can be repeated)');
  console.log('  --body <query>       Filter by body content');
  console.log('');
  console.log('Other Options:');
  console.log('  --paths              Show file paths instead of names');
  console.log('  --fields=f1,f2,...   Show frontmatter fields in a table');
  console.log('  --output json        Output as JSON');
  console.log('');
  console.log('Expression examples:');
  console.log('  --where "status == \'done\'"');
  console.log('  --where "priority < 3 && !isEmpty(deadline)"');
  console.log('  --where "deadline < today() + \'7d\'"');
  console.log('  --where "contains(tags, \'urgent\')"');
  console.log('');
  console.log('Available types:');
  for (const family of getTypeFamilies(schema)) {
    console.log(`  ${family}`);
  }
}

/**
 * List objects with pre-resolved files from targeting.
 */
async function listObjects(
  schema: LoadedSchema,
  vaultDir: string,
  typePath: string | undefined,
  files: Array<{ path: string; relativePath: string; frontmatter: Record<string, unknown> }>,
  options: ListOptions
): Promise<void> {
  // Convert to the format expected by the rest of the function
  let filteredFiles = files.map(f => ({
    path: f.path,
    frontmatter: f.frontmatter,
  }));

  // Apply any remaining deprecated filters
  if (options.filters.length > 0) {
    filteredFiles = await applyFrontmatterFilters(filteredFiles, {
      filters: options.filters,
      whereExpressions: options.whereExpressions,
      vaultDir,
      silent: options.jsonMode,
    });
  }

  // Check if type is recursive for hierarchy options
  const typeDef = typePath ? getType(schema, typePath) : undefined;
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

  // Handle no results
  if (filteredFiles.length === 0) {
    if (options.jsonMode) {
      console.log(JSON.stringify([], null, 2));
    }
    return;
  }

  // Handle --open flag
  if (options.open) {
    let targetPath: string;
    
    if (filteredFiles.length === 1) {
      // Single result - open directly
      targetPath = filteredFiles[0]!.path;
    } else if (process.stdin.isTTY && process.stdout.isTTY) {
      // Multiple results - use picker
      const pickerFiles = filteredFiles.map(f => ({
        path: f.path,
        relativePath: relative(vaultDir, f.path),
      }));
      const pickerResult = await pickFile(pickerFiles, {
        mode: parsePickerMode(undefined),
        prompt: `${filteredFiles.length} notes - select to open`,
      });
      
      if (pickerResult.cancelled || !pickerResult.selected) {
        process.exit(0);
      }
      targetPath = pickerResult.selected.path;
    } else {
      // Non-interactive with multiple results - open first
      targetPath = filteredFiles[0]!.path;
    }
    
    await openNote(vaultDir, targetPath, options.app, options.jsonMode);
    return;
  }

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

// Export showListUsage for potential use elsewhere
export { showListUsage };
