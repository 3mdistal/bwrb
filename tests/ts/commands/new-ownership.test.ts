import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtemp } from 'fs/promises';
import { runCLI } from '../fixtures/setup.js';

/**
 * Tests for JSON mode ownership flags (--owner and --standalone).
 * Uses an isolated test vault with ownership-enabled types to avoid
 * affecting other tests.
 */

const OWNERSHIP_SCHEMA = {
  version: 2,
  enums: {
    status: ['raw', 'backlog', 'in-flight', 'settled'],
  },
  types: {
    project: {
      output_dir: 'Projects',
      fields: {
        type: { value: 'project' },
        status: { prompt: 'select', enum: 'status', default: 'raw' },
        research: {
          prompt: 'dynamic',
          source: 'research',
          format: 'wikilink',
          multiple: true,
          owned: true,
        },
      },
      field_order: ['type', 'status'],
    },
    research: {
      output_dir: 'Research',
      fields: {
        type: { value: 'research' },
        status: { prompt: 'select', enum: 'status', default: 'raw' },
      },
      field_order: ['type', 'status'],
    },
    idea: {
      output_dir: 'Ideas',
      fields: {
        type: { value: 'idea' },
        status: { prompt: 'select', enum: 'status', default: 'raw' },
      },
      field_order: ['type', 'status'],
    },
  },
};

async function createOwnershipVault(): Promise<string> {
  const vaultDir = await mkdtemp(join(tmpdir(), 'bwrb-ownership-'));

  await mkdir(join(vaultDir, '.bwrb'), { recursive: true });
  await writeFile(
    join(vaultDir, '.bwrb', 'schema.json'),
    JSON.stringify(OWNERSHIP_SCHEMA, null, 2)
  );

  await mkdir(join(vaultDir, 'Projects/My Project/research'), { recursive: true });
  await mkdir(join(vaultDir, 'Research'), { recursive: true });
  await mkdir(join(vaultDir, 'Ideas'), { recursive: true });

  await writeFile(
    join(vaultDir, 'Projects/My Project', 'My Project.md'),
    `---
type: project
status: in-flight
---

A test project for ownership testing.
`
  );

  return vaultDir;
}

describe('new command - JSON mode ownership flags', () => {
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = await createOwnershipVault();
  });

  afterEach(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  it('should create owned note with --owner flag', async () => {
    const result = await runCLI(
      ['new', 'research', '--json', '{"name": "Project Research"}', '--owner', '[[My Project]]'],
      vaultDir
    );

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.success).toBe(true);
    expect(output.path).toContain('Projects/My Project/research/Project Research.md');
  });

  it('should create pooled note with --standalone flag', async () => {
    const result = await runCLI(
      ['new', 'research', '--json', '{"name": "Standalone Research"}', '--standalone'],
      vaultDir
    );

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.success).toBe(true);
    expect(output.path).toBe('Research/Standalone Research.md');
  });

  it('should default to pooled when neither --owner nor --standalone provided', async () => {
    const result = await runCLI(
      ['new', 'research', '--json', '{"name": "Default Research"}'],
      vaultDir
    );

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.success).toBe(true);
    expect(output.path).toBe('Research/Default Research.md');
  });

  it('should error when both --owner and --standalone provided', async () => {
    const result = await runCLI(
      ['new', 'research', '--json', '{"name": "Test"}', '--owner', '[[My Project]]', '--standalone'],
      vaultDir
    );

    expect(result.exitCode).not.toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.success).toBe(false);
    expect(output.error).toContain('Cannot use both --owner and --standalone');
  });

  it('should error when --owner used with non-ownable type', async () => {
    const result = await runCLI(
      ['new', 'idea', '--json', '{"name": "Test Idea"}', '--owner', '[[My Project]]'],
      vaultDir
    );

    expect(result.exitCode).not.toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.success).toBe(false);
    expect(output.error).toContain('cannot be owned');
  });

  it('should error when --owner references non-existent note', async () => {
    const result = await runCLI(
      ['new', 'research', '--json', '{"name": "Test Research"}', '--owner', '[[Nonexistent Project]]'],
      vaultDir
    );

    expect(result.exitCode).not.toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.success).toBe(false);
    expect(output.error).toContain('Owner not found');
  });

  it('should handle --owner with plain name (no brackets)', async () => {
    const result = await runCLI(
      ['new', 'research', '--json', '{"name": "Plain Owner Research"}', '--owner', 'My Project'],
      vaultDir
    );

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.success).toBe(true);
    expect(output.path).toContain('Projects/My Project/research/');
  });

  it('should error when --standalone used with non-ownable type', async () => {
    const result = await runCLI(
      ['new', 'idea', '--json', '{"name": "Test Idea"}', '--standalone'],
      vaultDir
    );

    expect(result.exitCode).not.toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.success).toBe(false);
    expect(output.error).toContain('cannot be owned');
    expect(output.error).toContain('--standalone is not applicable');
  });
});
