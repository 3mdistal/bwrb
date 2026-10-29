import { execFile } from 'child_process';
import { appendFile, lstat, mkdir, readFile } from 'fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'path';
import { promisify } from 'util';

const git = promisify(execFile);
interface GitContext { exclude: string; pattern: string }
const prepared = new Map<string, Promise<GitContext | null>>();

/** Keep coordination files out of Git without editing tracked vault content. */
export async function excludeRuntimeLocksFromGit(lockDirectory: string): Promise<void> {
  const directory = resolve(lockDirectory);
  let preparation = prepared.get(directory);
  if (!preparation) {
    if (prepared.size >= 256) prepared.delete(prepared.keys().next().value!);
    preparation = discoverGit(directory);
    prepared.set(directory, preparation);
  }
  try {
    // Non-Git vaults are not memoized: a library caller may initialize Git later.
    const context = await preparation;
    if (!context) {
      prepared.delete(directory);
      return;
    }
    // Recheck effective rules on every acquisition, even with a cached Git
    // location: tracked .gitignore files can change during this process.
    if (await isIgnored(directory)) return;
    const { exclude, pattern } = context;
    for (const path of [dirname(exclude), exclude]) {
      const info = await lstat(path).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if (info?.isSymbolicLink()) {
        throw new Error('Refusing to change a symlinked Git runtime exclusion path; ignore the lock directory in Git first.');
      }
    }
    let previous = '';
    try {
      previous = await readFile(exclude, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const rules = previous.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#'));
    if (rules.at(-1) !== pattern) {
      await mkdir(dirname(exclude), { recursive: true });
      // Append preserves existing bytes and concurrent appenders' rules. An
      // anchored path avoids broad .bwrb exemptions; the newline isolates tails.
      await appendFile(exclude, `\n# Bowerbird runtime coordination (not vault content)\n${pattern}\n`, { mode: 0o600 });
    }
    if (!await isIgnored(directory)) {
      throw new Error('Git ignore rules expose Bowerbird runtime locks. Remove the conflicting .gitignore negation before retrying.');
    }
  } catch (error) {
    prepared.delete(directory);
    throw error;
  }
}

function options(directory: string) {
  return { cwd: directory, windowsHide: true, timeout: 10_000,
    env: { ...process.env, LC_ALL: 'C', LANGUAGE: 'C' } };
}

async function isIgnored(directory: string): Promise<boolean> {
  try {
    await git('git', ['check-ignore', '--quiet', '--no-index', '--', directory], options(directory));
    return true;
  } catch (error) {
    if ((error as { code?: number }).code === 1) return false;
    throw error;
  }
}

async function discoverGit(directory: string): Promise<GitContext | null> {
  let output: string;
  try {
    ({ stdout: output } = await git('git', [
      'rev-parse', '--show-toplevel', '--git-common-dir',
    ], options(directory)));
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    if (failure.code === 'ENOENT' || failure.stderr?.includes('not a git repository')) return null;
    throw error;
  }
  const [root, common] = output.trimEnd().split(/\r?\n/);
  if (!root || !common) throw new Error('Git did not resolve its runtime exclusion path.');
  const exclude = resolve(directory, common, 'info/exclude');
  const path = relative(root, directory).replace(/\\/g, '/');
  if (path === '' || path === '..' || path.startsWith('../') || isAbsolute(path)) {
    throw new Error('Bowerbird lock directory is outside the Git worktree.');
  }
  const pattern = `/${path.replace(/[ #![\]*?\\]/g, '\\$&')}/`;
  return { exclude, pattern };
}
