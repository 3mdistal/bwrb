import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { join } from 'path';
import { mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import {
  searchContent,
  isRipgrepAvailable,
  formatResultsText,
  formatResultsJson,
  type ContentSearchResult,
} from '../../../src/lib/content-search.js';
import { resolveSchema } from '../../../src/lib/schema.js';
import type { Schema, LoadedSchema } from '../../../src/types/schema.js';

// Minimal test schema (v2 format)
const schema_RAW: Schema = {
  version: 2,
  types: {
    note: {
      output_dir: 'Notes',
      fields: {
        status: { prompt: 'select', options: ['active', 'done', 'archived'] },
      },
    },
    task: {
      output_dir: 'Tasks',
      fields: {
        status: { prompt: 'select', options: ['active', 'done', 'archived'] },
      },
    },
  },
};

describe('content-search', () => {
  let vaultDir: string;
  let schema: LoadedSchema;

  beforeAll(async () => {
    // Create a temporary vault for testing
    vaultDir = join(tmpdir(), `bwrb-content-search-test-${Date.now()}`);
    await mkdir(join(vaultDir, '.bwrb'), { recursive: true });
    await mkdir(join(vaultDir, 'Notes'), { recursive: true });
    await mkdir(join(vaultDir, 'Tasks'), { recursive: true });

    // Write schema
    await writeFile(
      join(vaultDir, '.bwrb', 'schema.json'),
      JSON.stringify(schema_RAW, null, 2)
    );

    // Resolve the schema
    schema = resolveSchema(schema_RAW);

    // Create test notes with searchable content
    await writeFile(
      join(vaultDir, 'Notes', 'Meeting Notes.md'),
      `---
type: note
status: active
---

# Meeting Notes

Discussed the deployment strategy for Q1.
Action items:
- Review deployment pipeline
- Update documentation
`
    );

    await writeFile(
      join(vaultDir, 'Notes', 'Project Ideas.md'),
      `---
type: note
status: active
---

# Project Ideas

Some ideas for the next quarter:
- Build a deployment dashboard
- Automate testing
`
    );

    await writeFile(
      join(vaultDir, 'Notes', 'Archived Note.md'),
      `---
type: note
status: archived
---

# Old Project

This deployment was completed last year.
`
    );

    await writeFile(
      join(vaultDir, 'Tasks', 'Deploy App.md'),
      `---
type: task
status: active
---

# Deploy Application

Need to deploy the application to production.
Check deployment checklist before proceeding.
`
    );

    await writeFile(
      join(vaultDir, 'Tasks', 'Write Tests.md'),
      `---
type: task
status: done
---

# Write Unit Tests

All tests have been written and are passing.
`
    );
  });

  afterAll(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  describe('isRipgrepAvailable', () => {
    it('should return true if ripgrep is installed', async () => {
      const available = await isRipgrepAvailable();
      // This test assumes ripgrep is installed in the test environment
      expect(available).toBe(true);
    });
  });

  describe('searchContent', () => {
    it('should find matches across all files', async () => {
      const result = await searchContent({
        pattern: 'deployment',
        vaultDir,
        schema: schema,
      });

      expect(result.success).toBe(true);
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.totalMatches).toBeGreaterThan(0);
    });

    it('should filter by type when specified', async () => {
      const result = await searchContent({
        pattern: 'deploy',
        vaultDir,
        schema: schema,
        typePath: 'task',
      });

      expect(result.success).toBe(true);
      // Should only find matches in Tasks directory
      for (const r of result.results) {
        expect(r.file.relativePath).toMatch(/^Tasks\//);
      }
    });

    it('should return empty results for no matches', async () => {
      const result = await searchContent({
        pattern: 'xyznonexistent123',
        vaultDir,
        schema: schema,
      });

      expect(result.success).toBe(true);
      expect(result.results.length).toBe(0);
      expect(result.totalMatches).toBe(0);
    });

    it('should be case-insensitive by default', async () => {
      const result = await searchContent({
        pattern: 'DEPLOYMENT',
        vaultDir,
        schema: schema,
        caseSensitive: false,
      });

      expect(result.success).toBe(true);
      expect(result.results.length).toBeGreaterThan(0);
    });

    it('should respect case-sensitive flag', async () => {
      const resultInsensitive = await searchContent({
        pattern: 'DEPLOYMENT',
        vaultDir,
        schema: schema,
        caseSensitive: false,
      });

      const resultSensitive = await searchContent({
        pattern: 'DEPLOYMENT',
        vaultDir,
        schema: schema,
        caseSensitive: true,
      });

      expect(resultInsensitive.results.length).toBeGreaterThan(0);
      expect(resultSensitive.results.length).toBe(0);
    });

    it('should support regex patterns', async () => {
      const result = await searchContent({
        pattern: 'deploy.*production',
        vaultDir,
        schema: schema,
        regex: true,
      });

      expect(result.success).toBe(true);
      expect(result.results.length).toBeGreaterThan(0);
    });

    it('should include context lines', async () => {
      const result = await searchContent({
        pattern: 'deployment',
        vaultDir,
        schema: schema,
        contextLines: 2,
      });

      expect(result.success).toBe(true);
      // At least some matches should have context
      const hasContext = result.results.some((r) =>
        r.matches.some(
          (m) =>
            (m.contextBefore && m.contextBefore.length > 0) ||
            (m.contextAfter && m.contextAfter.length > 0)
        )
      );
      expect(hasContext).toBe(true);
    });

    it('should not include context when contextLines is 0', async () => {
      const result = await searchContent({
        pattern: 'deployment',
        vaultDir,
        schema: schema,
        contextLines: 0,
      });

      expect(result.success).toBe(true);
      // No matches should have context (undefined or empty array)
      for (const r of result.results) {
        for (const m of r.matches) {
          expect(m.contextBefore === undefined || m.contextBefore.length === 0).toBe(true);
          expect(m.contextAfter === undefined || m.contextAfter.length === 0).toBe(true);
        }
      }
    });

    it('should respect limit option', async () => {
      const result = await searchContent({
        pattern: 'type',
        vaultDir,
        schema: schema,
        limit: 2,
      });

      expect(result.success).toBe(true);
      expect(result.results.length).toBeLessThanOrEqual(2);
    });

    it('should indicate when results are truncated', async () => {
      const result = await searchContent({
        pattern: 'type',
        vaultDir,
        schema: schema,
        limit: 1,
      });

      // If there are more than 1 matching files, truncated should be true
      if (result.results.length === 1) {
        // Check if there would have been more results
        const fullResult = await searchContent({
          pattern: 'type',
          vaultDir,
          schema: schema,
          limit: 100,
        });
        if (fullResult.results.length > 1) {
          expect(result.truncated).toBe(true);
        }
      }
    });

    it('should return error for empty pattern', async () => {
      const result = await searchContent({
        pattern: '',
        vaultDir,
        schema: schema,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should sort results by match count descending', async () => {
      const result = await searchContent({
        pattern: 'deploy',
        vaultDir,
        schema: schema,
      });

      expect(result.success).toBe(true);
      if (result.results.length > 1) {
        for (let i = 0; i < result.results.length - 1; i++) {
          expect(result.results[i]!.matches.length).toBeGreaterThanOrEqual(
            result.results[i + 1]!.matches.length
          );
        }
      }
    });
  });

  describe('formatResultsText', () => {
    it('should format results without context', async () => {
      const result = await searchContent({
        pattern: 'deployment',
        vaultDir,
        schema: schema,
        contextLines: 0,
      });

      const text = formatResultsText(result.results, false);
      expect(text).toContain(':');
      expect(text).toContain('deployment');
    });

    it('should format results with context', async () => {
      const result = await searchContent({
        pattern: 'deployment',
        vaultDir,
        schema: schema,
        contextLines: 1,
      });

      const text = formatResultsText(result.results, true);
      expect(text).toContain(':');
      // Context lines use - instead of :
      expect(text).toMatch(/-/);
    });
  });

  describe('formatResultsJson', () => {
    it('should format successful results', async () => {
      const result = await searchContent({
        pattern: 'deployment',
        vaultDir,
        schema: schema,
      });

      const json = formatResultsJson(result);
      expect(json.success).toBe(true);
      expect(Array.isArray(json.data)).toBe(true);
      expect(json.totalMatches).toBeDefined();
    });

    it('should format error results', () => {
      const errorResult: ContentSearchResult = {
        success: false,
        results: [],
        totalMatches: 0,
        truncated: false,
        error: 'Test error',
      };

      const json = formatResultsJson(errorResult);
      expect(json.success).toBe(false);
      expect(json.error).toBe('Test error');
    });

    it('should include match details in JSON', async () => {
      const result = await searchContent({
        pattern: 'deployment',
        vaultDir,
        schema: schema,
        contextLines: 1,
      });

      const json = formatResultsJson(result);
      expect(json.success).toBe(true);
      expect(json.data).toBeDefined();
      if (json.data && json.data.length > 0) {
        const first = json.data[0]!;
        expect(first.name).toBeDefined();
        expect(first.path).toBeDefined();
        expect(first.absolutePath).toBeDefined();
        expect(first.matchCount).toBeDefined();
        expect(Array.isArray(first.matches)).toBe(true);
      }
    });
  });
});
