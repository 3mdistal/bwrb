import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveSchema } from '../../../src/lib/schema.js';
import {
  editNoteFromJson,
  type MutationFaultInjector,
  type MutationFaultPoint,
} from '../../../src/lib/edit.js';
import { noteRevision } from '../../../src/lib/note-revision.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function fixture(withEffect: boolean) {
  const vault = await mkdtemp(join(tmpdir(), 'bwrb-mutation-fault-'));
  dirs.push(vault);
  await mkdir(join(vault, '.bwrb'), { recursive: true });
  await mkdir(join(vault, 'Candidates'), { recursive: true });
  await mkdir(join(vault, 'Tasks'), { recursive: true });
  const schema = resolveSchema({ version: 2, traits: withEffect ? {
    advancing: { transition_effects: [{ on: 'status = accepted', relation: 'task', set: { status: 'done' } }] },
  } : {}, types: {
    candidate: {
      ...(withEffect ? { traits: ['advancing'] } : {}),
      fields: {
        status: { prompt: 'select', options: ['implementing', 'accepted'] },
        ...(withEffect ? { task: { prompt: 'relation', source: 'task' } } : {}),
      }, output_dir: 'Candidates',
    },
    task: { fields: { status: { prompt: 'select', options: ['open', 'done'] } }, output_dir: 'Tasks' },
  }});
  const source = join(vault, 'Candidates', 'C.md');
  const target = join(vault, 'Tasks', 'T.md');
  await writeFile(source, `---\ntype: candidate\nstatus: implementing${withEffect ? '\ntask: "[[T]]"' : ''}\n---\nSource\n`, 'utf8');
  await writeFile(target, '---\ntype: task\nstatus: open\n---\nTarget\n', 'utf8');
  return { vault, schema, source, target, sourceRaw: await readFile(source, 'utf8'), targetRaw: await readFile(target, 'utf8') };
}

async function expectNoLocks(vault: string) {
  const locks = await readdir(join(vault, '.bwrb', 'locks')).catch(() => [] as string[]);
  expect(locks).toEqual([]);
}

function failAt(phase: 'before' | 'after', point: MutationFaultPoint): MutationFaultInjector {
  return { [phase]: (seen: MutationFaultPoint) => {
    if (seen === point) throw new Error(`injected ${phase} ${point}`);
  }};
}

const preCommitPoints: MutationFaultPoint[] = [
  'source-read', 'expected-revision-check', 'lock-acquisition', 'guard-evaluation', 'recurrence',
];

describe('P1/P4 mutation fault matrix', () => {
  it.each(preCommitPoints.flatMap((point) => [['before', point], ['after', point]] as const))(
    'leaves a simple single-file mutation unchanged when %s %s fails',
    async (phase, point) => {
      const state = await fixture(false);
      await expect(editNoteFromJson(state.schema, state.vault, state.source, '{"status":"accepted"}', {
        expectedRevision: noteRevision(state.sourceRaw), mutationFaultInjector: failAt(phase, point),
      })).rejects.toThrow(`injected ${phase} ${point}`);
      expect(await readFile(state.source, 'utf8')).toBe(state.sourceRaw);
      expect(await readFile(state.target, 'utf8')).toBe(state.targetRaw);
      await expectNoLocks(state.vault);
    }
  );

  it.each(['before', 'after'] as const)(
    'compensates source bytes and releases every lock when %s source-write fails in a related-note flow',
    async (phase) => {
      const state = await fixture(true);
      await expect(editNoteFromJson(state.schema, state.vault, state.source, '{"status":"accepted"}', {
        mutationFaultInjector: failAt(phase, 'source-write'),
      })).rejects.toThrow(`injected ${phase} source-write`);
      expect(await readFile(state.source, 'utf8')).toBe(state.sourceRaw);
      expect(await readFile(state.target, 'utf8')).toBe(state.targetRaw);
      await expectNoLocks(state.vault);
    }
  );

  it.each(['before', 'after'] as const)(
    'compensates source and related-note bytes when %s related-effects fails',
    async (phase) => {
      const state = await fixture(true);
      await expect(editNoteFromJson(state.schema, state.vault, state.source, '{"status":"accepted"}', {
        mutationFaultInjector: failAt(phase, 'related-effects'),
      })).rejects.toThrow(`injected ${phase} related-effects`);
      expect(await readFile(state.source, 'utf8')).toBe(state.sourceRaw);
      expect(await readFile(state.target, 'utf8')).toBe(state.targetRaw);
      await expectNoLocks(state.vault);
    }
  );

  it('keeps its source, related bytes, and locks clean after a caught failure, then succeeds on restart', async () => {
    const state = await fixture(true);
    await expect(editNoteFromJson(state.schema, state.vault, state.source, '{"status":"accepted"}', {
      mutationFaultInjector: failAt('after', 'related-effects'),
    })).rejects.toThrow('injected after related-effects');
    expect(await readFile(state.source, 'utf8')).toBe(state.sourceRaw);
    expect(await readFile(state.target, 'utf8')).toBe(state.targetRaw);
    await expectNoLocks(state.vault);

    await editNoteFromJson(state.schema, state.vault, state.source, '{"status":"accepted"}');
    expect(await readFile(state.source, 'utf8')).toContain('status: accepted');
    expect(await readFile(state.target, 'utf8')).toContain('status: done');
    await expectNoLocks(state.vault);
  });
});
