import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withNoteIdentityTransaction } from '../../../src/lib/identity-transaction.js';
import { withOwnershipFileLock } from '../../../src/lib/lineage-lock.js';

const exec = promisify(execFile);
let root: string;
let vault: string;
let locks: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bwrb-runtime-locks-'));
  vault = join(root, 'vault');
  locks = join(vault, '.bwrb/locks');
  await mkdir(join(locks, 'identity-transactions'), { recursive: true });
  await writeFile(join(vault, '.bwrb/schema.json'), JSON.stringify({ config: { identity_store: 'frontmatter-v1' } }));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('runtime lock preparation', () => {
  it('works outside Git under a translated process locale without changing that locale', async () => {
    vi.stubEnv('LC_ALL', 'fr_FR.UTF-8');
    vi.stubEnv('LANGUAGE', 'fr');
    await withNoteIdentityTransaction(vault, 'frontmatter-v1', async () => undefined);
    expect(process.env.LC_ALL).toBe('fr_FR.UTF-8');
    expect(process.env.LANGUAGE).toBe('fr');
  });
  it('recovers fresh dead leases with unrelated names, preserving live owners and unknown files', async () => {
    const dead = join(locks, 'identity-transactions/123-old.lease');
    const live = join(locks, 'identity-transactions/live.lease');
    const unknown = join(locks, 'user.txt');
    await writeFile(dead, metadata(dead, deadPid()));
    await writeFile(live, metadata(live, process.pid));
    await writeFile(unknown, 'preserve');
    await withNoteIdentityTransaction(vault, 'frontmatter-v1', async () => {
      expect(existsSync(dead)).toBe(false);
      expect(existsSync(live)).toBe(true);
      expect(await readFile(unknown, 'utf8')).toBe('preserve');
    });
  });

  it('recovers abandoned recovery markers and quarantines without needing their UUID again', async () => {
    const base = join(locks, 'identity-transactions/123-old.lease');
    await writeFile(`${base}.recovery`, metadata(`${base}.recovery`, deadPid()));
    await writeFile(`${base}.quarantine-123-old`, metadata(base, deadPid()));
    await withNoteIdentityTransaction(vault, 'frontmatter-v1', async () => undefined);
    expect(existsSync(`${base}.recovery`)).toBe(false);
    expect(existsSync(`${base}.quarantine-123-old`)).toBe(false);
  });

  it('preserves a fresh incomplete lease, and only reaps unknown metadata after the grace period', async () => {
    const fresh = join(locks, 'identity-transactions/fresh.lease');
    const stale = join(locks, 'identity-transactions/stale.lease');
    await writeFile(fresh, '');
    await writeFile(stale, '');
    const old = new Date(Date.now() - 31_000);
    await utimes(stale, old, old);
    await withNoteIdentityTransaction(vault, 'frontmatter-v1', async () => undefined);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });

  it('excludes only runtime locks before the action without changing tracked files or the index', async () => {
    await exec('git', ['init', '--quiet'], { cwd: vault });
    await exec('git', ['add', '.bwrb/schema.json'], { cwd: vault });
    const indexBefore = (await exec('git', ['ls-files', '--stage'], { cwd: vault })).stdout;
    const exclude = join(vault, '.git/info/exclude');
    await mkdir(join(vault, '.git/info'), { recursive: true });
    await writeFile(exclude, '# existing user rules\nkeep-me-without-newline');
    const statusBefore = (await exec('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: vault })).stdout;
    await withNoteIdentityTransaction(vault, 'frontmatter-v1', async () => {
      expect((await exec('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: vault })).stdout).toBe(statusBefore);
      expect((await exec('git', ['ls-files', '--stage'], { cwd: vault })).stdout).toBe(indexBefore);
    });
    expect(await readFile(exclude, 'utf8')).toContain('# existing user rules\nkeep-me-without-newline\n');
    expect(existsSync(join(locks, '.gitignore'))).toBe(false);
    await writeFile(join(vault, '.bwrb/not-runtime.json'), '{}');
    expect((await exec('git', ['ls-files', '--others', '--exclude-standard'], { cwd: vault })).stdout).toContain('.bwrb/not-runtime.json');
  });

  it('uses the shared Git exclusion in a linked worktree and escapes nested vault paths', async () => {
    await exec('git', ['init', '--quiet'], { cwd: vault });
    await exec('git', ['add', '.bwrb/schema.json'], { cwd: vault });
    await exec('git', ['-c', 'user.name=Bowerbird Test', '-c', 'user.email=bwrb@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: vault });
    const worktree = join(root, 'worktree');
    await exec('git', ['worktree', 'add', '--quiet', '--detach', worktree], { cwd: vault });
    const directory = join(worktree, 'nested [vault] space!/.bwrb/locks');
    const lock = join(directory, 'id-registry.lock');
    await withOwnershipFileLock(lock, async () => {
      expect((await exec('git', ['check-ignore', '--', lock], { cwd: worktree })).stdout).toContain('id-registry.lock');
    });
    expect(await readFile(join(vault, '.git/info/exclude'), 'utf8')).toContain('/nested \\[vault\\] space\\!/.bwrb/locks/'.replace(/ /g, '\\ '));
  });

  it('repairs a locally negated rule and verifies actual exclusion with an active lease', async () => {
    await exec('git', ['init', '--quiet'], { cwd: vault });
    await mkdir(join(vault, '.git/info'), { recursive: true });
    await writeFile(join(vault, '.git/info/exclude'), '/.bwrb/locks/\n!/.bwrb/locks/\n');
    await withNoteIdentityTransaction(vault, 'frontmatter-v1', async () => {
      expect((await exec('git', ['ls-files', '--others', '--exclude-standard'], { cwd: vault })).stdout).not.toContain('.lease');
    });
  });

  it('fails before creating a lease when tracked rules override exclusion, even after an earlier acquisition', async () => {
    await exec('git', ['init', '--quiet'], { cwd: vault });
    await withNoteIdentityTransaction(vault, 'frontmatter-v1', async () => undefined);
    const rules = '!/.bwrb/locks/\n';
    await writeFile(join(vault, '.gitignore'), rules);
    const excludeBefore = await readFile(join(vault, '.git/info/exclude'), 'utf8');
    await expect(withNoteIdentityTransaction(vault, 'frontmatter-v1', async () => undefined))
      .rejects.toThrow('Git ignore rules expose Bowerbird runtime locks');
    expect(await readFile(join(vault, '.gitignore'), 'utf8')).toBe(rules);
    expect(await readFile(join(vault, '.git/info/exclude'), 'utf8')).toBe(excludeBefore);
    expect(await readdir(join(locks, 'identity-transactions'))).toEqual([]);
  });

  it('does not follow derived symlink bases or unlink symlink quarantines', async context => {
    const base = join(locks, 'identity-transactions/linked.lease');
    const outside = join(root, 'outside.txt');
    const raw = metadata(base, deadPid());
    await writeFile(outside, raw);
    try {
      await symlink(outside, base, 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return context.skip();
      throw error;
    }
    await writeFile(`${base}.recovery`, metadata(`${base}.recovery`, deadPid()));
    const other = join(locks, 'identity-transactions/other.lease');
    await writeFile(other, metadata(other, deadPid()));
    await symlink(outside, `${other}.quarantine-test`, 'file');
    await withNoteIdentityTransaction(vault, 'frontmatter-v1', async () => undefined);
    expect((await lstat(base)).isSymbolicLink()).toBe(true);
    expect((await lstat(`${other}.quarantine-test`)).isSymbolicLink()).toBe(true);
    expect(await readFile(outside, 'utf8')).toBe(raw);
    expect(existsSync(other)).toBe(false);
  });

  it('does not sweep through a symlinked .bwrb ancestor', async context => {
    const outside = join(root, 'external-bwrb');
    await rename(join(vault, '.bwrb'), outside);
    try {
      await symlink(outside, join(vault, '.bwrb'), 'junction');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return context.skip();
      throw error;
    }
    const base = join(outside, 'locks/identity-transactions/unrelated.lease');
    const quarantine = `${base}.quarantine-test`;
    await writeFile(base, '');
    await writeFile(quarantine, metadata(base, deadPid()));
    const old = new Date(Date.now() - 31_000);
    await utimes(base, old, old);
    await withNoteIdentityTransaction(vault, 'frontmatter-v1', async () => undefined);
    expect(await readFile(base, 'utf8')).toBe('');
    expect(existsSync(quarantine)).toBe(true);
  });

  it('does not append through a Git exclusion symlink into user content', async context => {
    await exec('git', ['init', '--quiet'], { cwd: vault });
    await mkdir(join(vault, '.git/info'), { recursive: true });
    const target = join(vault, '.gitignore');
    await writeFile(target, '# preserve user configuration\n');
    const exclude = join(vault, '.git/info/exclude');
    await rm(exclude, { force: true });
    try {
      await symlink(target, exclude, 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return context.skip();
      throw error;
    }
    await expect(withNoteIdentityTransaction(vault, 'frontmatter-v1', async () => undefined))
      .rejects.toThrow('symlinked Git runtime exclusion path');
    expect(await readFile(target, 'utf8')).toBe('# preserve user configuration\n');
    expect((await lstat(exclude)).isSymbolicLink()).toBe(true);
  });
});

function metadata(path: string, pid: number): string {
  const now = Date.now();
  return JSON.stringify({ version: 1, pid, token: `owner-${pid}`, createdAt: now, heartbeatAt: now, pathKey: basename(path) });
}
function deadPid(): number {
  for (const pid of [2_147_483_647, 2_000_000_000, 1_500_000_000]) {
    try { process.kill(pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return pid; }
  }
  throw new Error('No unused PID available for test');
}
