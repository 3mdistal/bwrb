import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { runCLI } from '../fixtures/setup.js';

/**
 * `schema discover` is DESCRIPTIVE — it reports frontmatter facts and never
 * passes/fails. These tests exercise both roles (pre-schema onboarding and
 * post-schema drift), the JSON shape, and edge cases.
 */

interface DiscoverData {
  root: string;
  totalFiles: number;
  filesWithFrontmatter: number;
  unreadable: Array<{ file: string; error: string }>;
  schemaPresent: boolean;
  fields: Array<{
    field: string;
    count: number;
    frequency: number;
    types: Array<{ type: string; count: number }>;
    mixedTypes: boolean;
    divergingFiles: string[];
    defined?: boolean;
    divergingOptions?: Array<{ value: string; files: string[] }>;
  }>;
  drift?: {
    usedButUndefined: string[];
    definedButUnused: string[];
    optionDivergences: Array<{ field: string; values: Array<{ value: string; files: string[] }> }>;
  };
}

function parseJson(stdout: string): DiscoverData {
  const parsed = JSON.parse(stdout) as { success: boolean; data: DiscoverData };
  expect(parsed.success).toBe(true);
  return parsed.data;
}

function field(data: DiscoverData, name: string) {
  return data.fields.find((f) => f.field === name);
}

describe('schema discover', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bwrb-discover-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeNote(rel: string, content: string): Promise<void> {
    const full = join(dir, rel);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  }

  describe('pre-schema (onboarding) role', () => {
    beforeEach(async () => {
      await writeNote('notes/a.md', `---\ntype: idea\nstatus: raw\npriority: high\n---\nbody\n`);
      await writeNote('notes/b.md', `---\ntype: idea\nstatus: backlog\npriority: medium\neffort: 2\n---\n`);
      await writeNote('notes/sub/c.md', `---\ntype: task\nstatus: done\n---\n`);
    });

    it('reports per-field frequencies', async () => {
      const result = await runCLI(['schema', 'discover', join(dir, 'notes'), '--output', 'json']);
      expect(result.exitCode).toBe(0);
      const data = parseJson(result.stdout);

      expect(data.schemaPresent).toBe(false);
      expect(data.totalFiles).toBe(3);
      expect(data.filesWithFrontmatter).toBe(3);

      expect(field(data, 'status')?.count).toBe(3);
      expect(field(data, 'status')?.frequency).toBeCloseTo(1);
      expect(field(data, 'priority')?.count).toBe(2);
      expect(field(data, 'effort')?.count).toBe(1);
    });

    it('reports value-type consistency per field', async () => {
      const result = await runCLI(['schema', 'discover', join(dir, 'notes'), '--output', 'json']);
      const data = parseJson(result.stdout);

      const status = field(data, 'status');
      expect(status?.mixedTypes).toBe(false);
      expect(status?.types).toEqual([{ type: 'string', count: 3 }]);

      const effort = field(data, 'effort');
      expect(effort?.types).toEqual([{ type: 'number', count: 1 }]);
    });

    it('renders a human-readable table by default', async () => {
      const result = await runCLI(['schema', 'discover', join(dir, 'notes')]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Field usage in');
      expect(result.stdout).toContain('status');
      expect(result.stdout).toContain('no schema');
    });

    it('defaults to the current directory when no path is given', async () => {
      const result = await runCLI(['schema', 'discover', '--output', 'json'], undefined, undefined, {
        cwd: join(dir, 'notes'),
      });
      const data = parseJson(result.stdout);
      expect(data.totalFiles).toBe(3);
    });
  });

  describe('mixed value types', () => {
    it('flags a field with mixed types descriptively and names diverging files', async () => {
      await writeNote('a.md', `---\neffort: 2\n---\n`);
      await writeNote('b.md', `---\neffort: 3\n---\n`);
      await writeNote('c.md', `---\neffort: "two"\n---\n`);

      const result = await runCLI(['schema', 'discover', dir, '--output', 'json']);
      expect(result.exitCode).toBe(0);
      const data = parseJson(result.stdout);

      const effort = field(data, 'effort');
      expect(effort?.mixedTypes).toBe(true);
      // number is the baseline (2 of 3); the string note diverges.
      expect(effort?.types).toEqual([
        { type: 'number', count: 2 },
        { type: 'string', count: 1 },
      ]);
      expect(effort?.divergingFiles).toEqual(['c.md']);
    });

    it('does not exit non-zero for non-conforming data', async () => {
      await writeNote('a.md', `---\nx: 1\n---\n`);
      await writeNote('b.md', `---\nx: "one"\n---\n`);
      const result = await runCLI(['schema', 'discover', dir]);
      expect(result.exitCode).toBe(0);
    });
  });

  describe('post-schema (drift) role', () => {
    beforeEach(async () => {
      await mkdir(join(dir, '.bwrb'), { recursive: true });
      await writeFile(
        join(dir, '.bwrb', 'schema.json'),
        JSON.stringify({
          version: 2,
          types: {
            meta: {},
            idea: {
              extends: 'meta',
              fields: {
                status: { prompt: 'select', options: ['raw', 'backlog', 'active'] },
                rating: { prompt: 'number' },
              },
            },
          },
        })
      );
      await writeNote('notes/a.md', `---\ntype: idea\nstatus: raw\ndeadline: 2024-01-15\n---\n`);
      await writeNote('notes/b.md', `---\ntype: idea\nstatus: nonsense\n---\n`);
    });

    it('detects used-but-undefined fields', async () => {
      const result = await runCLI(['schema', 'discover', dir, '--output', 'json']);
      const data = parseJson(result.stdout);
      expect(data.schemaPresent).toBe(true);
      expect(data.drift?.usedButUndefined).toContain('deadline');
      expect(data.drift?.usedButUndefined).not.toContain('status');
      // The `type` discriminator is never reported as undefined.
      expect(data.drift?.usedButUndefined).not.toContain('type');
    });

    it('detects defined-but-unused fields', async () => {
      const result = await runCLI(['schema', 'discover', dir, '--output', 'json']);
      const data = parseJson(result.stdout);
      expect(data.drift?.definedButUnused).toContain('rating');
      // Built-ins are excluded from defined-but-unused.
      expect(data.drift?.definedButUnused).not.toContain('id');
      expect(data.drift?.definedButUnused).not.toContain('name');
    });

    it('detects values diverging from declared select options', async () => {
      const result = await runCLI(['schema', 'discover', dir, '--output', 'json']);
      const data = parseJson(result.stdout);
      const divergence = data.drift?.optionDivergences.find((d) => d.field === 'status');
      expect(divergence).toBeDefined();
      expect(divergence?.values[0]?.value).toBe('nonsense');
      expect(divergence?.values[0]?.files).toEqual(['notes/b.md']);
    });

    it('renders a drift section in text mode', async () => {
      const result = await runCLI(['schema', 'discover', dir]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Drift vs schema');
      expect(result.stdout).toContain('Used but not defined');
      expect(result.stdout).toContain('Defined in schema but unused');
      expect(result.stdout).toContain('diverging from declared options');
    });

    it('--no-schema suppresses drift even when a schema is present', async () => {
      const result = await runCLI(['schema', 'discover', dir, '--no-schema', '--output', 'json']);
      const data = parseJson(result.stdout);
      expect(data.schemaPresent).toBe(false);
      expect(data.drift).toBeUndefined();
      expect(field(data, 'status')?.defined).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('handles an empty folder', async () => {
      const result = await runCLI(['schema', 'discover', dir, '--output', 'json']);
      expect(result.exitCode).toBe(0);
      const data = parseJson(result.stdout);
      expect(data.totalFiles).toBe(0);
      expect(data.fields).toEqual([]);
    });

    it('handles notes with no frontmatter', async () => {
      await writeNote('a.md', `just text\n`);
      await writeNote('b.md', `# Heading\n\nbody\n`);
      const result = await runCLI(['schema', 'discover', dir, '--output', 'json']);
      expect(result.exitCode).toBe(0);
      const data = parseJson(result.stdout);
      expect(data.totalFiles).toBe(2);
      expect(data.filesWithFrontmatter).toBe(0);
      expect(data.fields).toEqual([]);
    });

    it('exits non-zero for an unreadable path', async () => {
      const result = await runCLI(['schema', 'discover', join(dir, 'does-not-exist')]);
      expect(result.exitCode).toBe(2);
    });

    it('reports an error as JSON for an unreadable path in json mode', async () => {
      const result = await runCLI([
        'schema',
        'discover',
        join(dir, 'nope'),
        '--output',
        'json',
      ]);
      expect(result.exitCode).toBe(2);
      const parsed = JSON.parse(result.stdout) as { success: boolean; error: string };
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('not found');
    });

    it('classifies dates, lists, and booleans distinctly', async () => {
      await writeNote('a.md', `---\nwhen: 2024-03-01\ntags:\n  - x\nactive: true\n---\n`);
      const result = await runCLI(['schema', 'discover', dir, '--output', 'json']);
      const data = parseJson(result.stdout);
      expect(field(data, 'when')?.types[0]?.type).toBe('date');
      expect(field(data, 'tags')?.types[0]?.type).toBe('list');
      expect(field(data, 'active')?.types[0]?.type).toBe('boolean');
    });
  });
});
