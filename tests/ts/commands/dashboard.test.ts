import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdir, writeFile, rm } from 'fs/promises';
import { createTestVault, cleanupTestVault, runCLI } from '../fixtures/setup.js';
import type { DashboardsFile } from '../../../src/types/schema.js';

describe('dashboard command', () => {
  let vaultDir: string;

  beforeAll(async () => {
    vaultDir = await createTestVault();
  });

  afterAll(async () => {
    await cleanupTestVault(vaultDir);
  });

  // Helper to create dashboards for tests
  async function createDashboards(dashboards: DashboardsFile): Promise<void> {
    await writeFile(
      join(vaultDir, '.bwrb', 'dashboards.json'),
      JSON.stringify(dashboards, null, 2)
    );
  }

  // Helper to remove dashboards between tests
  async function removeDashboards(): Promise<void> {
    try {
      await rm(join(vaultDir, '.bwrb', 'dashboards.json'));
    } catch {
      // File may not exist, ignore
    }
  }

  describe('running dashboards', () => {
    beforeEach(async () => {
      // Set up test dashboards
      await createDashboards({
        dashboards: {
          'all-ideas': {
            type: 'idea',
          },
          'raw-ideas': {
            type: 'idea',
            where: ["status == 'raw'"],
          },
          'high-priority': {
            type: 'idea',
            where: ["priority == 'high'"],
          },
          'tasks-with-output': {
            type: 'task',
            output: 'paths',
          },
          'ideas-with-fields': {
            type: 'idea',
            fields: ['status', 'priority'],
          },
          'empty-dashboard': {},
        },
      });
    });

    afterEach(async () => {
      await removeDashboards();
    });

    it('should run dashboard with type filter', async () => {
      const result = await runCLI(['dashboard', 'all-ideas'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Sample Idea');
      expect(result.stdout).toContain('Another Idea');
      // Should not contain non-ideas
      expect(result.stdout).not.toContain('Sample Task');
    });

    it('should run dashboard with where filter', async () => {
      const result = await runCLI(['dashboard', 'raw-ideas'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Sample Idea');
      // Another Idea has status: backlog, not raw
      expect(result.stdout).not.toContain('Another Idea');
    });

    it('should run dashboard with priority filter', async () => {
      const result = await runCLI(['dashboard', 'high-priority'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Another Idea');
      // Sample Idea has priority: medium, not high
      expect(result.stdout).not.toContain('Sample Idea');
    });

    it('should use dashboard default output format', async () => {
      const result = await runCLI(['dashboard', 'tasks-with-output'], vaultDir);

      expect(result.exitCode).toBe(0);
      // Output format is 'paths', so should show file paths
      expect(result.stdout).toContain('Objectives/Tasks/Sample Task.md');
    });

    it('should display fields when dashboard specifies them', async () => {
      const result = await runCLI(['dashboard', 'ideas-with-fields'], vaultDir);

      expect(result.exitCode).toBe(0);
      // Should show table with fields
      expect(result.stdout).toContain('STATUS');
      expect(result.stdout).toContain('PRIORITY');
      expect(result.stdout).toContain('raw');
      expect(result.stdout).toContain('medium');
    });

    it('should handle empty dashboard (no filters)', async () => {
      const result = await runCLI(['dashboard', 'empty-dashboard'], vaultDir);

      expect(result.exitCode).toBe(0);
      // Should list all notes
      expect(result.stdout).toContain('Sample Idea');
      expect(result.stdout).toContain('Sample Task');
    });
  });

  describe('output format override', () => {
    beforeEach(async () => {
      await createDashboards({
        dashboards: {
          'default-output': {
            type: 'idea',
          },
          'paths-output': {
            type: 'idea',
            output: 'paths',
          },
          'json-output': {
            type: 'idea',
            output: 'json',
          },
        },
      });
    });

    afterEach(async () => {
      await removeDashboards();
    });

    it('should use default output when dashboard has no output specified', async () => {
      const result = await runCLI(['dashboard', 'default-output'], vaultDir);

      expect(result.exitCode).toBe(0);
      // Default output shows names only
      expect(result.stdout).toContain('Sample Idea');
      expect(result.stdout).not.toContain('.md');
    });

    it('should override dashboard output with --output flag', async () => {
      const result = await runCLI(['dashboard', 'paths-output', '--output', 'link'], vaultDir);

      expect(result.exitCode).toBe(0);
      // Should show wikilinks instead of paths
      expect(result.stdout).toContain('[[Sample Idea]]');
      expect(result.stdout).not.toContain('.md');
    });

    it('should support --output json', async () => {
      const result = await runCLI(['dashboard', 'default-output', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(Array.isArray(json)).toBe(true);
      expect(json.length).toBeGreaterThan(0);
      expect(json[0]).toHaveProperty('_path');
      expect(json[0]).toHaveProperty('_name');
    });

    it('should support --output paths', async () => {
      const result = await runCLI(['dashboard', 'default-output', '--output', 'paths'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Ideas/Sample Idea.md');
    });

    it('should support -o shorthand for --output', async () => {
      const result = await runCLI(['dashboard', 'default-output', '-o', 'link'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('[[Sample Idea]]');
    });

    it('should use dashboard default output format (json)', async () => {
      const result = await runCLI(['dashboard', 'json-output'], vaultDir);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(Array.isArray(json)).toBe(true);
      expect(json.length).toBeGreaterThan(0);
    });

    it('should override json default with --output text', async () => {
      const result = await runCLI(['dashboard', 'json-output', '--output', 'text'], vaultDir);

      expect(result.exitCode).toBe(0);
      // Should show names, not JSON
      expect(result.stdout).toContain('Sample Idea');
      expect(result.stdout).not.toContain('"_path"');
    });
  });

  describe('error handling', () => {
    beforeEach(async () => {
      await createDashboards({
        dashboards: {
          'existing-dashboard': {
            type: 'idea',
          },
        },
      });
    });

    afterEach(async () => {
      await removeDashboards();
    });

    it('should error when dashboard does not exist', async () => {
      const result = await runCLI(['dashboard', 'nonexistent'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Dashboard "nonexistent" does not exist');
    });

    it('should return JSON error when dashboard does not exist in JSON mode', async () => {
      const result = await runCLI(['dashboard', 'nonexistent', '--output', 'json'], vaultDir);

      expect(result.exitCode).not.toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('Dashboard "nonexistent" does not exist');
    });

    it('should handle missing dashboards.json gracefully', async () => {
      await removeDashboards();
      const result = await runCLI(['dashboard', 'any-name'], vaultDir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('does not exist');
    });
  });

  describe('empty results', () => {
    beforeEach(async () => {
      await createDashboards({
        dashboards: {
          'no-matches': {
            type: 'idea',
            where: ["status == 'nonexistent-status'"],
          },
        },
      });
    });

    afterEach(async () => {
      await removeDashboards();
    });

    it('should handle dashboard with no matching results', async () => {
      const result = await runCLI(['dashboard', 'no-matches'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
    });

    it('should return empty array in JSON mode for no results', async () => {
      const result = await runCLI(['dashboard', 'no-matches', '--output', 'json'], vaultDir);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(Array.isArray(json)).toBe(true);
      expect(json.length).toBe(0);
    });
  });

  describe('help and documentation', () => {
    it('should show help text', async () => {
      const result = await runCLI(['dashboard', '--help'], vaultDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Run a saved dashboard query');
      expect(result.stdout).toContain('--output');
      expect(result.stdout).toContain('bwrb dashboard list');
    });
  });
});
