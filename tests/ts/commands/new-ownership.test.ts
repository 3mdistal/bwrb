import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { createTestVault, cleanupTestVault, runCLI } from '../fixtures/setup.js';

/**
 * Tests for JSON mode ownership flags (--owner and --standalone).
 * Uses the shared TEST_SCHEMA which includes ownership-enabled types
 * (project owns research notes).
 */

describe('new command - JSON mode ownership flags', () => {
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = await createTestVault();

    // Create an owner note for ownership tests
    // Projects use the folder pattern: Projects/NoteName/NoteName.md
    await mkdir(join(vaultDir, 'Projects/My Project/research'), { recursive: true });
    await writeFile(
      join(vaultDir, 'Projects/My Project', 'My Project.md'),
      `---
type: project
status: in-flight
---

A test project for ownership testing.
`
    );

    // Delay to ensure file system sync completes (fixes flaky tests on macOS)
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  afterEach(async () => {
    await cleanupTestVault(vaultDir);
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
    // Error output may go to stderr for early validation errors
    const outputStr = result.stdout || result.stderr;
    expect(outputStr).toContain('Cannot use both --owner and --standalone');
  });

  it('should error when --owner used with non-ownable type', async () => {
    const result = await runCLI(
      ['new', 'idea', '--json', '{"name": "Test Idea"}', '--owner', '[[My Project]]'],
      vaultDir
    );

    expect(result.exitCode).not.toBe(0);
    // Error output may go to stderr for early validation errors
    const outputStr = result.stdout || result.stderr;
    expect(outputStr).toContain('cannot be owned');
  });

  it('should error when --owner references non-existent note', async () => {
    const result = await runCLI(
      ['new', 'research', '--json', '{"name": "Test Research"}', '--owner', '[[Nonexistent Project]]'],
      vaultDir
    );

    expect(result.exitCode).not.toBe(0);
    // Error output may go to stderr for early validation errors
    const outputStr = result.stdout || result.stderr;
    expect(outputStr).toContain('Owner not found');
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
