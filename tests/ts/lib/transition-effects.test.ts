import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveSchema } from '../../../src/lib/schema.js';
import { editNoteFromJson } from '../../../src/lib/edit.js';
import { executeBulk } from '../../../src/lib/bulk/execute.js';
import { commitTransitionEffects } from '../../../src/lib/transition-effects.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function fixture() {
  const vault = await mkdtemp(join(tmpdir(), 'bwrb-effects-')); dirs.push(vault);
  await mkdir(join(vault, 'Candidates'), { recursive: true });
  await mkdir(join(vault, 'Tasks'), { recursive: true });
  const schema = resolveSchema({ version: 2, traits: { advancing: { transition_effects: [{ on: 'status = accepted', relation: 'task', set: { status: 'done' } }] } }, types: {
    candidate: { traits: ['advancing'], fields: { status: { prompt: 'select', options: ['implementing', 'accepted'] }, task: { prompt: 'relation', source: 'task' } }, output_dir: 'Candidates' },
    task: { fields: { status: { prompt: 'select', options: ['open', 'done'] } }, output_dir: 'Tasks' },
  }});
  const target = join(vault, 'Tasks', 'T.md');
  await writeFile(target, '---\ntype: task\nstatus: open\n---\nTarget\n', 'utf8');
  const source = join(vault, 'Candidates', 'C.md');
  await writeFile(source, '---\ntype: candidate\nstatus: implementing\ntask: "[[T]]"\n---\nSource\n', 'utf8');
  return { vault, schema, source, target };
}

describe('transition effects', () => {
  it('updates a scalar relation target only when the source enters its trigger', async () => {
    const { vault, schema, source, target } = await fixture();
    await editNoteFromJson(schema, vault, source, '{"status":"accepted"}');
    expect((await readFile(target, 'utf8'))).toContain('status: done');
    await editNoteFromJson(schema, vault, source, '{"task":"[[T]]"}');
    expect((await readFile(target, 'utf8'))).toContain('status: done');
  });

  it('uses the same target update through bulk', async () => {
    const { vault, schema, target } = await fixture();
    const result = await executeBulk({ vaultDir: vault, schema, typePath: 'candidate', operations: [{ type: 'set', field: 'status', value: 'accepted' }], whereExpressions: [], execute: true, backup: false, verbose: false, quiet: true, jsonMode: true });
    expect(result.errors).toEqual([]);
    expect((await readFile(target, 'utf8'))).toContain('status: done');
  });

  it('rolls back an earlier target when a later target write fails', async () => {
    const { vault, target } = await fixture();
    const original = await readFile(target, 'utf8');
    await expect(commitTransitionEffects([
      { path: target, raw: original, body: 'Target\n', before: { type: 'task', status: 'open' }, after: { type: 'task', status: 'done' }, order: ['type', 'status'] },
      { path: join(target, 'nested.md'), raw: '', body: '', before: {}, after: { type: 'task', status: 'done' }, order: ['type', 'status'] },
    ])).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe(original);
  });
});
