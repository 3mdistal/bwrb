import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdir, writeFile, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { mkdtemp } from 'fs/promises';
import { existsSync } from 'fs';
import {
  getDashboardsPath,
  loadDashboards,
  saveDashboards,
  getDashboard,
  listDashboards,
  createDashboard,
  updateDashboard,
  deleteDashboard,
} from '../../../src/lib/dashboard.js';
import type { DashboardDefinition, DashboardsFile } from '../../../src/types/schema.js';

describe('dashboard library', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'dashboard-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('getDashboardsPath', () => {
    it('returns correct path for vault directory', () => {
      const result = getDashboardsPath('/vault');
      expect(result).toBe('/vault/.bwrb/dashboards.json');
    });

    it('handles nested vault paths', () => {
      const result = getDashboardsPath('/path/to/my/vault');
      expect(result).toBe('/path/to/my/vault/.bwrb/dashboards.json');
    });
  });

  describe('loadDashboards', () => {
    it('returns empty object when file does not exist', async () => {
      const result = await loadDashboards(tempDir);
      expect(result).toEqual({ dashboards: {} });
    });

    it('loads and parses valid dashboards.json', async () => {
      await mkdir(join(tempDir, '.bwrb'), { recursive: true });
      const dashboards: DashboardsFile = {
        dashboards: {
          'my-tasks': {
            type: 'task',
            where: ["status == 'active'"],
            output: 'tree',
          },
          inbox: {
            type: 'idea',
            where: ["status == 'raw'"],
          },
        },
      };
      await writeFile(
        join(tempDir, '.bwrb', 'dashboards.json'),
        JSON.stringify(dashboards, null, 2)
      );

      const result = await loadDashboards(tempDir);

      expect(result.dashboards['my-tasks']).toEqual({
        type: 'task',
        where: ["status == 'active'"],
        output: 'tree',
      });
      expect(result.dashboards['inbox']).toEqual({
        type: 'idea',
        where: ["status == 'raw'"],
      });
    });

    it('throws on invalid JSON', async () => {
      await mkdir(join(tempDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempDir, '.bwrb', 'dashboards.json'),
        'not valid json {'
      );

      await expect(loadDashboards(tempDir)).rejects.toThrow();
    });

    it('throws on schema validation failure', async () => {
      await mkdir(join(tempDir, '.bwrb'), { recursive: true });
      // Invalid: output must be one of the allowed values
      await writeFile(
        join(tempDir, '.bwrb', 'dashboards.json'),
        JSON.stringify({
          dashboards: {
            bad: { output: 'invalid-format' },
          },
        })
      );

      await expect(loadDashboards(tempDir)).rejects.toThrow();
    });

    it('accepts dashboard with all optional fields', async () => {
      await mkdir(join(tempDir, '.bwrb'), { recursive: true });
      const dashboards: DashboardsFile = {
        dashboards: {
          'full-dashboard': {
            type: 'task',
            path: 'Projects/**',
            where: ["status == 'active'", "priority == 'high'"],
            body: 'urgent',
            output: 'json',
            fields: ['name', 'status', 'deadline'],
          },
        },
      };
      await writeFile(
        join(tempDir, '.bwrb', 'dashboards.json'),
        JSON.stringify(dashboards, null, 2)
      );

      const result = await loadDashboards(tempDir);

      expect(result.dashboards['full-dashboard']).toEqual({
        type: 'task',
        path: 'Projects/**',
        where: ["status == 'active'", "priority == 'high'"],
        body: 'urgent',
        output: 'json',
        fields: ['name', 'status', 'deadline'],
      });
    });

    it('accepts empty dashboard definition', async () => {
      await mkdir(join(tempDir, '.bwrb'), { recursive: true });
      const dashboards: DashboardsFile = {
        dashboards: {
          'empty-dashboard': {},
        },
      };
      await writeFile(
        join(tempDir, '.bwrb', 'dashboards.json'),
        JSON.stringify(dashboards, null, 2)
      );

      const result = await loadDashboards(tempDir);

      expect(result.dashboards['empty-dashboard']).toEqual({});
    });
  });

  describe('saveDashboards', () => {
    it('creates file if it does not exist', async () => {
      const dashboards: DashboardsFile = {
        dashboards: {
          test: { type: 'task' },
        },
      };

      await saveDashboards(tempDir, dashboards);

      expect(existsSync(join(tempDir, '.bwrb', 'dashboards.json'))).toBe(true);
    });

    it('creates .bwrb directory if needed', async () => {
      expect(existsSync(join(tempDir, '.bwrb'))).toBe(false);

      await saveDashboards(tempDir, { dashboards: {} });

      expect(existsSync(join(tempDir, '.bwrb'))).toBe(true);
    });

    it('overwrites existing file', async () => {
      await mkdir(join(tempDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempDir, '.bwrb', 'dashboards.json'),
        JSON.stringify({ dashboards: { old: { type: 'idea' } } })
      );

      await saveDashboards(tempDir, {
        dashboards: { new: { type: 'task' } },
      });

      const content = await readFile(
        join(tempDir, '.bwrb', 'dashboards.json'),
        'utf-8'
      );
      const parsed = JSON.parse(content);
      expect(parsed.dashboards['new']).toBeDefined();
      expect(parsed.dashboards['old']).toBeUndefined();
    });

    it('validates before writing', async () => {
      // This should throw because output is invalid
      const invalid = {
        dashboards: {
          bad: { output: 'not-a-valid-format' },
        },
      } as unknown as DashboardsFile;

      await expect(saveDashboards(tempDir, invalid)).rejects.toThrow();
      expect(existsSync(join(tempDir, '.bwrb', 'dashboards.json'))).toBe(false);
    });

    it('writes formatted JSON with trailing newline', async () => {
      await saveDashboards(tempDir, {
        dashboards: { test: { type: 'task' } },
      });

      const content = await readFile(
        join(tempDir, '.bwrb', 'dashboards.json'),
        'utf-8'
      );
      expect(content).toContain('\n');
      expect(content.endsWith('\n')).toBe(true);
    });
  });

  describe('getDashboard', () => {
    it('returns dashboard definition when exists', async () => {
      await mkdir(join(tempDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempDir, '.bwrb', 'dashboards.json'),
        JSON.stringify({
          dashboards: {
            'my-query': { type: 'task', output: 'tree' },
          },
        })
      );

      const result = await getDashboard(tempDir, 'my-query');

      expect(result).toEqual({ type: 'task', output: 'tree' });
    });

    it('returns null when dashboard not found', async () => {
      await mkdir(join(tempDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempDir, '.bwrb', 'dashboards.json'),
        JSON.stringify({ dashboards: {} })
      );

      const result = await getDashboard(tempDir, 'nonexistent');

      expect(result).toBeNull();
    });

    it('returns null when file does not exist', async () => {
      const result = await getDashboard(tempDir, 'any-name');

      expect(result).toBeNull();
    });
  });

  describe('listDashboards', () => {
    it('returns empty array when no dashboards', async () => {
      const result = await listDashboards(tempDir);

      expect(result).toEqual([]);
    });

    it('returns all dashboard names', async () => {
      await mkdir(join(tempDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempDir, '.bwrb', 'dashboards.json'),
        JSON.stringify({
          dashboards: {
            zebra: { type: 'task' },
            alpha: { type: 'idea' },
            beta: {},
          },
        })
      );

      const result = await listDashboards(tempDir);

      expect(result).toContain('alpha');
      expect(result).toContain('beta');
      expect(result).toContain('zebra');
    });

    it('returns names sorted alphabetically', async () => {
      await mkdir(join(tempDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempDir, '.bwrb', 'dashboards.json'),
        JSON.stringify({
          dashboards: {
            zebra: {},
            alpha: {},
            middle: {},
          },
        })
      );

      const result = await listDashboards(tempDir);

      expect(result).toEqual(['alpha', 'middle', 'zebra']);
    });
  });

  describe('createDashboard', () => {
    it('creates new dashboard successfully', async () => {
      const definition: DashboardDefinition = {
        type: 'task',
        where: ["status == 'active'"],
      };

      await createDashboard(tempDir, 'new-dashboard', definition);

      const result = await getDashboard(tempDir, 'new-dashboard');
      expect(result).toEqual(definition);
    });

    it('creates file on first save', async () => {
      expect(existsSync(join(tempDir, '.bwrb', 'dashboards.json'))).toBe(false);

      await createDashboard(tempDir, 'first', { type: 'task' });

      expect(existsSync(join(tempDir, '.bwrb', 'dashboards.json'))).toBe(true);
    });

    it('throws if dashboard already exists', async () => {
      await mkdir(join(tempDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempDir, '.bwrb', 'dashboards.json'),
        JSON.stringify({
          dashboards: { existing: { type: 'task' } },
        })
      );

      await expect(
        createDashboard(tempDir, 'existing', { type: 'idea' })
      ).rejects.toThrow('Dashboard "existing" already exists');
    });

    it('preserves existing dashboards when adding new', async () => {
      await mkdir(join(tempDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempDir, '.bwrb', 'dashboards.json'),
        JSON.stringify({
          dashboards: { existing: { type: 'task' } },
        })
      );

      await createDashboard(tempDir, 'new', { type: 'idea' });

      const all = await listDashboards(tempDir);
      expect(all).toContain('existing');
      expect(all).toContain('new');
    });
  });

  describe('updateDashboard', () => {
    it('updates existing dashboard', async () => {
      await mkdir(join(tempDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempDir, '.bwrb', 'dashboards.json'),
        JSON.stringify({
          dashboards: { target: { type: 'task', output: 'default' } },
        })
      );

      await updateDashboard(tempDir, 'target', {
        type: 'task',
        output: 'tree',
        where: ["status == 'active'"],
      });

      const result = await getDashboard(tempDir, 'target');
      expect(result).toEqual({
        type: 'task',
        output: 'tree',
        where: ["status == 'active'"],
      });
    });

    it('throws if dashboard does not exist', async () => {
      await expect(
        updateDashboard(tempDir, 'nonexistent', { type: 'task' })
      ).rejects.toThrow('Dashboard "nonexistent" does not exist');
    });

    it('preserves other dashboards when updating', async () => {
      await mkdir(join(tempDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempDir, '.bwrb', 'dashboards.json'),
        JSON.stringify({
          dashboards: {
            target: { type: 'task' },
            other: { type: 'idea' },
          },
        })
      );

      await updateDashboard(tempDir, 'target', { type: 'milestone' });

      const other = await getDashboard(tempDir, 'other');
      expect(other).toEqual({ type: 'idea' });
    });
  });

  describe('deleteDashboard', () => {
    it('removes dashboard', async () => {
      await mkdir(join(tempDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempDir, '.bwrb', 'dashboards.json'),
        JSON.stringify({
          dashboards: { target: { type: 'task' } },
        })
      );

      await deleteDashboard(tempDir, 'target');

      const result = await getDashboard(tempDir, 'target');
      expect(result).toBeNull();
    });

    it('throws if dashboard does not exist', async () => {
      await expect(deleteDashboard(tempDir, 'nonexistent')).rejects.toThrow(
        'Dashboard "nonexistent" does not exist'
      );
    });

    it('preserves other dashboards when deleting', async () => {
      await mkdir(join(tempDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(tempDir, '.bwrb', 'dashboards.json'),
        JSON.stringify({
          dashboards: {
            target: { type: 'task' },
            keep: { type: 'idea' },
          },
        })
      );

      await deleteDashboard(tempDir, 'target');

      const kept = await getDashboard(tempDir, 'keep');
      expect(kept).toEqual({ type: 'idea' });
    });
  });
});
