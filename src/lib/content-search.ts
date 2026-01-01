/**
 * Content search module - full-text search across vault notes using ripgrep.
 *
 * This module provides content-based search functionality, complementing
 * the existing name/path-based search in navigation.ts.
 */

import { spawn } from 'child_process';
import type { LoadedSchema } from '../types/schema.js';
import type { ManagedFile } from './discovery.js';
import { discoverManagedFiles } from './discovery.js';

// ============================================================================
// Types
// ============================================================================

export interface ContentSearchOptions {
  /** Search pattern (literal by default, regex if --regex flag) */
  pattern: string;
  /** Vault directory */
  vaultDir: string;
  /** Schema for type filtering */
  schema: LoadedSchema;
  /** Optional type path to restrict search (e.g., 'idea', 'objective/task') */
  typePath?: string;
  /** Number of context lines to show (default: 2) */
  contextLines?: number;
  /** Case-sensitive search (default: false) */
  caseSensitive?: boolean;
  /** Treat pattern as regex (default: false, literal search) */
  regex?: boolean;
  /** Maximum number of files to return (default: 100) */
  limit?: number;
}

export interface LineMatch {
  /** Line number (1-indexed) */
  line: number;
  /** The matched line text */
  text: string;
  /** Lines before the match */
  contextBefore?: string[];
  /** Lines after the match */
  contextAfter?: string[];
}

export interface ContentMatch {
  /** The file that matched */
  file: ManagedFile;
  /** All matches within this file */
  matches: LineMatch[];
}

export interface ContentSearchResult {
  /** Whether the search succeeded */
  success: boolean;
  /** Matching files with their matches */
  results: ContentMatch[];
  /** Total number of matches across all files */
  totalMatches: number;
  /** Whether results were truncated due to limit */
  truncated: boolean;
  /** Error message if search failed */
  error?: string;
}

// ============================================================================
// Ripgrep Integration
// ============================================================================

/**
 * Check if ripgrep is available on the system.
 */
export async function isRipgrepAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('which', ['rg'], { stdio: 'ignore' });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

/**
 * Parse ripgrep JSON output into structured results.
 */
interface RgJsonMessage {
  type: 'begin' | 'match' | 'context' | 'end' | 'summary';
  data: {
    path?: { text: string };
    lines?: { text: string };
    line_number?: number;
    submatches?: Array<{ match: { text: string }; start: number; end: number }>;
  };
}

/**
 * Run ripgrep and parse results.
 */
async function runRipgrep(
  pattern: string,
  files: string[],
  vaultDir: string,
  options: {
    contextLines: number;
    caseSensitive: boolean;
    regex: boolean;
  }
): Promise<Map<string, LineMatch[]>> {
  return new Promise((resolve, reject) => {
    const args: string[] = [
      '--json', // JSON output for structured parsing
      '--line-number', // Include line numbers
    ];

    // Context lines
    if (options.contextLines > 0) {
      args.push('-C', String(options.contextLines));
    }

    // Case sensitivity
    if (!options.caseSensitive) {
      args.push('--ignore-case');
    }

    // Literal vs regex
    if (!options.regex) {
      args.push('--fixed-strings');
    }

    // Add pattern
    args.push(pattern);

    // Add files to search
    args.push(...files);

    const rg = spawn('rg', args, {
      cwd: vaultDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    rg.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    rg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    rg.on('close', (code) => {
      // Code 0 = matches found, 1 = no matches, 2+ = error
      if (code !== null && code > 1) {
        reject(new Error(`ripgrep error: ${stderr || 'unknown error'}`));
        return;
      }

      const results = parseRipgrepOutput(stdout);
      resolve(results);
    });

    rg.on('error', (err) => {
      reject(new Error(`Failed to run ripgrep: ${err.message}`));
    });
  });
}

/**
 * Parse ripgrep JSON output into a map of file -> matches.
 * 
 * Note: ripgrep runs with cwd set to vaultDir, so paths returned are
 * already relative to the vault directory.
 */
function parseRipgrepOutput(output: string): Map<string, LineMatch[]> {
  const results = new Map<string, LineMatch[]>();
  const contextBuffer = new Map<string, { before: string[]; lineNumber: number }>();

  if (!output.trim()) {
    return results;
  }

  const lines = output.trim().split('\n');

  for (const line of lines) {
    if (!line.trim()) continue;

    let msg: RgJsonMessage;
    try {
      msg = JSON.parse(line) as RgJsonMessage;
    } catch {
      continue; // Skip malformed lines
    }

    if (msg.type === 'match' && msg.data.path?.text && msg.data.lines?.text) {
      // Path is already relative to vault (ripgrep cwd is vaultDir)
      const relativePath = msg.data.path.text;
      const lineNumber = msg.data.line_number ?? 0;
      const text = msg.data.lines.text.replace(/\n$/, ''); // Remove trailing newline

      if (!results.has(relativePath)) {
        results.set(relativePath, []);
      }

      const matches = results.get(relativePath)!;

      // Get context before from buffer
      const bufferedContext = contextBuffer.get(relativePath);
      const contextBefore = bufferedContext?.before ?? [];

      const match: LineMatch = {
        line: lineNumber,
        text,
        contextAfter: [], // Will be filled by subsequent context messages
      };
      if (contextBefore.length > 0) {
        match.contextBefore = [...contextBefore];
      }
      matches.push(match);

      // Clear the context buffer for this file
      contextBuffer.delete(relativePath);
    } else if (msg.type === 'context' && msg.data.path?.text && msg.data.lines?.text) {
      // Path is already relative to vault (ripgrep cwd is vaultDir)
      const relativePath = msg.data.path.text;
      const lineNumber = msg.data.line_number ?? 0;
      const text = msg.data.lines.text.replace(/\n$/, '');

      const matches = results.get(relativePath);

      if (matches && matches.length > 0) {
        const lastMatch = matches[matches.length - 1]!;

        // Context after the last match
        if (lineNumber > lastMatch.line) {
          if (!lastMatch.contextAfter) {
            lastMatch.contextAfter = [];
          }
          lastMatch.contextAfter.push(text);
        }
      } else {
        // Context before - buffer it
        if (!contextBuffer.has(relativePath)) {
          contextBuffer.set(relativePath, { before: [], lineNumber });
        }
        const buffer = contextBuffer.get(relativePath)!;
        buffer.before.push(text);
      }
    }
  }

  return results;
}

// ============================================================================
// Main Search Function
// ============================================================================

/**
 * Search vault content using ripgrep.
 *
 * @param options Search options including pattern, vault dir, and filters
 * @returns Search results with matching files and line matches
 */
export async function searchContent(
  options: ContentSearchOptions
): Promise<ContentSearchResult> {
  const {
    pattern,
    vaultDir,
    schema,
    typePath,
    contextLines = 2,
    caseSensitive = false,
    regex = false,
    limit = 100,
  } = options;

  // Check if ripgrep is available
  if (!(await isRipgrepAvailable())) {
    return {
      success: false,
      results: [],
      totalMatches: 0,
      truncated: false,
      error: 'ripgrep (rg) is not installed. Please install it to use content search.',
    };
  }

  // Validate pattern
  if (!pattern || pattern.trim() === '') {
    return {
      success: false,
      results: [],
      totalMatches: 0,
      truncated: false,
      error: 'Search pattern is required',
    };
  }

  try {
    // Discover files to search
    const files = await discoverManagedFiles(schema, vaultDir, typePath);

    if (files.length === 0) {
      return {
        success: true,
        results: [],
        totalMatches: 0,
        truncated: false,
      };
    }

    // Get relative paths for ripgrep
    const filePaths = files.map((f) => f.relativePath);

    // Run ripgrep
    const rgResults = await runRipgrep(pattern, filePaths, vaultDir, {
      contextLines,
      caseSensitive,
      regex,
    });

    // Convert to ContentMatch array
    const results: ContentMatch[] = [];
    let totalMatches = 0;

    // Create a map of relativePath -> ManagedFile for quick lookup
    const fileMap = new Map<string, ManagedFile>();
    for (const file of files) {
      fileMap.set(file.relativePath, file);
    }

    for (const [relativePath, matches] of rgResults.entries()) {
      const file = fileMap.get(relativePath);
      if (file) {
        results.push({ file, matches });
        totalMatches += matches.length;
      }
      // Note: Files returned by rg that aren't in fileMap are skipped
      // (this shouldn't happen since we pass the file list to rg)
    }

    // Sort by number of matches (descending), then by path
    results.sort((a, b) => {
      if (b.matches.length !== a.matches.length) {
        return b.matches.length - a.matches.length;
      }
      return a.file.relativePath.localeCompare(b.file.relativePath);
    });

    // Apply limit
    const truncated = results.length > limit;
    const limitedResults = results.slice(0, limit);

    return {
      success: true,
      results: limitedResults,
      totalMatches,
      truncated,
    };
  } catch (err) {
    return {
      success: false,
      results: [],
      totalMatches: 0,
      truncated: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ============================================================================
// Formatting Helpers
// ============================================================================

/**
 * Format a single match for text output.
 */
export function formatMatchText(
  relativePath: string,
  match: LineMatch,
  showContext: boolean
): string[] {
  const lines: string[] = [];

  if (showContext && match.contextBefore && match.contextBefore.length > 0) {
    for (let i = 0; i < match.contextBefore.length; i++) {
      const contextLine = match.line - match.contextBefore.length + i;
      lines.push(`${relativePath}:${contextLine}-${match.contextBefore[i]}`);
    }
  }

  lines.push(`${relativePath}:${match.line}:${match.text}`);

  if (showContext && match.contextAfter && match.contextAfter.length > 0) {
    for (let i = 0; i < match.contextAfter.length; i++) {
      const contextLine = match.line + 1 + i;
      lines.push(`${relativePath}:${contextLine}-${match.contextAfter[i]}`);
    }
  }

  return lines;
}

/**
 * Format search results for text output.
 */
export function formatResultsText(
  results: ContentMatch[],
  showContext: boolean
): string {
  const lines: string[] = [];

  for (const result of results) {
    for (const match of result.matches) {
      const matchLines = formatMatchText(
        result.file.relativePath,
        match,
        showContext
      );
      lines.push(...matchLines);
    }
  }

  return lines.join('\n');
}

/**
 * Format search results for JSON output.
 */
export function formatResultsJson(
  searchResult: ContentSearchResult
): {
  success: boolean;
  data?: Array<{
    name: string;
    path: string;
    absolutePath: string;
    matchCount: number;
    matches: Array<{
      line: number;
      text: string;
      contextBefore?: string[];
      contextAfter?: string[];
    }>;
  }>;
  totalMatches?: number;
  truncated?: boolean;
  error?: string;
} {
  if (!searchResult.success) {
    const result: {
      success: boolean;
      error?: string;
    } = { success: false };
    if (searchResult.error !== undefined) {
      result.error = searchResult.error;
    }
    return result;
  }

  return {
    success: true,
    data: searchResult.results.map((result) => ({
      name: result.file.relativePath.replace(/\.md$/, '').split('/').pop() || '',
      path: result.file.relativePath,
      absolutePath: result.file.path,
      matchCount: result.matches.length,
      matches: result.matches.map((m) => ({
        line: m.line,
        text: m.text,
        ...(m.contextBefore && m.contextBefore.length > 0
          ? { contextBefore: m.contextBefore }
          : {}),
        ...(m.contextAfter && m.contextAfter.length > 0
          ? { contextAfter: m.contextAfter }
          : {}),
      })),
    })),
    totalMatches: searchResult.totalMatches,
    truncated: searchResult.truncated,
  };
}
