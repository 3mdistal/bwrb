import { describe, it, expect, afterEach } from 'vitest';
import { readFile, rm } from 'fs/promises';
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
