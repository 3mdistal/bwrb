import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  withIdentityMigrationFence,
  withNoteIdentityTransaction,
} from '../../../src/lib/identity-transaction.js';

const vaults: string[] = [];

afterEach(async () => {
  await Promise.all(vaults.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('identity migration fence', () => {
  it('drains active transactions, blocks newcomers, and never serializes peer transactions', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'bwrb-identity-fence-'));
    vaults.push(vault);
    await mkdir(join(vault, '.bwrb'), { recursive: true });
    await writeIdentitySchema(vault, 'frontmatter-v1');

    let releasePeers!: () => void;
    const holdPeers = new Promise<void>(resolve => { releasePeers = resolve; });
    let peerCount = 0;
    let peersEntered!: () => void;
    const bothPeersEntered = new Promise<void>(resolve => { peersEntered = resolve; });
    const peer = () => withNoteIdentityTransaction(vault, 'frontmatter-v1', async () => {
      peerCount++;
      if (peerCount === 2) peersEntered();
      await holdPeers;
    });
    const peers = Promise.all([peer(), peer()]);
    await bothPeersEntered;
    const leaseDir = join(vault, '.bwrb/locks/identity-transactions');
    const old = new Date(Date.now() - 60_000);
    for (const entry of await readdir(leaseDir)) {
      await utimes(join(leaseDir, entry), old, old);
    }

    let fenceEntered!: () => void;
    const insideFence = new Promise<void>(resolve => { fenceEntered = resolve; });
    let releaseFence!: () => void;
    const holdFence = new Promise<void>(resolve => { releaseFence = resolve; });
    const fence = withIdentityMigrationFence(vault, async () => {
      fenceEntered();
      await holdFence;
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    let didFenceEnter = false;
    void insideFence.then(() => { didFenceEnter = true; });
    await Promise.resolve();
    expect(didFenceEnter).toBe(false);

    releasePeers();
    await peers;
    await insideFence;
    await expect(withNoteIdentityTransaction(vault, 'frontmatter-v1', async () => undefined))
      .rejects.toThrow('migration is in progress');
    releaseFence();
    await fence;
  });

  it('rejects a transaction whose loaded identity mode became stale', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'bwrb-identity-mode-'));
    vaults.push(vault);
    await mkdir(join(vault, '.bwrb'), { recursive: true });
    await writeIdentitySchema(vault, 'registry-v1');

    await expect(withNoteIdentityTransaction(
      vault,
      'frontmatter-v1',
      async () => undefined
    )).rejects.toThrow('frontmatter-v1 -> registry-v1');
  });

  it('fails closed when the transaction lease directory is unreadable as a directory', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'bwrb-identity-unreadable-'));
    vaults.push(vault);
    await mkdir(join(vault, '.bwrb/locks'), { recursive: true });
    await writeFile(join(vault, '.bwrb/locks/identity-transactions'), 'not a directory');

    await expect(withIdentityMigrationFence(vault, async () => undefined))
      .rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});

async function writeIdentitySchema(
  vault: string,
  identityStore: 'registry-v1' | 'frontmatter-v1'
): Promise<void> {
  await writeFile(
    join(vault, '.bwrb/schema.json'),
    JSON.stringify({ version: 2, config: { identity_store: identityStore }, types: {} }, null, 2)
  );
}
