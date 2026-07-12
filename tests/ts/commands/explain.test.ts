import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { runCLI } from '../fixtures/setup.js';

const vaults: string[] = [];
afterEach(async () => { await Promise.all(vaults.splice(0).map((vault) => rm(vault, { recursive: true, force: true }))); });

async function createGuardVault() {
  const vault = await mkdtemp(join(tmpdir(), 'bwrb-explain-')); vaults.push(vault);
  await Promise.all(['.bwrb', 'Candidates', 'Requirements'].map((dir) => mkdir(join(vault, dir), { recursive: true })));
  await writeFile(join(vault, '.bwrb', 'schema.json'), JSON.stringify({ version: 2, traits: { guarded: { transition_guards: [{ on: 'status = accepted', requires: [{ relation: 'requirements', all: { field: 'status', equals: 'satisfied' } }] }] } }, types: { candidate: { traits: ['guarded'], fields: { status: { prompt: 'select' }, requirements: { prompt: 'relation', source: 'requirement', multiple: true } }, output_dir: 'Candidates' }, requirement: { fields: { status: { prompt: 'select' } }, output_dir: 'Requirements' } } }), 'utf8');
  await writeFile(join(vault, 'Candidates', 'Candidate 417.md'), '---\ntype: candidate\nstatus: implementing\n---\n', 'utf8');
  return vault;
}

describe('explain command', () => {
  it('returns a blocked explanation with exit 0 for a unique value shorthand', async () => {
    const vault = await createGuardVault();
    const result = await runCLI(['explain', 'Candidate 417', '--transition', 'accepted', '--output', 'json'], vault);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ success: true, data: { blocked: true, transition: { field: 'status', value: 'accepted' }, guards: [{ requirements: [{ status: 'missing' }] }] } });
  });
});
