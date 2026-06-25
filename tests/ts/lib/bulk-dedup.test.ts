/**
 * Regression coverage for issue #720: on a case-insensitive filesystem `bwrb bulk`
 * enumerated each affected note twice under different path casings (e.g.
 * `tasks/Task A.md` and `Tasks/Task A.md`), processing and reporting it twice.
 *
 * These tests drive `executeBulk` directly. To deterministically reproduce "the
 * SAME physical file reachable under two paths" on ANY filesystem (case-sensitive
 * CI included), we point two type `output_dir`s at the same directory via a
 * symlink — so discovery enumerates the one note twice (distinct relativePaths,
 * identical inode). The fix must collapse those to a single processed/reported
 * entry, while genuinely distinct files are left untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, symlink, link } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { executeBulk } from '../../../src/lib/bulk/execute.js';
import { parseNote } from '../../../src/lib/frontmatter.js';
import { loadSchema } from '../../../src/lib/schema.js';
import type { LoadedSchema } from '../../../src/types/schema.js';

const SCHEMA = {
  meta: { type: 'meta' },
  types: {
    // Two types whose output_dirs resolve to the SAME physical directory: the
    // second is a symlink alias of the first. This stands in for a case-variant
    // (`Tasks` vs `tasks`) duplicate that a case-insensitive FS produces.
    task: {
      name: 'task',
      output_dir: 'Tasks',
      fields: { status: { prompt: 'select', options: ['active', 'done'] } },
    },
    chore: {
      name: 'chore',
      output_dir: 'tasks-alias',
      fields: { status: { prompt: 'select', options: ['active', 'done'] } },
    },
  },
};

describe('bulk same-file dedup (issue #720)', () => {
  let vaultDir: string;
  let schema: LoadedSchema;

  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), 'bwrb-720-'));
    await mkdir(join(vaultDir, '.bwrb'), { recursive: true });
    await writeFile(
      join(vaultDir, '.bwrb', 'schema.json'),
      JSON.stringify(SCHEMA, null, 2)
    );
    await mkdir(join(vaultDir, 'Tasks'), { recursive: true });
    await writeFile(
      join(vaultDir, 'Tasks', 'Task A.md'),
      '---\ntype: task\nstatus: active\n---\nbody\n'
    );
    // `tasks-alias` -> `Tasks`: the one note is now reachable via two paths.
    await symlink(join(vaultDir, 'Tasks'), join(vaultDir, 'tasks-alias'));
    schema = await loadSchema(vaultDir);
  });

  afterEach(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  it('reports the note exactly once in dry-run', async () => {
    const result = await executeBulk({
      operations: [{ type: 'set', field: 'status', value: 'done' }],
      whereExpressions: [],
      execute: false,
      backup: false,
      verbose: false,
      quiet: false,
      jsonMode: false,
      vaultDir,
      schema,
      all: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.affectedFiles).toBe(1);
    const changed = result.changes.filter(c => c.changes.length > 0);
    expect(changed).toHaveLength(1);
  });

  it('processes the note exactly once on execute (single write)', async () => {
    const result = await executeBulk({
      operations: [{ type: 'set', field: 'status', value: 'done' }],
      whereExpressions: [],
      execute: true,
      backup: false,
      verbose: false,
      quiet: false,
      jsonMode: false,
      vaultDir,
      schema,
      all: true,
    });

    expect(result.errors).toEqual([]);
    expect(result.affectedFiles).toBe(1);
    expect(result.changes.filter(c => c.applied)).toHaveLength(1);

    const { frontmatter } = await parseNote(join(vaultDir, 'Tasks', 'Task A.md'));
    expect(frontmatter.status).toBe('done');
  });

  it('does NOT collapse genuinely distinct files', async () => {
    await writeFile(
      join(vaultDir, 'Tasks', 'Task B.md'),
      '---\ntype: task\nstatus: active\n---\nbody\n'
    );

    const result = await executeBulk({
      operations: [{ type: 'set', field: 'status', value: 'done' }],
      whereExpressions: [],
      execute: false,
      backup: false,
      verbose: false,
      quiet: false,
      jsonMode: false,
      vaultDir,
      schema,
      all: true,
    });

    // Two distinct notes -> two entries; the symlink duplicate of each still
    // collapses to one, so exactly two affected files total (one per physical
    // file). Which path casing is kept for display is unspecified, so assert on
    // basenames: the point is each distinct note survives exactly once.
    expect(result.affectedFiles).toBe(2);
    const basenames = result.changes
      .filter(c => c.changes.length > 0)
      .map(c => c.relativePath.split('/').pop())
      .sort();
    expect(basenames).toEqual(['Task A.md', 'Task B.md']);
  });
});

/**
 * Regression coverage for the inode-dedup defect (#736): genuine HARDLINKS share
 * one inode but are DISTINCT directory entries with DISTINCT canonical paths. The
 * candidate dedup must key on realpath, NOT `dev:ino`, or a path-based bulk `move`
 * silently leaves every hardlinked sibling after the first unmoved (and omits it
 * from the candidate count/results). On a case-sensitive FS this is reachable
 * without any case trickery; the hardlinks here verify both casings of the bug.
 */
const MOVE_SCHEMA = {
  meta: { type: 'meta' },
  types: {
    task: {
      name: 'task',
      output_dir: 'Tasks',
      fields: { status: { prompt: 'select', options: ['active', 'done'] } },
    },
  },
};

describe('bulk move preserves hardlinked paths (issue #736)', () => {
  let vaultDir: string;
  let schema: LoadedSchema;

  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), 'bwrb-736-'));
    await mkdir(join(vaultDir, '.bwrb'), { recursive: true });
    await writeFile(
      join(vaultDir, '.bwrb', 'schema.json'),
      JSON.stringify(MOVE_SCHEMA, null, 2)
    );
    await mkdir(join(vaultDir, 'Tasks'), { recursive: true });
    // Two DISTINCT directory entries sharing one inode (a hardlink). Distinct
    // paths => distinct realpaths => must NOT collapse.
    const primary = join(vaultDir, 'Tasks', 'Primary.md');
    await writeFile(primary, '---\ntype: task\nstatus: active\n---\nbody\n');
    await link(primary, join(vaultDir, 'Tasks', 'Linked.md'));
    schema = await loadSchema(vaultDir);
  });

  afterEach(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  it('reports BOTH hardlinked paths in dry-run (not collapsed)', async () => {
    const result = await executeBulk({
      operations: [{ type: 'move', targetPath: 'Done' }],
      whereExpressions: [],
      execute: false,
      backup: false,
      verbose: false,
      quiet: false,
      jsonMode: false,
      vaultDir,
      schema,
      all: true,
    });

    expect(result.dryRun).toBe(true);
    // Inode dedup would yield 1; realpath dedup keeps both distinct entries.
    expect(result.affectedFiles).toBe(2);
    const basenames = result.moveResults
      .map(r => r.oldRelativePath.split('/').pop())
      .sort();
    expect(basenames).toEqual(['Linked.md', 'Primary.md']);
  });

  it('relocates BOTH hardlinked paths on execute', async () => {
    const result = await executeBulk({
      operations: [{ type: 'move', targetPath: 'Done' }],
      whereExpressions: [],
      execute: true,
      backup: false,
      verbose: false,
      quiet: false,
      jsonMode: false,
      vaultDir,
      schema,
      all: true,
    });

    expect(result.errors).toEqual([]);
    expect(result.affectedFiles).toBe(2);

    // Both directory entries relocated; neither left behind in Tasks/.
    expect(existsSync(join(vaultDir, 'Done', 'Primary.md'))).toBe(true);
    expect(existsSync(join(vaultDir, 'Done', 'Linked.md'))).toBe(true);
    expect(existsSync(join(vaultDir, 'Tasks', 'Primary.md'))).toBe(false);
    expect(existsSync(join(vaultDir, 'Tasks', 'Linked.md'))).toBe(false);
  });
});
