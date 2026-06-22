/**
 * Pure helpers for the `list` command.
 *
 * This module contains the sort/comparison logic and the tree-building logic
 * used by `list` (and the dashboard command via `listObjects`). Everything here
 * is pure and deterministic — it takes data plus options and returns sorted /
 * tree-structured results, with no I/O or console output. The actual rendering
 * (printing trees and tables) stays in the command, since that is I/O-bound.
 *
 * Extracted from `src/commands/list.ts` so the logic is isolated and directly
 * unit-testable. See issue #597.
 */

import { basename, relative } from 'path';
import { extractWikilinkTarget } from './links.js';

// ============================================================================
// Types
// ============================================================================

export type FileWithFrontmatter = {
  path: string;
  frontmatter: Record<string, unknown>;
};

export type FileComparator = (a: FileWithFrontmatter, b: FileWithFrontmatter) => number;

export interface TreeNode {
  name: string;
  path: string;
  frontmatter: Record<string, unknown>;
  children: TreeNode[];
  depth: number;
}

export interface DirectoryTreeNode {
  name: string;
  path: string;
  directories: DirectoryTreeNode[];
  notes: FileWithFrontmatter[];
  depth: number;
}

// ============================================================================
// Sort / Comparison Helpers
// ============================================================================

/**
 * Default comparator: order files alphabetically by note name (basename).
 */
export function compareByName(a: FileWithFrontmatter, b: FileWithFrontmatter): number {
  return basename(a.path, '.md').localeCompare(basename(b.path, '.md'));
}

/**
 * Resolve the raw value to sort by for a given field.
 *
 * Handles the reserved fields `name`/`_name` (note basename) and `_path`
 * (vault-relative path); everything else is read from frontmatter.
 */
export function getSortValue(file: FileWithFrontmatter, vaultDir: string, field: string): unknown {
  if (field === 'name' || field === '_name') {
    return basename(file.path, '.md');
  }
  if (field === '_path') {
    return relative(vaultDir, file.path);
  }
  return file.frontmatter[field];
}

/**
 * Whether a sort value should be treated as missing (sorted to the end).
 */
export function isMissingSortValue(value: unknown): boolean {
  return value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0);
}

/**
 * Normalize an arbitrary value into a comparable primitive.
 * Arrays are joined; numbers/booleans pass through; everything else is stringified.
 */
export function normalizeSortValue(value: unknown): string | number | boolean {
  if (Array.isArray(value)) {
    return value.map(item => String(item)).join(', ');
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return String(value);
}

/**
 * Compare two (present) sort values. Numbers compare numerically, booleans by
 * truthiness, and everything else via locale-aware, numeric-sensitive string
 * comparison (so "2" sorts before "10").
 */
export function compareSortValues(a: unknown, b: unknown): number {
  const normalizedA = normalizeSortValue(a);
  const normalizedB = normalizeSortValue(b);

  if (typeof normalizedA === 'number' && typeof normalizedB === 'number') {
    return normalizedA - normalizedB;
  }

  if (typeof normalizedA === 'boolean' && typeof normalizedB === 'boolean') {
    return Number(normalizedA) - Number(normalizedB);
  }

  return String(normalizedA).localeCompare(String(normalizedB), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

/**
 * Build a comparator for the given sort field/direction.
 *
 * When no field is given, falls back to {@link compareByName}. Missing values
 * always sort last (regardless of direction); ties break alphabetically by name.
 */
export function createFileComparator(
  vaultDir: string,
  sortField: string | undefined,
  descending: boolean | undefined
): FileComparator {
  if (!sortField) {
    return compareByName;
  }

  return (a, b) => {
    const valueA = getSortValue(a, vaultDir, sortField);
    const valueB = getSortValue(b, vaultDir, sortField);
    const missingA = isMissingSortValue(valueA);
    const missingB = isMissingSortValue(valueB);

    if (missingA && missingB) {
      return compareByName(a, b);
    }
    if (missingA) return 1;
    if (missingB) return -1;

    const comparison = compareSortValues(valueA, valueB);
    if (comparison !== 0) {
      return descending ? -comparison : comparison;
    }
    return compareByName(a, b);
  };
}

// ============================================================================
// Hierarchy / Tree-Building Helpers
// ============================================================================

/**
 * Extract a note name from a value (handles wikilinks and plain text).
 * Returns null if the value is empty or cannot be parsed.
 */
export function extractNoteName(value: string): string | null {
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
 * Build a map from note name -> parent note name from frontmatter.
 */
export function buildParentMap(files: FileWithFrontmatter[]): Map<string, string> {
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
export function buildChildrenMap(parentMap: Map<string, string>): Map<string, Set<string>> {
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
 * Collect all descendants of a note up to a given depth.
 * @param rootName The root note name to start from
 * @param childrenMap Map of parent -> children
 * @param maxDepth Maximum depth to traverse (undefined = unlimited)
 * @returns Set of all descendant note names
 */
export function collectDescendants(
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
export function buildTree(
  files: FileWithFrontmatter[],
  parentMap: Map<string, string>,
  maxDepth?: number | undefined,
  fileComparator: FileComparator = compareByName
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
    node.children.sort((a, b) => fileComparator(a, b));
    for (const child of node.children) {
      computeDepth(child, depth + 1);
    }
  }

  for (const root of roots) {
    computeDepth(root, 0);
  }

  roots.sort((a, b) => fileComparator(a, b));

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
 * Whether any node in the tree has nested children (i.e. the tree is more than
 * a flat list of roots).
 */
export function treeHasNestedNotes(nodes: TreeNode[]): boolean {
  return nodes.some(node => node.children.length > 0 || treeHasNestedNotes(node.children));
}

/**
 * Build a directory-based tree structure from files, grouping notes by their
 * vault-relative directory path. Notes carry `_displayName` and `_relativePath`
 * in their (copied) frontmatter for rendering.
 */
export function buildDirectoryTree(
  files: FileWithFrontmatter[],
  vaultDir: string,
  maxDepth?: number | undefined,
  fileComparator: FileComparator = compareByName
): DirectoryTreeNode[] {
  const root: DirectoryTreeNode = {
    name: '',
    path: '',
    directories: [],
    notes: [],
    depth: -1,
  };

  for (const file of files) {
    const relativePath = relative(vaultDir, file.path);
    const segments = relativePath.split('/');
    const noteName = basename(file.path, '.md');
    const directorySegments = segments.slice(0, -1);

    let current = root;
    const traversed: string[] = [];

    for (const segment of directorySegments) {
      if (maxDepth !== undefined && current.depth + 1 >= maxDepth) {
        break;
      }

      traversed.push(segment);
      let next = current.directories.find(directory => directory.name === segment);
      if (!next) {
        next = {
          name: segment,
          path: traversed.join('/'),
          directories: [],
          notes: [],
          depth: current.depth + 1,
        };
        current.directories.push(next);
      }
      current = next;
    }

    current.notes.push({
      ...file,
      path: file.path,
      frontmatter: {
        ...file.frontmatter,
        _displayName: noteName,
        _relativePath: relativePath,
      },
    });
  }

  const sortNode = (node: DirectoryTreeNode): void => {
    node.directories.sort((a, b) => a.name.localeCompare(b.name));
    node.notes.sort(fileComparator);
    for (const directory of node.directories) {
      sortNode(directory);
    }
  };

  sortNode(root);
  return root.directories;
}
