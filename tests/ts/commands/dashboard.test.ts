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
        const result = await runCLI(['dashboard', 'list', '-o', 'json'], vaultDir);

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
});
