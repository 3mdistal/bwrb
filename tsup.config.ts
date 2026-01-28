import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

const here = dirname(fileURLToPath(import.meta.url));
const packagePath = join(here, 'package.json');
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as {
  version?: unknown;
};

if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
  throw new Error('Unable to resolve package.json version for build.');
}

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  define: {
    __BWRB_VERSION__: JSON.stringify(packageJson.version),
  },
});
