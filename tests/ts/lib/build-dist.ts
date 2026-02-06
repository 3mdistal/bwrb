import { spawn } from 'child_process';
import { open, unlink } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const BUILD_LOCK_PATH = path.join(PROJECT_ROOT, '.vitest-build.lock');
const BUILD_LOCK_RETRY_MS = 200;
const BUILD_LOCK_TIMEOUT_MS = 120000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireBuildLock(): Promise<() => Promise<void>> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < BUILD_LOCK_TIMEOUT_MS) {
    try {
      const handle = await open(BUILD_LOCK_PATH, 'wx');
      await handle.writeFile(`${process.pid}\n`, 'utf-8');

      return async () => {
        try {
          await handle.close();
        } finally {
          try {
            await unlink(BUILD_LOCK_PATH);
          } catch {
            // Another process may have already cleaned up the lock.
          }
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      await sleep(BUILD_LOCK_RETRY_MS);
    }
  }

  throw new Error(
    `Timed out waiting for build lock at ${BUILD_LOCK_PATH} after ${BUILD_LOCK_TIMEOUT_MS}ms`
  );
}

async function runBuild(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('pnpm', ['-s', 'build'], {
      cwd: PROJECT_ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (error) => {
      reject(error);
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          [
            `pnpm -s build failed with exit code ${code ?? 'unknown'}`,
            stdout.trim() ? `stdout:\n${stdout.trim()}` : '',
            stderr.trim() ? `stderr:\n${stderr.trim()}` : '',
          ]
            .filter(Boolean)
            .join('\n\n')
        )
      );
    });
  });
}

let buildPromise: Promise<void> | null = null;

export async function ensureDistBuiltForTests(): Promise<void> {
  if (buildPromise) {
    return buildPromise;
  }

  buildPromise = (async () => {
    const releaseLock = await acquireBuildLock();
    try {
      await runBuild();
    } finally {
      await releaseLock();
    }
  })();

  return buildPromise;
}
