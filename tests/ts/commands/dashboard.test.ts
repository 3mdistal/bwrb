import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { writeFile, rm, readFile } from 'fs/promises';
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

  // Helper to read dashboards from file
  async function readDashboards(): Promise<DashboardsFile> {
    const content = await readFile(join(vaultDir, '.bwrb', 'dashboards.json'), 'utf-8');
    return JSON.parse(content) as DashboardsFile;
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

    it('should support --output flag to override format', async () => {
      const result = await runCLI(['dashboard', 'default-output', '--output', 'link'], vaultDir);

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
            // 'settled' is a valid status for idea, but no ideas in test vault have this status
            where: ["status == 'settled'"],
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
      expect(result.stdout).toContain('Run or manage saved dashboard queries');
      expect(result.stdout).toContain('--output');
      expect(result.stdout).toContain('bwrb dashboard my-tasks');
      expect(result.stdout).toContain('bwrb dashboard list');
    });
  });

  // ============================================================================
  // dashboard list tests
  // ============================================================================

  describe('dashboard list', () => {
    describe('with dashboards', () => {
      beforeEach(async () => {
        await createDashboards({
          dashboards: {
            'alpha-tasks': {
              type: 'task',
              where: ["status == 'active'"],
              output: 'tree',
            },
            'beta-ideas': {
              type: 'idea',
              path: 'Projects/**',
              body: 'urgent',
            },
            'gamma-all': {
              // Empty dashboard - just a name
            },
            'delta-complex': {
              type: 'objective',
              where: ["status == 'active'", "priority == 'high'"],
              output: 'json',
              fields: ['name', 'status', 'deadline'],
            },
          },
        });
      });

      afterEach(async () => {
        await removeDashboards();
      });

      it('should list all dashboards in text format', async () => {
        const result = await runCLI(['dashboard', 'list'], vaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Dashboards');
        expect(result.stdout).toContain('alpha-tasks');
        expect(result.stdout).toContain('beta-ideas');
        expect(result.stdout).toContain('gamma-all');
        expect(result.stdout).toContain('delta-complex');
        expect(result.stdout).toContain('4 dashboard(s) found');
      });

      it('should show dashboard names sorted alphabetically', async () => {
        const result = await runCLI(['dashboard', 'list'], vaultDir);

        expect(result.exitCode).toBe(0);
        const lines = result.stdout.split('\n');
        const dashboardLines = lines.filter(l => 
          l.includes('alpha-tasks') || 
          l.includes('beta-ideas') || 
          l.includes('delta-complex') || 
          l.includes('gamma-all')
        );
        // Should appear in alphabetical order
        expect(dashboardLines.length).toBe(4);
        expect(dashboardLines[0]).toContain('alpha-tasks');
        expect(dashboardLines[1]).toContain('beta-ideas');
        expect(dashboardLines[2]).toContain('delta-complex');
        expect(dashboardLines[3]).toContain('gamma-all');
      });

      it('should show type column for dashboards with type', async () => {
        const result = await runCLI(['dashboard', 'list'], vaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('task');
        expect(result.stdout).toContain('idea');
        expect(result.stdout).toContain('objective');
      });

      it('should show filter info for dashboards', async () => {
        const result = await runCLI(['dashboard', 'list'], vaultDir);

        expect(result.exitCode).toBe(0);
        // alpha-tasks has where: 1 expression
        expect(result.stdout).toContain('where: 1');
        // beta-ideas has path and body
        expect(result.stdout).toContain('path:');
        expect(result.stdout).toContain('body:');
        // delta-complex has multiple filters
        expect(result.stdout).toContain('where: 2');
        expect(result.stdout).toContain('fields: 3');
      });

      it('should list dashboards in JSON format', async () => {
        const result = await runCLI(['dashboard', 'list', '--output', 'json'], vaultDir);

        expect(result.exitCode).toBe(0);
        const json = JSON.parse(result.stdout);
        expect(json.success).toBe(true);
        expect(json.data.dashboards).toBeDefined();
        expect(Object.keys(json.data.dashboards)).toHaveLength(4);
        expect(json.data.dashboards['alpha-tasks']).toEqual({
          type: 'task',
          where: ["status == 'active'"],
          output: 'tree',
        });
        expect(json.data.dashboards['beta-ideas']).toEqual({
          type: 'idea',
          path: 'Projects/**',
          body: 'urgent',
        });
        expect(json.data.dashboards['gamma-all']).toEqual({});
      });

      it('should support -o shorthand for --output', async () => {
        const result = await runCLI(['dashboard', 'list', '--output', 'json'], vaultDir);

        expect(result.exitCode).toBe(0);
        const json = JSON.parse(result.stdout);
        expect(json.success).toBe(true);
        expect(json.data.dashboards).toBeDefined();
      });
    });

    describe('with no dashboards', () => {
      beforeEach(async () => {
        await removeDashboards();
      });

      it('should show helpful message when no dashboards exist', async () => {
        const result = await runCLI(['dashboard', 'list'], vaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('No dashboards saved');
        expect(result.stdout).toContain('bwrb dashboard new');
        expect(result.stdout).toContain('--save-as');
      });

      it('should return empty dashboards object in JSON mode', async () => {
        const result = await runCLI(['dashboard', 'list', '--output', 'json'], vaultDir);

        expect(result.exitCode).toBe(0);
        const json = JSON.parse(result.stdout);
        expect(json.success).toBe(true);
        expect(json.data.dashboards).toEqual({});
      });
    });

    describe('with empty dashboards file', () => {
      beforeEach(async () => {
        await createDashboards({ dashboards: {} });
      });

      afterEach(async () => {
        await removeDashboards();
      });

      it('should show helpful message when dashboards file is empty', async () => {
        const result = await runCLI(['dashboard', 'list'], vaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('No dashboards saved');
      });
    });

    describe('help', () => {
      it('should show help for dashboard list', async () => {
        const result = await runCLI(['dashboard', 'list', '--help'], vaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('List all saved dashboards');
        expect(result.stdout).toContain('--output');
      });
    });
  });

  // ============================================================================
  // dashboard new command tests
  // ============================================================================

  describe('dashboard new', () => {
    afterEach(async () => {
      await removeDashboards();
    });

    describe('creating with flags', () => {
      it('should create dashboard with --type flag', async () => {
        const result = await runCLI(['dashboard', 'new', 'my-tasks', '--type', 'task'], vaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Created dashboard: my-tasks');

        const dashboards = await readDashboards();
        expect(dashboards.dashboards['my-tasks']).toBeDefined();
        expect(dashboards.dashboards['my-tasks']!.type).toBe('task');
      });

      it('should create dashboard with --where flag', async () => {
        const result = await runCLI([
          'dashboard', 'new', 'active-tasks',
          '--type', 'task',
          '--where', "status == 'active'"
        ], vaultDir);

        expect(result.exitCode).toBe(0);

        const dashboards = await readDashboards();
        expect(dashboards.dashboards['active-tasks']!.where).toEqual(["status == 'active'"]);
      });

      it('should create dashboard with multiple --where flags', async () => {
        const result = await runCLI([
          'dashboard', 'new', 'filtered-tasks',
          '--type', 'task',
          '--where', "status == 'active'",
          '--where', "priority < 3"
        ], vaultDir);

        expect(result.exitCode).toBe(0);

        const dashboards = await readDashboards();
        expect(dashboards.dashboards['filtered-tasks']!.where).toEqual([
          "status == 'active'",
          "priority < 3"
        ]);
      });

      it('should create dashboard with --body flag', async () => {
        const result = await runCLI([
          'dashboard', 'new', 'search-dashboard',
          '--body', 'TODO'
        ], vaultDir);

        expect(result.exitCode).toBe(0);

        const dashboards = await readDashboards();
        expect(dashboards.dashboards['search-dashboard']!.body).toBe('TODO');
      });

      it('should create dashboard with --path flag', async () => {
        const result = await runCLI([
          'dashboard', 'new', 'projects-dashboard',
          '--path', 'Projects/**'
        ], vaultDir);

        expect(result.exitCode).toBe(0);

        const dashboards = await readDashboards();
        expect(dashboards.dashboards['projects-dashboard']!.path).toBe('Projects/**');
      });

      it('should create dashboard with --default-output flag', async () => {
        const result = await runCLI([
          'dashboard', 'new', 'tree-dashboard',
          '--type', 'task',
          '--default-output', 'tree'
        ], vaultDir);

        expect(result.exitCode).toBe(0);

        const dashboards = await readDashboards();
        expect(dashboards.dashboards['tree-dashboard']!.output).toBe('tree');
      });

      it('should create dashboard with --fields flag', async () => {
        const result = await runCLI([
          'dashboard', 'new', 'table-dashboard',
          '--type', 'idea',
          '--fields', 'status,priority'
        ], vaultDir);

        expect(result.exitCode).toBe(0);

        const dashboards = await readDashboards();
        expect(dashboards.dashboards['table-dashboard']!.fields).toEqual(['status', 'priority']);
      });

      it('should create dashboard with all flags combined', async () => {
        const result = await runCLI([
          'dashboard', 'new', 'full-dashboard',
          '--type', 'task',
          '--where', "status == 'active'",
          '--body', 'TODO',
          '--path', 'Projects/**',
          '--default-output', 'paths',
          '--fields', 'status,priority'
        ], vaultDir);

        expect(result.exitCode).toBe(0);

        const dashboards = await readDashboards();
        const dashboard = dashboards.dashboards['full-dashboard'];
        expect(dashboard!.type).toBe('task');
        expect(dashboard!.where).toEqual(["status == 'active'"]);
        expect(dashboard!.body).toBe('TODO');
        expect(dashboard!.path).toBe('Projects/**');
        expect(dashboard!.output).toBe('paths');
        expect(dashboard!.fields).toEqual(['status', 'priority']);
      });

      it('should use -t, -p, -w, -b shorthand flags', async () => {
        const result = await runCLI([
          'dashboard', 'new', 'shorthand-dashboard',
          '-t', 'idea',
          '-p', 'Ideas/**',
          '-w', "status == 'raw'",
          '-b', 'important',
          '--default-output', 'link'  // No shorthand for default-output
        ], vaultDir);

        expect(result.exitCode).toBe(0);

        const dashboards = await readDashboards();
        const dashboard = dashboards.dashboards['shorthand-dashboard'];
        expect(dashboard!.type).toBe('idea');
        expect(dashboard!.path).toBe('Ideas/**');
        expect(dashboard!.where).toEqual(["status == 'raw'"]);
        expect(dashboard!.body).toBe('important');
        expect(dashboard!.output).toBe('link');
      });
    });

    describe('creating with --json', () => {
      it('should create dashboard from JSON input', async () => {
        const result = await runCLI([
          'dashboard', 'new', 'json-dashboard',
          '--json', '{"type":"task","where":["status==active"]}'
        ], vaultDir);

        expect(result.exitCode).toBe(0);
        const output = JSON.parse(result.stdout);
        expect(output.success).toBe(true);
        expect(output.data.name).toBe('json-dashboard');

        const dashboards = await readDashboards();
        expect(dashboards.dashboards['json-dashboard']!.type).toBe('task');
      });

      it('should return JSON success response', async () => {
        const result = await runCLI([
          'dashboard', 'new', 'json-response-test',
          '--json', '{"type":"idea"}'
        ], vaultDir);

        expect(result.exitCode).toBe(0);
        const output = JSON.parse(result.stdout);
        expect(output.success).toBe(true);
        expect(output.message).toBe('Dashboard created');
        expect(output.data.name).toBe('json-response-test');
        expect(output.data.definition.type).toBe('idea');
      });

      it('should error on invalid JSON', async () => {
        const result = await runCLI([
          'dashboard', 'new', 'invalid-json',
          '--json', 'not valid json'
        ], vaultDir);

        expect(result.exitCode).not.toBe(0);
        const output = JSON.parse(result.stdout);
        expect(output.success).toBe(false);
        expect(output.error).toContain('Invalid JSON');
      });
    });

    describe('error handling', () => {
      it('should error when dashboard name already exists', async () => {
        // Create first dashboard
        await runCLI(['dashboard', 'new', 'existing', '--type', 'task'], vaultDir);

        // Try to create another with same name
        const result = await runCLI(['dashboard', 'new', 'existing', '--type', 'idea'], vaultDir);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Dashboard "existing" already exists');
      });

      it('should error on duplicate name in JSON mode', async () => {
        await runCLI(['dashboard', 'new', 'existing', '--json', '{}'], vaultDir);

        const result = await runCLI(['dashboard', 'new', 'existing', '--json', '{}'], vaultDir);

        expect(result.exitCode).not.toBe(0);
        const output = JSON.parse(result.stdout);
        expect(output.success).toBe(false);
        expect(output.error).toContain('already exists');
      });

      it('should error on invalid type', async () => {
        const result = await runCLI([
          'dashboard', 'new', 'bad-type',
          '--type', 'nonexistent-type'
        ], vaultDir);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Unknown type: nonexistent-type');
      });

      it('should error on invalid type in JSON mode', async () => {
        const result = await runCLI([
          'dashboard', 'new', 'bad-type',
          '--type', 'nonexistent-type',
          '--json', '{}'
        ], vaultDir);

        expect(result.exitCode).not.toBe(0);
        const output = JSON.parse(result.stdout);
        expect(output.success).toBe(false);
        expect(output.error).toContain('Unknown type');
      });
    });

    describe('help text', () => {
      it('should show help for dashboard new', async () => {
        const result = await runCLI(['dashboard', 'new', '--help'], vaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Create a new dashboard');
        expect(result.stdout).toContain('--type');
        expect(result.stdout).toContain('--where');
        expect(result.stdout).toContain('--body');
        expect(result.stdout).toContain('--path');
        expect(result.stdout).toContain('--default-output');
        expect(result.stdout).toContain('--fields');
        expect(result.stdout).toContain('--json');
      });
    });

    describe('running created dashboards', () => {
      it('should be able to run a created dashboard', async () => {
        // Create a dashboard
        await runCLI(['dashboard', 'new', 'my-ideas', '--type', 'idea'], vaultDir);

        // Run it
        const result = await runCLI(['dashboard', 'my-ideas'], vaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Sample Idea');
        expect(result.stdout).toContain('Another Idea');
      });

      it('should apply where filters from created dashboard', async () => {
        // Create a dashboard with filter
        await runCLI([
          'dashboard', 'new', 'raw-ideas',
          '--type', 'idea',
          '--where', "status == 'raw'"
        ], vaultDir);

        // Run it
        const result = await runCLI(['dashboard', 'raw-ideas'], vaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Sample Idea');
        expect(result.stdout).not.toContain('Another Idea'); // status: backlog
      });
    });
  });

  describe('dashboard without arguments', () => {
    describe('empty state (no dashboards)', () => {
      beforeEach(async () => {
        await removeDashboards();
      });

      it('should show helpful message when no dashboards exist', async () => {
        const result = await runCLI(['dashboard'], vaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('No dashboards saved');
        expect(result.stdout).toContain('bwrb dashboard new');
        expect(result.stdout).toContain('--save-as');
      });

      it('should return empty list in JSON mode when no dashboards exist', async () => {
        const result = await runCLI(['dashboard', '--output', 'json'], vaultDir);

        expect(result.exitCode).toBe(0);
        const json = JSON.parse(result.stdout);
        expect(json.success).toBe(true);
        expect(json.data.dashboards).toEqual([]);
        expect(json.data.default).toBe(null);
      });
    });

    describe('JSON mode', () => {
      beforeEach(async () => {
        await createDashboards({
          dashboards: {
            'alpha-tasks': { type: 'task' },
            'beta-ideas': { type: 'idea' },
          },
        });
      });

      afterEach(async () => {
        await removeDashboards();
      });

      it('should return list of dashboards in JSON mode', async () => {
        const result = await runCLI(['dashboard', '--output', 'json'], vaultDir);

        expect(result.exitCode).toBe(0);
        const json = JSON.parse(result.stdout);
        expect(json.success).toBe(true);
        expect(json.data.dashboards).toEqual(['alpha-tasks', 'beta-ideas']);
        expect(json.data.default).toBe(null);
      });

      it('should include default dashboard in JSON response when configured', async () => {
        // Set default_dashboard in config
        const schemaPath = join(vaultDir, '.bwrb', 'schema.json');
        const schemaContent = await readFile(schemaPath, 'utf-8');
        const schema = JSON.parse(schemaContent);
        schema.config = { ...schema.config, default_dashboard: 'alpha-tasks' };
        await writeFile(schemaPath, JSON.stringify(schema, null, 2));

        const result = await runCLI(['dashboard', '--output', 'json'], vaultDir);

        expect(result.exitCode).toBe(0);
        const json = JSON.parse(result.stdout);
        expect(json.data.default).toBe('alpha-tasks');

        // Clean up
        delete schema.config.default_dashboard;
        await writeFile(schemaPath, JSON.stringify(schema, null, 2));
      });
    });

    describe('default dashboard', () => {
      beforeEach(async () => {
        await createDashboards({
          dashboards: {
            'my-tasks': { type: 'task' },
            'my-ideas': { type: 'idea' },
          },
        });
      });

      afterEach(async () => {
        await removeDashboards();
        // Clean up config
        const schemaPath = join(vaultDir, '.bwrb', 'schema.json');
        const schemaContent = await readFile(schemaPath, 'utf-8');
        const schema = JSON.parse(schemaContent);
        if (schema.config?.default_dashboard) {
          delete schema.config.default_dashboard;
          await writeFile(schemaPath, JSON.stringify(schema, null, 2));
        }
      });

      it('should run default dashboard when configured', async () => {
        // Set default_dashboard in config
        const schemaPath = join(vaultDir, '.bwrb', 'schema.json');
        const schemaContent = await readFile(schemaPath, 'utf-8');
        const schema = JSON.parse(schemaContent);
        schema.config = { ...schema.config, default_dashboard: 'my-ideas' };
        await writeFile(schemaPath, JSON.stringify(schema, null, 2));

        const result = await runCLI(['dashboard'], vaultDir);

        expect(result.exitCode).toBe(0);
        // Should show ideas, not tasks
        expect(result.stdout).toContain('Sample Idea');
        expect(result.stdout).toContain('Another Idea');
      });

      it('should warn when default dashboard does not exist and list available', async () => {
        // Set non-existent default_dashboard in config
        const schemaPath = join(vaultDir, '.bwrb', 'schema.json');
        const schemaContent = await readFile(schemaPath, 'utf-8');
        const schema = JSON.parse(schemaContent);
        schema.config = { ...schema.config, default_dashboard: 'nonexistent' };
        await writeFile(schemaPath, JSON.stringify(schema, null, 2));

        // In non-TTY mode, should show warning and list available dashboards
        const result = await runCLI(['dashboard'], vaultDir);

        // Should show warning about missing default
        expect(result.stderr).toContain('Default dashboard "nonexistent" not found');
        // Should show available dashboards since we're not in a TTY
        expect(result.stderr).toContain('No dashboard specified');
        expect(result.stdout).toContain('Available dashboards');
        expect(result.stdout).toContain('my-tasks');
        expect(result.stdout).toContain('my-ideas');
      });

      it('should list available dashboards when no TTY and no default', async () => {
        // Remove default dashboard to test picker fallback
        const schemaPath = join(vaultDir, '.bwrb', 'schema.json');
        const schemaContent = await readFile(schemaPath, 'utf-8');
        const schema = JSON.parse(schemaContent);
        if (schema.config?.default_dashboard) {
          delete schema.config.default_dashboard;
          await writeFile(schemaPath, JSON.stringify(schema, null, 2));
        }

        // In non-TTY mode, should list available dashboards
        const result = await runCLI(['dashboard'], vaultDir);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('No dashboard specified');
        expect(result.stdout).toContain('Available dashboards');
        expect(result.stdout).toContain('my-tasks');
        expect(result.stdout).toContain('my-ideas');
      });
    });
  });

  // ============================================================================
  // dashboard edit command tests
  // ============================================================================

  describe('dashboard edit', () => {
    afterEach(async () => {
      await removeDashboards();
    });

    describe('editing with flags', () => {
      beforeEach(async () => {
        await createDashboards({
          dashboards: {
            'my-tasks': {
              type: 'task',
              where: ["status == 'active'"],
              output: 'tree',
            },
          },
        });
      });

      it('should update dashboard type with --type flag', async () => {
        const result = await runCLI(['dashboard', 'edit', 'my-tasks', '--type', 'idea'], vaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Updated dashboard: my-tasks');

        const dashboards = await readDashboards();
        expect(dashboards.dashboards['my-tasks']!.type).toBe('idea');
        // Should preserve other fields
        expect(dashboards.dashboards['my-tasks']!.where).toEqual(["status == 'active'"]);
        expect(dashboards.dashboards['my-tasks']!.output).toBe('tree');
      });

      it('should update dashboard where with --where flag (replaces existing)', async () => {
        const result = await runCLI([
          'dashboard', 'edit', 'my-tasks',
          '--where', "priority == 'high'"
        ], vaultDir);

        expect(result.exitCode).toBe(0);

        const dashboards = await readDashboards();
        expect(dashboards.dashboards['my-tasks']!.where).toEqual(["priority == 'high'"]);
        // Should preserve other fields
        expect(dashboards.dashboards['my-tasks']!.type).toBe('task');
        expect(dashboards.dashboards['my-tasks']!.output).toBe('tree');
      });

      it('should update with multiple --where flags', async () => {
        const result = await runCLI([
          'dashboard', 'edit', 'my-tasks',
          '--where', "status == 'active'",
          '--where', "priority < 3"
        ], vaultDir);

        expect(result.exitCode).toBe(0);

        const dashboards = await readDashboards();
        expect(dashboards.dashboards['my-tasks']!.where).toEqual([
          "status == 'active'",
          "priority < 3"
        ]);
      });

      it('should update dashboard body with --body flag', async () => {
        const result = await runCLI([
          'dashboard', 'edit', 'my-tasks',
          '--body', 'TODO'
        ], vaultDir);

        expect(result.exitCode).toBe(0);

        const dashboards = await readDashboards();
        expect(dashboards.dashboards['my-tasks']!.body).toBe('TODO');
      });

      it('should update dashboard path with --path flag', async () => {
        const result = await runCLI([
          'dashboard', 'edit', 'my-tasks',
          '--path', 'Projects/**'
        ], vaultDir);

        expect(result.exitCode).toBe(0);

        const dashboards = await readDashboards();
        expect(dashboards.dashboards['my-tasks']!.path).toBe('Projects/**');
      });

      it('should update dashboard default-output with --default-output flag', async () => {
        const result = await runCLI([
          'dashboard', 'edit', 'my-tasks',
          '--default-output', 'paths'
        ], vaultDir);

        expect(result.exitCode).toBe(0);

        const dashboards = await readDashboards();
        expect(dashboards.dashboards['my-tasks']!.output).toBe('paths');
      });

      it('should update dashboard fields with --fields flag', async () => {
        const result = await runCLI([
          'dashboard', 'edit', 'my-tasks',
          '--fields', 'status,priority,deadline'
        ], vaultDir);

        expect(result.exitCode).toBe(0);

        const dashboards = await readDashboards();
        expect(dashboards.dashboards['my-tasks']!.fields).toEqual(['status', 'priority', 'deadline']);
      });

      it('should update multiple fields at once', async () => {
        const result = await runCLI([
          'dashboard', 'edit', 'my-tasks',
          '--type', 'idea',
          '--where', "status == 'raw'",
          '--default-output', 'link'
        ], vaultDir);

        expect(result.exitCode).toBe(0);

        const dashboards = await readDashboards();
        expect(dashboards.dashboards['my-tasks']!.type).toBe('idea');
        expect(dashboards.dashboards['my-tasks']!.where).toEqual(["status == 'raw'"]);
        expect(dashboards.dashboards['my-tasks']!.output).toBe('link');
      });

      it('should use -t, -p, -w, -b shorthand flags', async () => {
        const result = await runCLI([
          'dashboard', 'edit', 'my-tasks',
          '-t', 'idea',
          '-p', 'Ideas/**',
          '-w', "status == 'raw'",
          '-b', 'important'
        ], vaultDir);

        expect(result.exitCode).toBe(0);

        const dashboards = await readDashboards();
        const dashboard = dashboards.dashboards['my-tasks'];
        expect(dashboard!.type).toBe('idea');
        expect(dashboard!.path).toBe('Ideas/**');
        expect(dashboard!.where).toEqual(["status == 'raw'"]);
        expect(dashboard!.body).toBe('important');
      });
    });

    describe('editing with --json', () => {
      beforeEach(async () => {
        await createDashboards({
          dashboards: {
            'my-tasks': {
              type: 'task',
              where: ["status == 'active'"],
            },
          },
        });
      });

      it('should update dashboard from JSON input (replaces entire definition)', async () => {
        const result = await runCLI([
          'dashboard', 'edit', 'my-tasks',
          '--json', '{"type":"idea","output":"tree"}'
        ], vaultDir);

        expect(result.exitCode).toBe(0);
        const output = JSON.parse(result.stdout);
        expect(output.success).toBe(true);
        expect(output.message).toBe('Dashboard updated');
        expect(output.data.name).toBe('my-tasks');

        const dashboards = await readDashboards();
        // JSON replaces entire definition
        expect(dashboards.dashboards['my-tasks']!.type).toBe('idea');
        expect(dashboards.dashboards['my-tasks']!.output).toBe('tree');
        expect(dashboards.dashboards['my-tasks']!.where).toBeUndefined();
      });

      it('should return JSON success response', async () => {
        const result = await runCLI([
          'dashboard', 'edit', 'my-tasks',
          '--json', '{"type":"objective"}'
        ], vaultDir);

        expect(result.exitCode).toBe(0);
        const output = JSON.parse(result.stdout);
        expect(output.success).toBe(true);
        expect(output.message).toBe('Dashboard updated');
        expect(output.data.name).toBe('my-tasks');
        expect(output.data.definition.type).toBe('objective');
      });

      it('should error on invalid JSON', async () => {
        const result = await runCLI([
          'dashboard', 'edit', 'my-tasks',
          '--json', 'not valid json'
        ], vaultDir);

        expect(result.exitCode).not.toBe(0);
        const output = JSON.parse(result.stdout);
        expect(output.success).toBe(false);
        expect(output.error).toContain('Invalid JSON');
      });
    });

    describe('error handling', () => {
      it('should error when dashboard does not exist', async () => {
        const result = await runCLI(['dashboard', 'edit', 'nonexistent', '--type', 'task'], vaultDir);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Dashboard "nonexistent" does not exist');
      });

      it('should error on invalid type', async () => {
        await createDashboards({
          dashboards: {
            'my-tasks': { type: 'task' },
          },
        });

        const result = await runCLI([
          'dashboard', 'edit', 'my-tasks',
          '--type', 'nonexistent-type'
        ], vaultDir);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Unknown type: nonexistent-type');
      });

      it('should return JSON error when dashboard does not exist in JSON mode', async () => {
        const result = await runCLI([
          'dashboard', 'edit', 'nonexistent',
          '--json', '{}'
        ], vaultDir);

        expect(result.exitCode).not.toBe(0);
        const output = JSON.parse(result.stdout);
        expect(output.success).toBe(false);
        expect(output.error).toContain('does not exist');
      });

      it('should return JSON error on invalid type in JSON mode', async () => {
        await createDashboards({
          dashboards: {
            'my-tasks': { type: 'task' },
          },
        });

        const result = await runCLI([
          'dashboard', 'edit', 'my-tasks',
          '--type', 'bad-type',
          '--json', '{}'
        ], vaultDir);

        expect(result.exitCode).not.toBe(0);
        const output = JSON.parse(result.stdout);
        expect(output.success).toBe(false);
        expect(output.error).toContain('Unknown type');
      });

      it('should error when no name provided in non-TTY mode', async () => {
        await createDashboards({
          dashboards: {
            'my-tasks': { type: 'task' },
          },
        });

        // Without a name, should show error and list available dashboards
        const result = await runCLI(['dashboard', 'edit'], vaultDir);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('No dashboard specified');
        expect(result.stdout).toContain('Available dashboards');
        expect(result.stdout).toContain('my-tasks');
      });

      it('should show helpful message when no dashboards to edit', async () => {
        const result = await runCLI(['dashboard', 'edit'], vaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('No dashboards to edit');
        expect(result.stdout).toContain('bwrb dashboard new');
      });
    });

    describe('help text', () => {
      it('should show help for dashboard edit', async () => {
        const result = await runCLI(['dashboard', 'edit', '--help'], vaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Edit an existing dashboard');
        expect(result.stdout).toContain('--type');
        expect(result.stdout).toContain('--where');
        expect(result.stdout).toContain('--body');
        expect(result.stdout).toContain('--path');
        expect(result.stdout).toContain('--default-output');
        expect(result.stdout).toContain('--fields');
        expect(result.stdout).toContain('--json');
      });
    });

    describe('running edited dashboards', () => {
      it('should be able to run an edited dashboard', async () => {
        await createDashboards({
          dashboards: {
            'my-ideas': {
              type: 'idea',
              where: ["status == 'backlog'"],
            },
          },
        });

        // Edit the dashboard
        await runCLI([
          'dashboard', 'edit', 'my-ideas',
          '--where', "status == 'raw'"
        ], vaultDir);

        // Run it
        const result = await runCLI(['dashboard', 'my-ideas'], vaultDir);

        expect(result.exitCode).toBe(0);
        // Sample Idea has status: raw, Another Idea has status: backlog
        expect(result.stdout).toContain('Sample Idea');
        expect(result.stdout).not.toContain('Another Idea');
      });

      it('should apply updated type filter', async () => {
        // Create a simple dashboard without a where filter that would conflict
        await createDashboards({
          dashboards: {
            'my-ideas': {
              type: 'idea',
            },
          },
        });

        // Edit the dashboard to show tasks instead
        await runCLI([
          'dashboard', 'edit', 'my-ideas',
          '--type', 'task'
        ], vaultDir);

        // Run it
        const result = await runCLI(['dashboard', 'my-ideas'], vaultDir);

        expect(result.exitCode).toBe(0);
        // Should now show tasks, not ideas
        expect(result.stdout).toContain('Sample Task');
        expect(result.stdout).not.toContain('Sample Idea');
      });
    });
  });

  // ============================================================================
  // --set-default flag tests
  // ============================================================================

  describe('--set-default flag', () => {
    // Helper to get default dashboard from config
    async function getDefaultDashboard(): Promise<string | undefined> {
      const schemaPath = join(vaultDir, '.bwrb', 'schema.json');
      const schemaContent = await readFile(schemaPath, 'utf-8');
      const schema = JSON.parse(schemaContent);
      return schema.config?.default_dashboard;
    }

    // Helper to clear default dashboard
    async function clearDefaultDashboard(): Promise<void> {
      const schemaPath = join(vaultDir, '.bwrb', 'schema.json');
      const schemaContent = await readFile(schemaPath, 'utf-8');
      const schema = JSON.parse(schemaContent);
      if (schema.config?.default_dashboard) {
        delete schema.config.default_dashboard;
        await writeFile(schemaPath, JSON.stringify(schema, null, 2));
      }
    }

    afterEach(async () => {
      await removeDashboards();
      await clearDefaultDashboard();
    });

    describe('dashboard new --set-default', () => {
      it('should set dashboard as default when created with --set-default', async () => {
        const result = await runCLI([
          'dashboard', 'new', 'my-tasks',
          '--type', 'task',
          '--set-default'
        ], vaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Created dashboard: my-tasks');
        expect(result.stdout).toContain('Set "my-tasks" as default dashboard');

        // Verify the default was set
        const defaultDashboard = await getDefaultDashboard();
        expect(defaultDashboard).toBe('my-tasks');
      });

      it('should work with --set-default and --json', async () => {
        const result = await runCLI([
          'dashboard', 'new', 'json-dashboard',
          '--json', '{"type":"idea"}',
          '--set-default'
        ], vaultDir);

        expect(result.exitCode).toBe(0);
        const json = JSON.parse(result.stdout);
        expect(json.success).toBe(true);
        expect(json.message).toContain('set as default');
        expect(json.data.isDefault).toBe(true);

        // Verify the default was set
        const defaultDashboard = await getDefaultDashboard();
        expect(defaultDashboard).toBe('json-dashboard');
      });

      it('should create dashboard without setting default when --set-default is not used', async () => {
        const result = await runCLI([
          'dashboard', 'new', 'regular-dashboard',
          '--type', 'task'
        ], vaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Created dashboard: regular-dashboard');
        expect(result.stdout).not.toContain('as default');

        // Verify no default was set
        const defaultDashboard = await getDefaultDashboard();
        expect(defaultDashboard).toBeUndefined();
      });

      it('should run the newly set default dashboard', async () => {
        // Create and set default
        await runCLI([
          'dashboard', 'new', 'idea-dashboard',
          '--type', 'idea',
          '--set-default'
        ], vaultDir);

        // Run dashboard command without arguments
        const result = await runCLI(['dashboard'], vaultDir);

        expect(result.exitCode).toBe(0);
        // Should show ideas (the default dashboard filters by type: idea)
        expect(result.stdout).toContain('Sample Idea');
        expect(result.stdout).toContain('Another Idea');
      });
    });

    describe('dashboard edit --set-default', () => {
      beforeEach(async () => {
        await createDashboards({
          dashboards: {
            'existing-dashboard': { type: 'task' },
            'other-dashboard': { type: 'idea' },
          },
        });
      });

      it('should set dashboard as default when edited with --set-default', async () => {
        const result = await runCLI([
          'dashboard', 'edit', 'existing-dashboard',
          '--set-default'
        ], vaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Set "existing-dashboard" as default dashboard');

        // Verify the default was set
        const defaultDashboard = await getDefaultDashboard();
        expect(defaultDashboard).toBe('existing-dashboard');
      });

      it('should set default along with other edits', async () => {
        const result = await runCLI([
          'dashboard', 'edit', 'existing-dashboard',
          '--type', 'idea',
          '--set-default'
        ], vaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Updated dashboard: existing-dashboard');
        expect(result.stdout).toContain('Set "existing-dashboard" as default dashboard');

        // Verify both changes
        const defaultDashboard = await getDefaultDashboard();
        expect(defaultDashboard).toBe('existing-dashboard');

        const dashboards = await readDashboards();
        expect(dashboards.dashboards['existing-dashboard']!.type).toBe('idea');
      });

      it('should work with --set-default and --json', async () => {
        const result = await runCLI([
          'dashboard', 'edit', 'existing-dashboard',
          '--json', '{"type":"objective"}',
          '--set-default'
        ], vaultDir);

        expect(result.exitCode).toBe(0);
        const json = JSON.parse(result.stdout);
        expect(json.success).toBe(true);
        expect(json.message).toContain('set as default');
        expect(json.data.isDefault).toBe(true);

        // Verify the default was set
        const defaultDashboard = await getDefaultDashboard();
        expect(defaultDashboard).toBe('existing-dashboard');
      });

      it('should replace existing default when using --set-default', async () => {
        // Set initial default
        const schemaPath = join(vaultDir, '.bwrb', 'schema.json');
        const schemaContent = await readFile(schemaPath, 'utf-8');
        const schema = JSON.parse(schemaContent);
        schema.config = { ...schema.config, default_dashboard: 'other-dashboard' };
        await writeFile(schemaPath, JSON.stringify(schema, null, 2));

        // Edit different dashboard with --set-default
        const result = await runCLI([
          'dashboard', 'edit', 'existing-dashboard',
          '--set-default'
        ], vaultDir);

        expect(result.exitCode).toBe(0);

        // Verify the default was changed
        const defaultDashboard = await getDefaultDashboard();
        expect(defaultDashboard).toBe('existing-dashboard');
      });
    });

    describe('help text includes --set-default', () => {
      it('should show --set-default in dashboard new help', async () => {
        const result = await runCLI(['dashboard', 'new', '--help'], vaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('--set-default');
        expect(result.stdout).toContain('Set this dashboard as the default');
      });

      it('should show --set-default in dashboard edit help', async () => {
        const result = await runCLI(['dashboard', 'edit', '--help'], vaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('--set-default');
        expect(result.stdout).toContain('Set this dashboard as the default');
      });
    });
  });

  // ============================================================================
  // dashboard delete
  // ============================================================================

  describe('dashboard delete', () => {
    beforeEach(async () => {
      // Set up test dashboards
      await createDashboards({
        dashboards: {
          'to-delete': {
            type: 'idea',
          },
          'keep-this': {
            type: 'task',
            where: ["status == 'active'"],
          },
          'another-one': {
            type: 'idea',
            output: 'paths',
          },
        },
      });
    });

    afterEach(async () => {
      await removeDashboards();
      // Clean up default_dashboard in schema if set
      try {
        const schemaPath = join(vaultDir, '.bwrb', 'schema.json');
        const schemaContent = await readFile(schemaPath, 'utf-8');
        const schema = JSON.parse(schemaContent);
        if (schema.config?.default_dashboard) {
          delete schema.config.default_dashboard;
          await writeFile(schemaPath, JSON.stringify(schema, null, 2));
        }
      } catch {
        // Ignore errors
      }
    });

    describe('with --force flag', () => {
      it('should delete dashboard with --force', async () => {
        const result = await runCLI(['dashboard', 'delete', 'to-delete', '--force'], vaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Deleted');
        expect(result.stdout).toContain('to-delete');

        // Verify dashboard was removed
        const dashboards = await readDashboards();
        expect(dashboards.dashboards['to-delete']).toBeUndefined();
        expect(dashboards.dashboards['keep-this']).toBeDefined();
        expect(dashboards.dashboards['another-one']).toBeDefined();
      });

      it('should preserve other dashboards', async () => {
        await runCLI(['dashboard', 'delete', 'to-delete', '--force'], vaultDir);

        const dashboards = await readDashboards();
        expect(Object.keys(dashboards.dashboards)).toHaveLength(2);
        expect(dashboards.dashboards['keep-this']).toEqual({
          type: 'task',
          where: ["status == 'active'"],
        });
        expect(dashboards.dashboards['another-one']).toEqual({
          type: 'idea',
          output: 'paths',
        });
      });
    });

    describe('error handling', () => {
      it('should error when dashboard does not exist', async () => {
        const result = await runCLI(['dashboard', 'delete', 'nonexistent', '--force'], vaultDir);

        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain('does not exist');
      });

      it('should require --force in JSON mode', async () => {
        const result = await runCLI(['dashboard', 'delete', 'to-delete', '--output', 'json'], vaultDir);

        expect(result.exitCode).not.toBe(0);
        const json = JSON.parse(result.stdout);
        expect(json.success).toBe(false);
        expect(json.error).toContain('--force');
      });
    });

    describe('JSON mode', () => {
      it('should return success JSON when deleting', async () => {
        const result = await runCLI(
          ['dashboard', 'delete', 'to-delete', '--force', '--output', 'json'],
          vaultDir
        );

        expect(result.exitCode).toBe(0);
        const json = JSON.parse(result.stdout);
        expect(json.success).toBe(true);
        expect(json.message).toContain('deleted');
        expect(json.data.name).toBe('to-delete');
        expect(json.data.wasDefault).toBe(false);
      });

      it('should return error JSON when dashboard does not exist', async () => {
        const result = await runCLI(
          ['dashboard', 'delete', 'nonexistent', '--force', '--output', 'json'],
          vaultDir
        );

        expect(result.exitCode).not.toBe(0);
        const json = JSON.parse(result.stdout);
        expect(json.success).toBe(false);
        expect(json.error).toContain('does not exist');
      });

      it('should require name in JSON mode', async () => {
        const result = await runCLI(
          ['dashboard', 'delete', '--force', '--output', 'json'],
          vaultDir
        );

        expect(result.exitCode).not.toBe(0);
        const json = JSON.parse(result.stdout);
        expect(json.success).toBe(false);
        expect(json.error).toContain('required');
      });
    });

    describe('default dashboard handling', () => {
      it('should clear default when deleting default dashboard', async () => {
        // Set 'to-delete' as the default dashboard
        const schemaPath = join(vaultDir, '.bwrb', 'schema.json');
        const schemaContent = await readFile(schemaPath, 'utf-8');
        const schema = JSON.parse(schemaContent);
        schema.config = { ...schema.config, default_dashboard: 'to-delete' };
        await writeFile(schemaPath, JSON.stringify(schema, null, 2));

        const result = await runCLI(
          ['dashboard', 'delete', 'to-delete', '--force'],
          vaultDir
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('Deleted');
        expect(result.stdout).toContain('default');

        // Verify default was cleared
        const updatedSchemaContent = await readFile(schemaPath, 'utf-8');
        const updatedSchema = JSON.parse(updatedSchemaContent);
        expect(updatedSchema.config.default_dashboard).toBeUndefined();
      });

      it('should indicate wasDefault in JSON when deleting default', async () => {
        // Set 'to-delete' as the default dashboard
        const schemaPath = join(vaultDir, '.bwrb', 'schema.json');
        const schemaContent = await readFile(schemaPath, 'utf-8');
        const schema = JSON.parse(schemaContent);
        schema.config = { ...schema.config, default_dashboard: 'to-delete' };
        await writeFile(schemaPath, JSON.stringify(schema, null, 2));

        const result = await runCLI(
          ['dashboard', 'delete', 'to-delete', '--force', '--output', 'json'],
          vaultDir
        );

        expect(result.exitCode).toBe(0);
        const json = JSON.parse(result.stdout);
        expect(json.success).toBe(true);
        expect(json.data.wasDefault).toBe(true);
      });

      it('should not affect default when deleting non-default dashboard', async () => {
        // Set 'keep-this' as the default dashboard
        const schemaPath = join(vaultDir, '.bwrb', 'schema.json');
        const schemaContent = await readFile(schemaPath, 'utf-8');
        const schema = JSON.parse(schemaContent);
        schema.config = { ...schema.config, default_dashboard: 'keep-this' };
        await writeFile(schemaPath, JSON.stringify(schema, null, 2));

        // Delete a different dashboard
        await runCLI(['dashboard', 'delete', 'to-delete', '--force'], vaultDir);

        // Verify default is still 'keep-this'
        const updatedSchemaContent = await readFile(schemaPath, 'utf-8');
        const updatedSchema = JSON.parse(updatedSchemaContent);
        expect(updatedSchema.config.default_dashboard).toBe('keep-this');
      });
    });

    describe('help text', () => {
      it('should show delete in dashboard help', async () => {
        const result = await runCLI(['dashboard', '--help'], vaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('delete');
        expect(result.stdout).not.toContain('coming soon');
      });

      it('should show --force in delete help', async () => {
        const result = await runCLI(['dashboard', 'delete', '--help'], vaultDir);

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('--force');
        expect(result.stdout).toContain('Skip confirmation');
      });
    });
  });
});
