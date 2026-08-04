import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveSchema } from '../../../src/lib/schema.js';
import { explainTransition } from '../../../src/lib/transition-guards.js';
import { editNoteFromJson } from '../../../src/lib/edit.js';
import { executeBulk } from '../../../src/lib/bulk/execute.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function fixture(requirementStatus: string) {
  const vault = await mkdtemp(join(tmpdir(), 'bwrb-transition-')); dirs.push(vault);
  await mkdir(join(vault, '.bwrb'), { recursive: true });
  await writeFile(
    join(vault, '.bwrb/schema.json'),
    JSON.stringify({ version: 2, config: {}, types: {} })
  );
  await mkdir(join(vault, 'Candidates'), { recursive: true });
  await mkdir(join(vault, 'Requirements'), { recursive: true });
  const schema = resolveSchema({ version: 2, traits: { guarded: { transition_guards: [{ on: 'status = accepted', requires: [{ relation: 'requirements', all: { field: 'status', equals: 'satisfied' }, failed_when: { field: 'status', in: ['failed'] }, stale_when: { field: 'status', in: ['stale'] } }] }] } }, types: {
    candidate: { traits: ['guarded'], fields: { status: { prompt: 'select' }, requirements: { prompt: 'relation', source: 'requirement', multiple: true } }, output_dir: 'Candidates' },
    requirement: { fields: { status: { prompt: 'select' } }, output_dir: 'Requirements' },
  }});
  await writeFile(join(vault, 'Requirements', 'R.md'), `---\ntype: requirement\nstatus: ${requirementStatus}\n---\n`, 'utf8');
  return { vault, schema };
}

describe('transition guards', () => {
  it('inherits guards from traits composed by an ancestor type', async () => {
    const { vault } = await fixture('failed');
    const schema = resolveSchema({ version: 2, traits: { guarded: { transition_guards: [{ on: 'status = accepted', requires: [{ relation: 'requirements', all: { field: 'status', equals: 'satisfied' } }] }] } }, types: {
      candidate: { traits: ['guarded'], fields: { status: { prompt: 'select' }, requirements: { prompt: 'relation', source: 'requirement', multiple: true } }, output_dir: 'Candidates' },
      'special-candidate': { extends: 'candidate', fields: {}, output_dir: 'Candidates' },
      requirement: { fields: { status: { prompt: 'select' } }, output_dir: 'Requirements' },
    }});

    const result = await explainTransition(schema, vault, 'special-candidate', { status: 'accepted', requirements: ['[[R]]'] }, { field: 'status', value: 'accepted' });
    expect(result.blocked).toBe(true);
    expect(result.guards).toHaveLength(1);
  });

  it('reports every relation state deterministically', async () => {
    const { vault, schema } = await fixture('stale');
    const result = await explainTransition(schema, vault, 'candidate', { status: 'accepted', requirements: ['[[R]]', '[[Missing]]'] }, { field: 'status', value: 'accepted' });
    expect(result.blocked).toBe(true);
    expect(result.guards[0]!.requirements[0]).toMatchObject({ status: 'unresolved', targets: [{ target: 'R', status: 'stale' }, { target: 'Missing', status: 'unresolved' }] });
  });

  it('reports missing and satisfied requirements', async () => {
    const { vault, schema } = await fixture('satisfied');
    const missing = await explainTransition(schema, vault, 'candidate', { status: 'accepted' }, { field: 'status', value: 'accepted' });
    expect(missing.guards[0]!.requirements[0]!.status).toBe('missing');
    const satisfied = await explainTransition(schema, vault, 'candidate', { status: 'accepted', requirements: ['[[R]]'] }, { field: 'status', value: 'accepted' });
    expect(satisfied.blocked).toBe(false);
  });

  it('prevents a blocked JSON edit without writing', async () => {
    const { vault, schema } = await fixture('failed');
    const path = join(vault, 'Candidates', 'C.md');
    const original = '---\ntype: candidate\nstatus: implementing\nrequirements: "[[R]]"\n---\nBody\n';
    await writeFile(path, original, 'utf8');
    await expect(editNoteFromJson(schema, vault, path, '{"status":"accepted"}')).rejects.toMatchObject({ code: 'TRANSITION_GUARD_FAILED' });
    expect(await readFile(path, 'utf8')).toBe(original);
  });

  it('reports a blocked bulk file and leaves it unchanged', async () => {
    const { vault, schema } = await fixture('failed');
    const path = join(vault, 'Candidates', 'C.md');
    const original = '---\ntype: candidate\nstatus: implementing\nrequirements: "[[R]]"\n---\n';
    await writeFile(path, original, 'utf8');
    const result = await executeBulk({ vaultDir: vault, schema, typePath: 'candidate', operations: [{ type: 'set', field: 'status', value: 'accepted' }], whereExpressions: [], execute: true, backup: false, verbose: false, quiet: true, jsonMode: true });
    expect(result.errors[0]).toContain('Transition guard requirements');
    expect(await readFile(path, 'utf8')).toBe(original);
  });
});
