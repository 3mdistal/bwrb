import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { LoadedSchema } from '../../../src/types/schema.js';
import {
  detectPositionalType,
  parsePositionalArg,
  checkDeprecatedFilters,
  getTypePositionalDeprecationWarning,
  filterByPath,
  resolveTargets,
  validateDestructiveTargeting,
  validateReadOnlyTargeting,
  formatTargetingSummary,
  hasAnyTargeting,
} from '../../../src/lib/targeting.js';
import type { ManagedFile } from '../../../src/lib/discovery.js';
import { loadSchema } from '../../../src/lib/schema.js';
import { createTestVault, cleanupTestVault } from '../fixtures/setup.js';

describe('targeting', () => {
  let vaultDir: string;
  let schema: LoadedSchema;

  beforeEach(async () => {
    vaultDir = await createTestVault();
    schema = await loadSchema(vaultDir);
  });

  afterEach(async () => {
    await cleanupTestVault(vaultDir);
  });

  describe('detectPositionalType', () => {
    it('detects path patterns with /', () => {
      expect(detectPositionalType('Projects/Tasks', schema)).toBe('path');
      expect(detectPositionalType('Ideas/', schema)).toBe('path');
    });

    it('detects path patterns with glob *', () => {
      expect(detectPositionalType('*.md', schema)).toBe('path');
      expect(detectPositionalType('**/*.md', schema)).toBe('path');
      expect(detectPositionalType('Projects/*', schema)).toBe('path');
    });

    it('detects where expressions with operators', () => {
      expect(detectPositionalType('status=active', schema)).toBe('where');
      expect(detectPositionalType('priority!=low', schema)).toBe('where');
      expect(detectPositionalType('count>5', schema)).toBe('where');
      expect(detectPositionalType('date<2024-01-01', schema)).toBe('where');
      expect(detectPositionalType('name~pattern', schema)).toBe('where');
    });

    it('detects known type names', () => {
      expect(detectPositionalType('task', schema)).toBe('type');
      expect(detectPositionalType('idea', schema)).toBe('type');
      expect(detectPositionalType('milestone', schema)).toBe('type');
    });

    it('returns null for ambiguous arguments', () => {
      expect(detectPositionalType('unknown', schema)).toBeNull();
      expect(detectPositionalType('project', schema)).toBeNull();
    });
  });

  describe('parsePositionalArg', () => {
    it('parses type positional', () => {
      const result = parsePositionalArg('task', schema, {});
      expect(result.error).toBeUndefined();
      expect(result.options.type).toBe('task');
    });

    it('parses path positional', () => {
      const result = parsePositionalArg('Projects/**', schema, {});
      expect(result.error).toBeUndefined();
      expect(result.options.path).toBe('Projects/**');
    });

    it('parses where positional', () => {
      const result = parsePositionalArg('status=active', schema, {});
      expect(result.error).toBeUndefined();
      expect(result.options.where).toEqual(['status=active']);
    });

    it('appends to existing where expressions', () => {
      const result = parsePositionalArg('priority=high', schema, {
        where: ['status=active'],
      });
      expect(result.error).toBeUndefined();
      expect(result.options.where).toEqual(['status=active', 'priority=high']);
    });

    it('errors on duplicate type', () => {
      const result = parsePositionalArg('idea', schema, { type: 'task' });
      expect(result.error).toContain('Type already specified');
    });

    it('errors on duplicate path', () => {
      const result = parsePositionalArg('Ideas/**', schema, { path: 'Tasks/**' });
      expect(result.error).toContain('Path already specified');
    });

    it('errors on ambiguous argument with helpful message', () => {
      const result = parsePositionalArg('unknown', schema, {});
      expect(result.error).toContain('Ambiguous argument');
      expect(result.error).toContain('--type=unknown');
      expect(result.error).toContain('--path=');
      expect(result.error).toContain('--where=');
      expect(result.error).toContain('Known types:');
    });
  });

  describe('checkDeprecatedFilters', () => {
    it('detects simple filter flags', () => {
      const result = checkDeprecatedFilters(['--status=active', '--priority=high']);
      expect(result.filters).toHaveLength(2);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('Deprecation warning');
      expect(result.warnings[0]).toContain('--where');
    });

    it('returns empty for non-filter args', () => {
      const result = checkDeprecatedFilters(['--type', 'task', '--path', 'Projects/**']);
      expect(result.filters).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });
  });

  describe('getTypePositionalDeprecationWarning', () => {
    it('generates correct warning message', () => {
      const warning = getTypePositionalDeprecationWarning('task');
      expect(warning).toContain('Deprecation warning');
      expect(warning).toContain('--type task');
    });
  });

  describe('filterByPath', () => {
    const mockFiles: ManagedFile[] = [
      { path: '/vault/Objectives/Tasks/Sample Task.md', relativePath: 'Objectives/Tasks/Sample Task.md' },
      { path: '/vault/Ideas/Sample Idea.md', relativePath: 'Ideas/Sample Idea.md' },
      { path: '/vault/Ideas/Another Idea.md', relativePath: 'Ideas/Another Idea.md' },
      { path: '/vault/Objectives/Milestones/Active Milestone.md', relativePath: 'Objectives/Milestones/Active Milestone.md' },
    ];

    it('filters by exact directory path', () => {
      const result = filterByPath(mockFiles, 'Ideas');
      expect(result).toHaveLength(2);
      expect(result.every(f => f.relativePath.startsWith('Ideas/'))).toBe(true);
    });

    it('filters by glob pattern', () => {
      const result = filterByPath(mockFiles, 'Objectives/**');
      expect(result).toHaveLength(2);
      expect(result.every(f => f.relativePath.startsWith('Objectives/'))).toBe(true);
    });

    it('filters by nested path', () => {
      const result = filterByPath(mockFiles, 'Objectives/Tasks');
      expect(result).toHaveLength(1);
      expect(result[0].relativePath).toContain('Sample Task');
    });

    it('is case-insensitive', () => {
      const result = filterByPath(mockFiles, 'ideas');
      expect(result).toHaveLength(2);
    });
  });

  describe('validateDestructiveTargeting', () => {
    it('fails without any targeting', () => {
      const result = validateDestructiveTargeting({});
      expect(result.valid).toBe(false);
      expect(result.error).toContain('require explicit targeting');
    });

    it('passes with --type', () => {
      const result = validateDestructiveTargeting({ type: 'task' });
      expect(result.valid).toBe(true);
    });

    it('passes with --path', () => {
      const result = validateDestructiveTargeting({ path: 'Projects/**' });
      expect(result.valid).toBe(true);
    });

    it('passes with --where', () => {
      const result = validateDestructiveTargeting({ where: ['status=active'] });
      expect(result.valid).toBe(true);
    });

    it('passes with --body', () => {
      const result = validateDestructiveTargeting({ body: 'TODO' });
      expect(result.valid).toBe(true);
    });

    it('passes with --all', () => {
      const result = validateDestructiveTargeting({ all: true });
      expect(result.valid).toBe(true);
    });
  });

  describe('validateReadOnlyTargeting', () => {
    it('always passes', () => {
      expect(validateReadOnlyTargeting({}).valid).toBe(true);
      expect(validateReadOnlyTargeting({ type: 'task' }).valid).toBe(true);
    });
  });

  describe('formatTargetingSummary', () => {
    it('formats single selector', () => {
      expect(formatTargetingSummary({ type: 'task' })).toBe('type=task');
      expect(formatTargetingSummary({ path: 'Projects/**' })).toBe('path=Projects/**');
      expect(formatTargetingSummary({ body: 'TODO' })).toBe('body="TODO"');
    });

    it('formats --all', () => {
      expect(formatTargetingSummary({ all: true })).toBe('all notes');
    });

    it('formats multiple selectors with AND', () => {
      const summary = formatTargetingSummary({
        type: 'task',
        where: ['status=active', 'priority=high'],
      });
      expect(summary).toContain('type=task');
      expect(summary).toContain('AND');
      expect(summary).toContain('where=(status=active AND priority=high)');
    });

    it('formats empty options', () => {
      expect(formatTargetingSummary({})).toBe('all notes (no filters)');
    });
  });

  describe('hasAnyTargeting', () => {
    it('returns false for empty options', () => {
      expect(hasAnyTargeting({})).toBe(false);
    });

    it('returns true for any selector', () => {
      expect(hasAnyTargeting({ type: 'task' })).toBe(true);
      expect(hasAnyTargeting({ path: '**' })).toBe(true);
      expect(hasAnyTargeting({ where: ['status=active'] })).toBe(true);
      expect(hasAnyTargeting({ body: 'TODO' })).toBe(true);
      expect(hasAnyTargeting({ all: true })).toBe(true);
    });
  });

  describe('resolveTargets', () => {
    it('resolves targets by type', async () => {
      const result = await resolveTargets(
        { type: 'idea' },
        schema,
        vaultDir
      );

      expect(result.hasTargeting).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.files.length).toBeGreaterThan(0);
      expect(result.files.every(f => f.relativePath.startsWith('Ideas/'))).toBe(true);
    });

    it('resolves targets by path', async () => {
      const result = await resolveTargets(
        { path: 'Ideas' },
        schema,
        vaultDir
      );

      expect(result.hasTargeting).toBe(true);
      expect(result.files.length).toBeGreaterThan(0);
      expect(result.files.every(f => f.relativePath.startsWith('Ideas/'))).toBe(true);
    });

    it('composes type and path with AND', async () => {
      const result = await resolveTargets(
        { type: 'milestone', path: 'Objectives/Milestones' },
        schema,
        vaultDir
      );

      expect(result.hasTargeting).toBe(true);
      expect(result.files.length).toBeGreaterThan(0);
    });

    it('resolves targets with where filter', async () => {
      const result = await resolveTargets(
        { type: 'milestone', where: ['status=in-flight'] },
        schema,
        vaultDir
      );

      expect(result.hasTargeting).toBe(true);
      // Should only get in-flight milestones (Active Milestone in fixture)
      expect(result.files.every(f => f.frontmatter.status === 'in-flight')).toBe(true);
    });

    it('returns empty for no matches', async () => {
      const result = await resolveTargets(
        { path: 'NonexistentDir' },
        schema,
        vaultDir
      );

      expect(result.files).toHaveLength(0);
      expect(result.hasTargeting).toBe(true);
    });

    it('sets hasTargeting=false when no options', async () => {
      const result = await resolveTargets({}, schema, vaultDir);
      expect(result.hasTargeting).toBe(false);
      // Should return all files
      expect(result.files.length).toBeGreaterThan(0);
    });
  });
});
