import { createRequire } from 'node:module';

declare const __BWRB_VERSION__: string | undefined;

const injectedVersion = typeof __BWRB_VERSION__ === 'string'
  ? __BWRB_VERSION__
  : null;

let packageVersion: string | null = null;
if (!injectedVersion) {
  try {
    const require = createRequire(import.meta.url);
    const packageJson = require('../package.json') as { version?: unknown };
    packageVersion = typeof packageJson.version === 'string' && packageJson.version.length > 0
      ? packageJson.version
      : null;
  } catch {
    packageVersion = null;
  }
}

const resolvedVersion = injectedVersion ?? packageVersion;

if (!resolvedVersion) {
  throw new Error('Unable to determine bwrb version.');
}

export const BWRB_VERSION = resolvedVersion;
