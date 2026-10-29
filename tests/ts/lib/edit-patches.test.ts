import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'fs';
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadSchema } from '../../../src/lib/schema.js';
import { buildNoteContent, parseNote } from '../../../src/lib/frontmatter.js';
import { getLineageMutationLockPath } from '../../../src/lib/lineage-lock.js';
import { noteRevision } from '../../../src/lib/note-revision.js';
import { PatchManifestError, runPatchBatch } from '../../../src/lib/edit-patches.js';

// Pass-through mocks, so a test can inject a read or serialization fault.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
vi.mock('../../../src/lib/frontmatter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/lib/frontmatter.js')>();
  return { ...actual, buildNoteContent: vi.fn(actual.buildNoteContent) };
});

const actualFs = await vi.importActual<typeof import('fs/promises')>('fs/promises');
const actualFrontmatter = await vi.importActual<typeof import('../../../src/lib/frontmatter.js')>(
  '../../../src/lib/frontmatter.js'
);
const read = vi.mocked(readFile);
const build = vi.mocked(buildNoteContent);

function ioError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ID_SHARED = '33333333-3333-4333-8333-333333333333';

const dirs: string[] = [];
afterEach(async () => {
  read.mockReset().mockImplementation(actualFs.readFile);
  build.mockReset().mockImplementation(actualFrontmatter.buildNoteContent);
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const SCHEMA = {
  version: 2,
  traits: {
    advancing: { transition_effects: [{ on: 'status = accepted', relation: 'ticket', set: { status: 'done' } }] },
    guarded: {
      transition_guards: [{
        on: 'status = done',
        requires: [{ relation: 'requirements', all: { field: 'status', equals: 'satisfied' } }],
      }],
    },
  },
  types: {
    task: {
      output_dir: 'Tasks',
      traits: ['guarded'],
      fields: {
        status: { prompt: 'select', options: ['open', 'active', 'done'] },
        owner: { prompt: 'text' },
        rank: { prompt: 'number' },
        requirements: { prompt: 'relation', source: 'requirement', multiple: true },
      },
    },
    requirement: { output_dir: 'Requirements', fields: { status: { prompt: 'select', options: ['pending', 'satisfied'] } } },
    candidate: {
      output_dir: 'Candidates',
      traits: ['advancing'],
      fields: {
        status: { prompt: 'select', options: ['implementing', 'accepted'] },
        ticket: { prompt: 'relation', source: 'ticket' },
      },
    },
    ticket: { output_dir: 'Tickets', fields: { status: { prompt: 'select', options: ['open', 'done'] } } },
    area: { output_dir: 'Areas', recursive: true, fields: { title: { prompt: 'text' } } },
  },
};

const NOTES: Record<string, string> = {
  'Tasks/A.md': `---\ntype: task\nstatus: open\nowner: Ana\nid: ${ID_A}\n---\nBody of A.\n`,
  'Tasks/B.md': `---\ntype: task\nstatus: open\nid: ${ID_B}\n---\nBody of B.\n`,
  'Tasks/C.md': '---\ntype: task\nstatus: open\n---\n',
  'Tasks/Shared One.md': `---\ntype: task\nstatus: open\nid: ${ID_SHARED}\n---\n`,
  'Tasks/Shared Two.md': `---\ntype: task\nstatus: open\nid: ${ID_SHARED}\n---\n`,
  'Tasks/Guarded.md': '---\ntype: task\nstatus: active\nrequirements:\n  - "[[R]]"\n---\n',
  'Requirements/R.md': '---\ntype: requirement\nstatus: pending\n---\n',
  'Candidates/Cand.md': '---\ntype: candidate\nstatus: implementing\nticket: "[[T]]"\n---\n',
  'Tickets/T.md': '---\ntype: ticket\nstatus: open\n---\n',
  'Areas/X.md': '---\ntype: area\n---\n',
  'Areas/Y.md': '---\ntype: area\n---\n',
};

async function fixture() {
  const vault = await mkdtemp(join(tmpdir(), 'bwrb-patches-')); dirs.push(vault);
  await mkdir(join(vault, '.bwrb'), { recursive: true });
  await writeFile(join(vault, '.bwrb/schema.json'), JSON.stringify(SCHEMA));
  for (const [path, content] of Object.entries(NOTES)) {
    await mkdir(join(vault, path, '..'), { recursive: true });
    await writeFile(join(vault, path), content, 'utf8');
  }
  const schema = await loadSchema(vault);
  const read = (path: string) => readFile(join(vault, path), 'utf8');
  const run = (notes: unknown[], options: Parameters<typeof runPatchBatch>[3] = {}) =>
    runPatchBatch(schema, vault, JSON.stringify({ notes }), options);
  return { vault, schema, read, run };
}

async function snapshot(read: (path: string) => Promise<string>): Promise<Record<string, string>> {
  const entries = await Promise.all(Object.keys(NOTES).map(async (path) => [path, await read(path)] as const));
  return Object.fromEntries(entries);
}

describe('edit patch batches', () => {
  it('previews every patch without writing', async () => {
    const { read, run } = await fixture();
    const before = await snapshot(read);

    const batch = await run([
      { path: 'Tasks/A.md', patch: { status: 'active', rank: 1 } },
      { id: ID_B, patch: { owner: 'Bo' } },
    ]);

    expect(batch).toMatchObject({ success: true, exitCode: 0 });
    expect(batch.result.mode).toBe('preview');
    expect(batch.result.counts).toMatchObject({ notes: 2, planned: 2 });
    expect(batch.result.notes[0]).toMatchObject({
      index: 0,
      id: ID_A,
      path: 'Tasks/A.md',
      status: 'planned',
      updated: ['status', 'rank'],
      beforeRevision: noteRevision(before['Tasks/A.md']!),
      revision: null,
      changes: { status: { from: 'open', to: 'active' }, rank: { to: 1 } },
    });
    expect(batch.result.notes[1]).toMatchObject({ id: ID_B, path: 'Tasks/B.md', status: 'planned' });
    expect(await snapshot(read)).toEqual(before);
  });

  it('applies each patch to its own note and preserves everything else', async () => {
    const { read, run, vault } = await fixture();

    const batch = await run([
      { path: 'Tasks/A.md', patch: { status: 'active' } },
      { id: ID_B, patch: { owner: 'Bo', rank: 2 } },
      { path: './Tasks/./C.md', patch: { owner: null } },
    ], { execute: true });

    expect(batch).toMatchObject({ success: true, exitCode: 0 });
    expect(batch.result.counts).toMatchObject({ applied: 2, unchanged: 1 });
    const a = await parseNote(join(vault, 'Tasks/A.md'));
    expect(a.frontmatter).toEqual({ type: 'task', status: 'active', owner: 'Ana', id: ID_A });
    expect(a.body).toBe('Body of A.\n');
    const b = await parseNote(join(vault, 'Tasks/B.md'));
    expect(b.frontmatter).toEqual({ type: 'task', status: 'open', id: ID_B, owner: 'Bo', rank: 2 });
    expect(b.body).toBe('Body of B.\n');
    expect(batch.result.notes[0]!.revision).toBe(noteRevision(await read('Tasks/A.md')));
    expect(batch.result.notes[2]).toMatchObject({ path: 'Tasks/C.md', status: 'unchanged' });
  });

  it('reports notes that already hold their values as unchanged, so a manifest can be rerun', async () => {
    const { read, run } = await fixture();
    const staleRevision = noteRevision(await read('Tasks/A.md'));
    const manifest = [
      { path: 'Tasks/A.md', expectedRevision: staleRevision, patch: { status: 'active' } },
      { id: ID_B, patch: { owner: 'Bo' } },
    ];
    await run(manifest, { execute: true });
    const afterFirst = await snapshot(read);

    const rerun = await run(manifest, { execute: true });

    expect(rerun).toMatchObject({ success: true, exitCode: 0 });
    expect(rerun.result.counts).toMatchObject({ unchanged: 2, applied: 0 });
    expect(rerun.result.notes[0]!.revision).toBe(noteRevision(afterFirst['Tasks/A.md']!));
    expect(await snapshot(read)).toEqual(afterFirst);
  });

  it('names missing, ambiguous, mismatched and duplicate targets and writes nothing', async () => {
    const { read, run } = await fixture();
    const before = await snapshot(read);

    const batch = await run([
      { path: 'Tasks/Missing.md', patch: { status: 'active' } },
      { id: '44444444-4444-4444-8444-444444444444', patch: { status: 'active' } },
      { id: ID_SHARED, patch: { status: 'active' } },
      { id: ID_A, path: 'Tasks/B.md', patch: { status: 'active' } },
      { path: 'Tasks/A.md', patch: { status: 'active' } },
      { id: ID_A, patch: { owner: 'Al' } },
      { path: 'Tasks/C.md', patch: { status: 'active' } },
    ], { execute: true });

    expect(batch).toMatchObject({ success: false, exitCode: 1 });
    const codes = batch.result.notes.map((note) => note.errors?.map((error) => error.code));
    expect(codes).toEqual([
      ['TARGET_NOT_FOUND'],
      ['TARGET_NOT_FOUND'],
      ['TARGET_AMBIGUOUS'],
      ['TARGET_MISMATCH'],
      ['DUPLICATE_TARGET'],
      ['DUPLICATE_TARGET'],
      undefined,
    ]);
    expect(batch.result.notes[2]!.errors![0]!.message).toContain('Tasks/Shared One.md');
    expect(batch.result.notes[6]!.status).toBe('not-attempted');
    expect(batch.error).toBe('6 of 7 notes are blocked, so nothing was written.');
    expect(await snapshot(read)).toEqual(before);
  });

  it('validates each patch like edit --json', async () => {
    const { read, run } = await fixture();
    const before = await snapshot(read);

    const batch = await run([
      { path: 'Tasks/A.md', patch: { status: 'finished' } },
      { path: 'Tasks/B.md', patch: { colour: 'blue' } },
      { path: 'Tasks/C.md', patch: { id: ID_A } },
      { path: 'Tasks/Shared One.md', patch: { _body: 'New body' } },
      { path: 'Tasks/Shared Two.md', patch: { status: 'active' } },
    ]);

    expect(batch).toMatchObject({ success: false, exitCode: 1 });
    const [badOption, unknownField, reserved, body, fine] = batch.result.notes;
    expect(badOption!.errors![0]).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'Validation failed: Invalid value for status: "finished"',
    });
    expect(badOption!.errors![0]!.errors).toEqual([expect.objectContaining({ field: 'status' })]);
    expect(unknownField!.errors![0]).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(unknownField!.errors![0]!.errors).toEqual([expect.objectContaining({ field: 'colour' })]);
    expect(reserved!.errors![0]).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(body!.errors![0]).toMatchObject({ code: 'BODY_NOT_SUPPORTED' });
    expect(fine).toMatchObject({ status: 'planned' });
    expect(await snapshot(read)).toEqual(before);
  });

  it('rejects a stale expected revision with the I/O exit code', async () => {
    const { run } = await fixture();

    const batch = await run([
      { path: 'Tasks/A.md', expectedRevision: 'not-the-revision', patch: { status: 'active' } },
      { path: 'Tasks/B.md', patch: { status: 'active' } },
    ], { execute: true });

    expect(batch).toMatchObject({ success: false, exitCode: 2 });
    expect(batch.result.notes[0]!.errors![0]).toMatchObject({
      code: 'REVISION_MISMATCH',
      expectedRevision: 'not-the-revision',
    });
    expect(batch.result.notes[1]!.status).toBe('not-attempted');
  });

  it('blocks failed transition guards and changes that would write related notes', async () => {
    const { read, run } = await fixture();
    const before = await snapshot(read);

    const batch = await run([
      { path: 'Tasks/Guarded.md', patch: { status: 'done' } },
      { path: 'Candidates/Cand.md', patch: { status: 'accepted' } },
    ], { execute: true });

    expect(batch.success).toBe(false);
    expect(batch.result.notes[0]!.errors![0]!.code).toBe('TRANSITION_GUARD_FAILED');
    expect(batch.result.notes[1]!.errors![0]!.code).toBe('RELATED_WRITES_NOT_SUPPORTED');
    expect(await snapshot(read)).toEqual(before);
  });

  it('checks parent cycles against the batch as a whole', async () => {
    const { run } = await fixture();

    const batch = await run([
      { path: 'Areas/X.md', patch: { parent: '[[Y]]' } },
      { path: 'Areas/Y.md', patch: { parent: '[[X]]' } },
    ]);

    expect(batch.success).toBe(false);
    expect(batch.result.notes.flatMap((note) => note.errors ?? []).map((error) => error.code))
      .toContain('VALIDATION_FAILED');
  });

  it('restores earlier writes when a later write fails', async () => {
    const { read, run } = await fixture();
    const before = await snapshot(read);

    const batch = await run([
      { path: 'Tasks/A.md', patch: { status: 'active' } },
      { path: 'Tasks/B.md', patch: { status: 'active' } },
      { path: 'Tasks/C.md', patch: { status: 'active' } },
      { path: 'Tasks/Shared One.md', patch: { status: 'active' } },
    ], {
      execute: true,
      beforeWrite: (path) => {
        if (path === 'Tasks/C.md') throw new Error('disk full');
      },
    });

    expect(batch).toMatchObject({ success: false, exitCode: 2, error: 'Could not write Tasks/C.md: disk full' });
    expect(batch.result.notes.map((note) => note.status)).toEqual(['restored', 'restored', 'failed', 'not-attempted']);
    expect(batch.result.notes[0]!.revision).toBe(batch.result.notes[0]!.beforeRevision);
    expect(batch.result.notes[2]!.errors![0]!.code).toBe('WRITE_FAILED');
    expect(await snapshot(read)).toEqual(before);
  });

  it('restores a note its own failed write truncated', async () => {
    const { read, run, vault } = await fixture();
    const before = await snapshot(read);

    const batch = await run([
      { path: 'Tasks/A.md', patch: { status: 'active' } },
    ], {
      execute: true,
      beforeWrite: async (path) => {
        await writeFile(join(vault, path), '');
        throw new Error('write interrupted');
      },
    });

    expect(batch.result.notes[0]).toMatchObject({ status: 'failed', revision: batch.result.notes[0]!.beforeRevision });
    expect(await snapshot(read)).toEqual(before);
  });

  it('leaves a note that changed again after the batch wrote it', async () => {
    const { read, run, vault } = await fixture();
    const newer = '---\ntype: task\nstatus: done\n---\nSomeone else wrote this.\n';

    const batch = await run([
      { path: 'Tasks/A.md', patch: { status: 'active' } },
      { path: 'Tasks/B.md', patch: { status: 'active' } },
    ], {
      execute: true,
      beforeWrite: async (path) => {
        if (path !== 'Tasks/B.md') return;
        await writeFile(join(vault, 'Tasks/A.md'), newer);
        throw new Error('disk full');
      },
    });

    expect(batch.result.notes[0]).toMatchObject({ status: 'applied' });
    expect(batch.result.notes[0]!.errors![0]!.code).toBe('RESTORE_SKIPPED');
    expect(await read('Tasks/A.md')).toBe(newer);
    expect(await read('Tasks/B.md')).toBe(NOTES['Tasks/B.md']);
  });

  it('blocks a note that cannot be serialized before writing anything', async () => {
    const { read: readNote, run } = await fixture();
    const before = await snapshot(readNote);
    build.mockImplementation((frontmatter, ...rest) => {
      if (frontmatter['owner'] === 'Too deep') throw new RangeError('Maximum call stack size exceeded');
      return actualFrontmatter.buildNoteContent(frontmatter, ...rest);
    });

    const batch = await run([
      { path: 'Tasks/A.md', patch: { status: 'active' } },
      { path: 'Tasks/B.md', patch: { owner: 'Too deep' } },
    ], { execute: true });

    expect(batch).toMatchObject({ success: false, exitCode: 1 });
    expect(batch.result.notes.map((note) => note.status)).toEqual(['not-attempted', 'blocked']);
    expect(batch.result.notes[1]!.errors![0]).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'Could not serialize the patched note: Maximum call stack size exceeded',
    });
    expect(await snapshot(readNote)).toEqual(before);
  });

  it('restores a note whose failed write stopped inside a multibyte character', async () => {
    const { read: readNote, run, vault } = await fixture();
    const original = '---\ntype: task\nstatus: open\n---\nCaf\u00e9 au lait.\n';
    await writeFile(join(vault, 'Tasks/A.md'), original);
    const manifest = [{ path: 'Tasks/A.md', patch: { status: 'active' } }];
    await run(manifest, { execute: true });
    const intended = Buffer.from(await readNote('Tasks/A.md'));
    await writeFile(join(vault, 'Tasks/A.md'), original);

    const batch = await run(manifest, {
      execute: true,
      beforeWrite: async (path) => {
        // Keep only the first byte of the two-byte \u00e9.
        await writeFile(join(vault, path), intended.subarray(0, intended.indexOf(Buffer.from('\u00e9')) + 1));
        throw new Error('write interrupted');
      },
    });

    expect(batch.result.notes[0]).toMatchObject({ status: 'failed', revision: noteRevision(original) });
    expect(await readNote('Tasks/A.md')).toBe(original);
  });

  it('rolls back instead of recreating a note that was removed before its write', async () => {
    const { read: readNote, run, vault } = await fixture();

    const batch = await run([
      { path: 'Tasks/A.md', patch: { status: 'active' } },
      { path: 'Tasks/B.md', patch: { status: 'active' } },
    ], {
      execute: true,
      beforeWrite: async (path) => {
        if (path === 'Tasks/B.md') await unlink(join(vault, path));
      },
    });

    expect(batch).toMatchObject({ success: false, exitCode: 2 });
    expect(batch.result.notes.map((note) => note.status)).toEqual(['restored', 'failed']);
    expect(batch.result.notes[1]!.errors!.map((error) => error.code)).toEqual(['WRITE_FAILED']);
    expect(await readNote('Tasks/A.md')).toBe(NOTES['Tasks/A.md']);
    expect(existsSync(join(vault, 'Tasks/B.md'))).toBe(false);
  });

  it('keeps the written statuses when releasing a lock fails, and releases the other locks', async () => {
    const { read: readNote, run, vault } = await fixture();
    const locks = ['Tasks/A.md', 'Tasks/B.md']
      .map((path) => getLineageMutationLockPath(vault, join(vault, path)))
      .sort((a, b) => a.localeCompare(b, 'en'));
    // Locks are released in reverse order, so fail the first one released.
    const [kept, failing] = locks as [string, string];

    const batch = await run([
      { path: 'Tasks/A.md', patch: { status: 'active' } },
      { path: 'Tasks/B.md', patch: { status: 'active' } },
    ], {
      execute: true,
      beforeWrite: (path) => {
        if (path !== 'Tasks/B.md') return;
        read.mockImplementation(async (file, options) => {
          if (String(file) === failing) throw ioError('EIO');
          return actualFs.readFile(file, options);
        });
      },
    });

    expect(batch).toMatchObject({
      success: false,
      exitCode: 2,
      error: 'Every note was written, but releasing a lock failed: simulated EIO',
    });
    expect(batch.result.notes.map((note) => note.status)).toEqual(['applied', 'applied']);
    expect((await parseNote(join(vault, 'Tasks/B.md'))).frontmatter['status']).toBe('active');
    expect(existsSync(kept)).toBe(false);
    expect(existsSync(failing)).toBe(true);
    expect(await readNote('Tasks/A.md')).not.toBe(NOTES['Tasks/A.md']);
  });

  it('checks an id-only target against the note it reads', async () => {
    const { read: readNote, run, vault } = await fixture();
    const other = '55555555-5555-4555-8555-555555555555';
    let reads = 0;
    read.mockImplementation(async (file, options) => {
      const content = await actualFs.readFile(file, options);
      // After the vault snapshot finds B by its id, B gets a different id.
      if (String(file) === join(vault, 'Tasks/B.md') && reads++ === 0) {
        await actualFs.writeFile(file, NOTES['Tasks/B.md']!.replace(ID_B, other));
      }
      return content;
    });

    const batch = await run([{ id: ID_B, patch: { status: 'active' } }], { execute: true });

    expect(batch).toMatchObject({ success: false, exitCode: 1 });
    expect(batch.result.notes[0]!.errors![0]).toMatchObject({
      code: 'TARGET_MISMATCH',
      message: `Tasks/B.md has id ${other}, not ${ID_B}.`,
    });
    expect(await readNote('Tasks/B.md')).toBe(NOTES['Tasks/B.md']!.replace(ID_B, other));
  });

  it('reports an unreadable note with the I/O exit code', async () => {
    const { run, vault } = await fixture();
    read.mockImplementation(async (file, options) => {
      if (String(file) === join(vault, 'Tasks/A.md')) throw ioError('EIO');
      return actualFs.readFile(file, options);
    });

    const batch = await run([{ path: 'Tasks/A.md', patch: { status: 'active' } }]);

    expect(batch).toMatchObject({ success: false, exitCode: 2 });
    expect(batch.result.notes[0]!.errors![0]!.code).toBe('READ_FAILED');
  });

  it('rejects unusable manifests and records malformed entries', async () => {
    const { schema, vault, run } = await fixture();

    await expect(runPatchBatch(schema, vault, '{not json')).rejects.toThrow(PatchManifestError);
    await expect(runPatchBatch(schema, vault, '{"notes":[]}')).rejects.toThrow('The patch manifest has no notes.');
    await expect(runPatchBatch(schema, vault, '{"notes":[],"extra":1}')).rejects.toThrow('Unknown patch manifest key');
    await expect(runPatchBatch(schema, vault, '[]')).rejects.toThrow('must be an object with a "notes" array');

    const batch = await run([
      'not an object',
      { path: 'Tasks/A.md' },
      { path: '../outside.md', patch: {} },
      { path: 'C:/vault/Tasks/A.md', patch: {} },
      { id: 'not-a-uuid', patch: {} },
      { path: 'Tasks/A.md', patch: {}, note: 'extra' },
      { patch: {} },
    ]);
    expect(batch.result.notes.every((note) => note.errors?.every((error) => error.code === 'INVALID_ENTRY'))).toBe(true);
    expect(batch.result.counts.blocked).toBe(7);
  });
});
