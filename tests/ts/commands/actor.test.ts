import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { runCLI } from '../fixtures/setup.js';

const vaults: string[] = [];
afterEach(async () => Promise.all(vaults.splice(0).map((vault) => rm(vault, { recursive: true, force: true }))));

async function actorVault(): Promise<string> {
  const vault = await mkdtemp(join(tmpdir(), 'bwrb-actor-'));
  vaults.push(vault);
  await mkdir(join(vault, '.bwrb'), { recursive: true });
  await writeFile(join(vault, '.bwrb', 'schema.json'), JSON.stringify({
    version: 2,
    types: {
      attestation: {
        output_dir: 'Attestations',
        fields: {
          actor: { value: '$ACTOR' },
          outcome: { prompt: 'select', options: ['passed', 'failed'] },
        },
      },
    },
  }));
  return vault;
}

describe('logical actor CLI context', () => {
  it('uses root --actor before BWRB_ACTOR for schema-declared provenance', async () => {
    const vault = await actorVault();
    const result = await runCLI(
      ['new', 'attestation', '--json', '{"name":"CI","outcome":"passed"}'],
      undefined,
      undefined,
      { env: { BWRB_ACTOR: 'claude:runner' }, cwd: vault }
    );
    expect(result.exitCode).toBe(0);
    expect(await readFile(join(vault, 'Attestations', 'CI.md'), 'utf8')).toContain('actor: claude:runner');

    const override = await runCLI(
      ['--actor', 'codex:admin', 'new', 'attestation', '--json', '{"name":"Review","outcome":"passed"}'],
      undefined,
      undefined,
      { env: { BWRB_ACTOR: 'claude:runner' }, cwd: vault }
    );
    expect(override.exitCode).toBe(0);
    expect(await readFile(join(vault, 'Attestations', 'Review.md'), 'utf8')).toContain('actor: codex:admin');
  });

  it('materializes unknown instead of attributing a missing runner to a human', async () => {
    const vault = await actorVault();
    const result = await runCLI(
      ['new', 'attestation', '--json', '{"name":"Unknown","outcome":"passed"}'],
      undefined,
      undefined,
      { env: { BWRB_ACTOR: '' }, cwd: vault }
    );
    expect(result.exitCode).toBe(0);
    expect(await readFile(join(vault, 'Attestations', 'Unknown.md'), 'utf8')).toContain('actor: unknown');
  });
});
