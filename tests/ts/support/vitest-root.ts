import { createHash } from 'node:crypto';
import { readlinkSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function getSymlinkPath(cwd: string): string {
  const digest = createHash('sha1').update(cwd).digest('hex');
  return path.join(os.tmpdir(), `bwrb-vitest-root-${digest}`);
}

export function resolveVitestRoot(cwd: string = process.cwd()): string {
  if (!cwd.includes('#')) {
    return cwd;
  }

  const symlinkPath = getSymlinkPath(cwd);

  try {
    const existingTarget = readlinkSync(symlinkPath);
    if (existingTarget !== cwd) {
      rmSync(symlinkPath, { force: true });
      symlinkSync(cwd, symlinkPath, 'dir');
    }
  } catch {
    symlinkSync(cwd, symlinkPath, 'dir');
  }

  return symlinkPath;
}
