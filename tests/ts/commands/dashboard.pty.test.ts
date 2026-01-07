import { describe, it, expect, afterEach } from 'vitest';
import { readFile, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import {
  withTempVault,
  shouldSkipPtyTests,
  killAllPtyProcesses,
} from '../lib/pty-helpers.js';
import { TEST_SCHEMA } from '../fixtures/setup.js';
import type { DashboardsFile } from '../../../src/types/schema.js';

const describePty = shouldSkipPtyTests() ? describe.skip : describe;

describePty('dashboard new PTY tests', () => {
  afterEach(() => {
    killAllPtyProcesses();
  });

  describe('interactive mode', () => {
    it('should create dashboard interactively with type selection', async () => {
      await withTempVault(
        ['dashboard', 'new', 'my-ideas'],
        async (proc, vaultPath) => {
          // Type selection prompt
          await proc.waitFor('Filter by type:', 10000);
          // Wait for 'idea' to appear in the list
          await proc.waitFor('idea', 5000);
          // Select idea (first real type after '(all types)')
          proc.write('2');
          
          // Where expressions prompt
          await proc.waitFor('Where expressions', 5000);
          await proc.typeAndEnter("status == 'raw'");
          
          // Body content search
          await proc.waitFor('Body content search', 5000);
          await proc.typeAndEnter(''); // Skip
          
          // Path filter
          await proc.waitFor('Path filter', 5000);
          await proc.typeAndEnter(''); // Skip
          
          // Output format
          await proc.waitFor('Default output format:', 5000);
          proc.write('1'); // Select '(default)'
          
          // Fields
          await proc.waitFor('Display fields', 5000);
          await proc.typeAndEnter('status,priority');
          
          // Wait for creation
          await proc.waitFor('Created dashboard:', 5000);
          
          // Verify dashboard was created
          const dashboardsPath = join(vaultPath, '.bwrb', 'dashboards.json');
          const content = await readFile(dashboardsPath, 'utf-8');
          const dashboards = JSON.parse(content) as DashboardsFile;
          
          expect(dashboards.dashboards['my-ideas']).toBeDefined();
          expect(dashboards.dashboards['my-ideas']!.type).toBe('idea');
          expect(dashboards.dashboards['my-ideas']!.where).toEqual(["status == 'raw'"]);
          expect(dashboards.dashboards['my-ideas']!.fields).toEqual(['status', 'priority']);
        },
        { schema: TEST_SCHEMA }
      );
    }, 30000);

    it('should skip all optional fields when pressing Enter', async () => {
      await withTempVault(
        ['dashboard', 'new', 'minimal-dashboard'],
        async (proc, vaultPath) => {
          // Type selection - select '(all types)'
          await proc.waitFor('Filter by type:', 10000);
          proc.write('1'); // Select '(all types)'
          
          // Skip all other prompts
          await proc.waitFor('Where expressions', 5000);
          await proc.typeAndEnter('');
          
          await proc.waitFor('Body content search', 5000);
          await proc.typeAndEnter('');
          
          await proc.waitFor('Path filter', 5000);
          await proc.typeAndEnter('');
          
          await proc.waitFor('Default output format:', 5000);
          proc.write('1'); // Select '(default)'
          
          await proc.waitFor('Display fields', 5000);
          await proc.typeAndEnter('');
          
          // Wait for creation
          await proc.waitFor('Created dashboard:', 5000);
          await proc.waitFor('no filters', 5000); // Should show "(no filters - matches all notes)"
          
          // Verify dashboard was created with empty definition
          const dashboardsPath = join(vaultPath, '.bwrb', 'dashboards.json');
          const content = await readFile(dashboardsPath, 'utf-8');
          const dashboards = JSON.parse(content) as DashboardsFile;
          
          expect(dashboards.dashboards['minimal-dashboard']).toBeDefined();
          // Should be an empty object since all options were skipped
          const definition = dashboards.dashboards['minimal-dashboard']!;
          expect(definition.type).toBeUndefined();
          expect(definition.where).toBeUndefined();
          expect(definition.output).toBeUndefined();
        },
        { schema: TEST_SCHEMA }
      );
    }, 30000);

    it('should cancel cleanly on Ctrl+C', async () => {
      await withTempVault(
        ['dashboard', 'new', 'cancelled-dashboard'],
        async (proc, vaultPath) => {
          // Wait for first prompt
          await proc.waitFor('Filter by type:', 10000);
          
          // Cancel with Ctrl+C
          proc.write('\x03');
          
          // Should show cancelled message
          await proc.waitFor('Cancelled', 5000);
          
          // Wait for process to exit
          const exitCode = await proc.waitForExit();
          expect(exitCode).toBe(1);
          
          // Verify no dashboard was created
          const dashboardsPath = join(vaultPath, '.bwrb', 'dashboards.json');
          try {
            await readFile(dashboardsPath, 'utf-8');
            // If file exists, make sure it doesn't have our dashboard
            const content = await readFile(dashboardsPath, 'utf-8');
            const dashboards = JSON.parse(content) as DashboardsFile;
            expect(dashboards.dashboards['cancelled-dashboard']).toBeUndefined();
          } catch {
            // File doesn't exist, which is fine
          }
        },
        { schema: TEST_SCHEMA }
      );
    }, 30000);
  });

  describe('error handling', () => {
    it('should error on duplicate dashboard name', async () => {
      await withTempVault(
        ['dashboard', 'new', 'existing', '--type', 'task'],
        async (proc, vaultPath) => {
          // First creation should succeed
          await proc.waitFor('Created dashboard:', 10000);
        },
        { schema: TEST_SCHEMA }
      );

      // Try to create again with same name
      await withTempVault(
        ['dashboard', 'new', 'existing', '--type', 'idea'],
        async (proc, vaultPath) => {
          // Should show error
          await proc.waitFor('already exists', 10000);
          
          const exitCode = await proc.waitForExit();
          expect(exitCode).toBe(1);
        },
        { 
          schema: TEST_SCHEMA,
          files: [{
            path: '.bwrb/dashboards.json',
            content: JSON.stringify({ dashboards: { existing: { type: 'task' } } }, null, 2),
          }],
        }
      );
    }, 30000);
  });
});

describePty('dashboard picker PTY tests', () => {
  afterEach(() => {
    killAllPtyProcesses();
  });

  describe('picker behavior', () => {
    it('should show picker when no name provided and dashboards exist', async () => {
      await withTempVault(
        ['dashboard'],
        async (proc, vaultPath) => {
          // Should show picker prompt
          await proc.waitFor('Select a dashboard:', 10000);
          // Should show dashboard names with type info
          await proc.waitFor('my-tasks (task)', 5000);
          await proc.waitFor('my-ideas (idea)', 5000);
          
          // Select first dashboard (my-ideas, sorted alphabetically)
          proc.write('1');
          
          // Should run the dashboard and show results
          await proc.waitFor('Sample Idea', 10000);
        },
        { 
          schema: TEST_SCHEMA,
          files: [
            {
              path: '.bwrb/dashboards.json',
              content: JSON.stringify({ 
                dashboards: { 
                  'my-tasks': { type: 'task' },
                  'my-ideas': { type: 'idea' },
                }
              }, null, 2),
            },
            {
              path: 'Ideas/Sample Idea.md',
              content: '---\ntype: idea\nstatus: raw\n---\n',
            },
          ],
        }
      );
    }, 30000);

    it('should cancel picker cleanly on Ctrl+C', async () => {
      await withTempVault(
        ['dashboard'],
        async (proc, vaultPath) => {
          // Should show picker prompt
          await proc.waitFor('Select a dashboard:', 10000);
          
          // Cancel with Ctrl+C
          proc.write('\x03');
          
          // Should show cancelled message
          await proc.waitFor('Cancelled', 5000);
          
          // Wait for process to exit
          const exitCode = await proc.waitForExit();
          expect(exitCode).toBe(1);
        },
        { 
          schema: TEST_SCHEMA,
          files: [
            {
              path: '.bwrb/dashboards.json',
              content: JSON.stringify({ 
                dashboards: { 
                  'my-tasks': { type: 'task' },
                }
              }, null, 2),
            },
          ],
        }
      );
    }, 30000);
  });

  describe('default dashboard', () => {
    it('should run default dashboard when configured', async () => {
      const schemaWithDefault = {
        ...TEST_SCHEMA,
        config: { default_dashboard: 'my-ideas' },
      } as typeof TEST_SCHEMA & { config: { default_dashboard: string } };
      
      await withTempVault(
        ['dashboard'],
        async (proc, vaultPath) => {
          // Should run default dashboard immediately without showing picker
          // Should show idea results
          await proc.waitFor('Sample Idea', 10000);
          await proc.waitFor('Another Idea', 5000);
          
          // Should NOT show picker prompt
          const output = proc.getOutput();
          expect(output).not.toContain('Select a dashboard:');
        },
        { 
          schema: schemaWithDefault,
          files: [
            {
              path: '.bwrb/dashboards.json',
              content: JSON.stringify({ 
                dashboards: { 
                  'my-tasks': { type: 'task' },
                  'my-ideas': { type: 'idea' },
                }
              }, null, 2),
            },
            {
              path: 'Ideas/Sample Idea.md',
              content: '---\ntype: idea\nstatus: raw\n---\n',
            },
            {
              path: 'Ideas/Another Idea.md',
              content: '---\ntype: idea\nstatus: backlog\n---\n',
            },
          ],
        }
      );
    }, 30000);

    it('should warn and show picker when default dashboard does not exist', async () => {
      const schemaWithBadDefault = {
        ...TEST_SCHEMA,
        config: { default_dashboard: 'nonexistent' },
      } as typeof TEST_SCHEMA & { config: { default_dashboard: string } };
      
      await withTempVault(
        ['dashboard'],
        async (proc, vaultPath) => {
          // Should show warning about missing default
          await proc.waitFor('Default dashboard "nonexistent" not found', 10000);
          
          // Then should show picker
          await proc.waitFor('Select a dashboard:', 5000);
          
          // Select the only available dashboard
          proc.write('1');
          
          // Wait for exit
          await proc.waitForExit();
        },
        { 
          schema: schemaWithBadDefault,
          files: [
            {
              path: '.bwrb/dashboards.json',
              content: JSON.stringify({ 
                dashboards: { 
                  'my-tasks': { type: 'task' },
                }
              }, null, 2),
            },
          ],
        }
      );
    }, 30000);
  });
});

// ============================================================================
// dashboard edit PTY tests
// ============================================================================

describePty('dashboard edit PTY tests', () => {
  afterEach(() => {
    killAllPtyProcesses();
  });

  describe('interactive mode', () => {
    it('should show current values and allow editing', async () => {
      await withTempVault(
        ['dashboard', 'edit', 'my-tasks'],
        async (proc, vaultPath) => {
          // Should show editing header
          await proc.waitFor('Editing dashboard: my-tasks', 10000);
          
          // Should show current type
          await proc.waitFor('Current type: task', 5000);
          
          // Type selection - select 'idea' (option 2)
          await proc.waitFor('Filter by type:', 5000);
          proc.write('2');
          
          // Where expressions - should show current value
          await proc.waitFor('Current:', 5000);
          await proc.waitFor("status == 'active'", 5000);
          await proc.waitFor('Where expressions', 5000);
          await proc.typeAndEnter("priority == 'high'");
          
          // Body search - press Enter to keep empty
          await proc.waitFor('Body content search', 5000);
          await proc.typeAndEnter('');
          
          // Path filter - press Enter to keep empty
          await proc.waitFor('Path filter', 5000);
          await proc.typeAndEnter('');
          
          // Output format - select 'paths' (option 2)
          await proc.waitFor('Current output: tree', 5000);
          await proc.waitFor('Default output format:', 5000);
          proc.write('2');
          
          // Fields - press Enter to keep empty
          await proc.waitFor('Display fields', 5000);
          await proc.typeAndEnter('');
          
          // Wait for update
          await proc.waitFor('Updated dashboard:', 5000);
          
          // Verify dashboard was updated
          const dashboardsPath = join(vaultPath, '.bwrb', 'dashboards.json');
          const content = await readFile(dashboardsPath, 'utf-8');
          const dashboards = JSON.parse(content) as DashboardsFile;
          
          expect(dashboards.dashboards['my-tasks']!.type).toBe('idea');
          expect(dashboards.dashboards['my-tasks']!.where).toEqual(["priority == 'high'"]);
          expect(dashboards.dashboards['my-tasks']!.output).toBe('paths');
        },
        { 
          schema: TEST_SCHEMA,
          files: [
            {
              path: '.bwrb/dashboards.json',
              content: JSON.stringify({ 
                dashboards: { 
                  'my-tasks': { 
                    type: 'task',
                    where: ["status == 'active'"],
                    output: 'tree',
                  },
                }
              }, null, 2),
            },
          ],
        }
      );
    }, 30000);

    it('should preserve text input values when Enter is pressed with default', async () => {
      await withTempVault(
        ['dashboard', 'edit', 'my-tasks'],
        async (proc, vaultPath) => {
          // Should show editing header
          await proc.waitFor('Editing dashboard: my-tasks', 10000);
          
          // Type selection - select (all types)
          await proc.waitFor('Filter by type:', 5000);
          proc.write('1');
          
          // Where expressions - press Enter to keep current (shown as default)
          await proc.waitFor('Where expressions', 5000);
          await proc.typeAndEnter(''); // Empty clears the value
          
          // Body search - press Enter to keep 'TODO' (shown as default)
          await proc.waitFor('Body content search', 5000);
          await proc.waitFor('TODO', 5000); // Should show current value
          await proc.typeAndEnter(''); // Enter without typing keeps the default
          
          // Path filter - press Enter to keep 'Projects/**'
          await proc.waitFor('Path filter', 5000);
          await proc.waitFor('Projects/**', 5000);
          await proc.typeAndEnter('');
          
          // Output format - select '(default)' (option 1)
          await proc.waitFor('Default output format:', 5000);
          proc.write('1');
          
          // Fields - press Enter
          await proc.waitFor('Display fields', 5000);
          await proc.typeAndEnter('');
          
          // Wait for update
          await proc.waitFor('Updated dashboard:', 5000);
          
          // Verify text input values were preserved
          const dashboardsPath = join(vaultPath, '.bwrb', 'dashboards.json');
          const content = await readFile(dashboardsPath, 'utf-8');
          const dashboards = JSON.parse(content) as DashboardsFile;
          
          // Body and path should be preserved since we pressed Enter with defaults shown
          expect(dashboards.dashboards['my-tasks']!.body).toBe('TODO');
          expect(dashboards.dashboards['my-tasks']!.path).toBe('Projects/**');
        },
        { 
          schema: TEST_SCHEMA,
          files: [
            {
              path: '.bwrb/dashboards.json',
              content: JSON.stringify({ 
                dashboards: { 
                  'my-tasks': { 
                    type: 'task',
                    body: 'TODO',
                    path: 'Projects/**',
                  },
                }
              }, null, 2),
            },
          ],
        }
      );
    }, 30000);

    it('should cancel cleanly on Ctrl+C', async () => {
      await withTempVault(
        ['dashboard', 'edit', 'my-tasks'],
        async (proc, vaultPath) => {
          // Wait for first prompt
          await proc.waitFor('Filter by type:', 10000);
          
          // Cancel with Ctrl+C
          proc.write('\x03');
          
          // Should show cancelled message
          await proc.waitFor('Cancelled', 5000);
          
          // Wait for process to exit
          const exitCode = await proc.waitForExit();
          expect(exitCode).toBe(1);
          
          // Verify dashboard was NOT modified
          const dashboardsPath = join(vaultPath, '.bwrb', 'dashboards.json');
          const content = await readFile(dashboardsPath, 'utf-8');
          const dashboards = JSON.parse(content) as DashboardsFile;
          
          // Original values should be preserved
          expect(dashboards.dashboards['my-tasks']!.type).toBe('task');
          expect(dashboards.dashboards['my-tasks']!.output).toBe('tree');
        },
        { 
          schema: TEST_SCHEMA,
          files: [
            {
              path: '.bwrb/dashboards.json',
              content: JSON.stringify({ 
                dashboards: { 
                  'my-tasks': { 
                    type: 'task',
                    output: 'tree',
                  },
                }
              }, null, 2),
            },
          ],
        }
      );
    }, 30000);
  });

  describe('picker behavior', () => {
    it('should show picker when no name provided', async () => {
      await withTempVault(
        ['dashboard', 'edit'],
        async (proc, vaultPath) => {
          // Should show picker prompt
          await proc.waitFor('Select a dashboard to edit:', 10000);
          // Should show dashboard names with type info
          await proc.waitFor('my-tasks (task)', 5000);
          await proc.waitFor('my-ideas (idea)', 5000);
          
          // Select first dashboard (my-ideas, sorted alphabetically)
          proc.write('1');
          
          // Should start editing that dashboard
          await proc.waitFor('Editing dashboard: my-ideas', 5000);
          
          // Cancel to exit
          proc.write('\x03');
          await proc.waitForExit();
        },
        { 
          schema: TEST_SCHEMA,
          files: [
            {
              path: '.bwrb/dashboards.json',
              content: JSON.stringify({ 
                dashboards: { 
                  'my-tasks': { type: 'task' },
                  'my-ideas': { type: 'idea' },
                }
              }, null, 2),
            },
          ],
        }
      );
    }, 30000);

    it('should cancel picker cleanly on Ctrl+C', async () => {
      await withTempVault(
        ['dashboard', 'edit'],
        async (proc, vaultPath) => {
          // Should show picker prompt
          await proc.waitFor('Select a dashboard to edit:', 10000);
          
          // Cancel with Ctrl+C
          proc.write('\x03');
          
          // Should show cancelled message
          await proc.waitFor('Cancelled', 5000);
          
          // Wait for process to exit
          const exitCode = await proc.waitForExit();
          expect(exitCode).toBe(1);
        },
        { 
          schema: TEST_SCHEMA,
          files: [
            {
              path: '.bwrb/dashboards.json',
              content: JSON.stringify({ 
                dashboards: { 
                  'my-tasks': { type: 'task' },
                }
              }, null, 2),
            },
          ],
        }
      );
    }, 30000);
  });

  describe('error handling', () => {
    it('should error when dashboard does not exist', async () => {
      await withTempVault(
        ['dashboard', 'edit', 'nonexistent'],
        async (proc, vaultPath) => {
          // Should show error
          await proc.waitFor('does not exist', 10000);
          
          const exitCode = await proc.waitForExit();
          expect(exitCode).toBe(1);
        },
        { 
          schema: TEST_SCHEMA,
          files: [
            {
              path: '.bwrb/dashboards.json',
              content: JSON.stringify({ dashboards: {} }, null, 2),
            },
          ],
        }
      );
    }, 30000);
  });
});
