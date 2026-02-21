import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const VITE_ENV_SHIM_ID = '\0bwrb:vitest-vite-env';

function splitQuery(id: string): { filePath: string; query: string } {
  const queryIndex = id.indexOf('?');
  if (queryIndex === -1) {
    return { filePath: id, query: '' };
  }

  return {
    filePath: id.slice(0, queryIndex),
    query: id.slice(queryIndex),
  };
}

function resolveScriptExtension(filePath: string): string {
  if (existsSync(filePath)) {
    return filePath;
  }

  if (filePath.endsWith('.js')) {
    const tsPath = filePath.slice(0, -3) + '.ts';
    if (existsSync(tsPath)) {
      return tsPath;
    }

    const tsxPath = filePath.slice(0, -3) + '.tsx';
    if (existsSync(tsxPath)) {
      return tsxPath;
    }
  }

  return filePath;
}

function isHashAbsolute(filePath: string): boolean {
  return path.isAbsolute(filePath) && filePath.includes('#');
}

function isRootRelative(source: string): boolean {
  return source.startsWith('/tests/') || source.startsWith('/src/');
}

function isRelative(source: string): boolean {
  return source.startsWith('./') || source.startsWith('../');
}

export function createVitestViteEnvShimPlugin() {
  return {
    name: 'bwrb-vitest-vite-env-shim',
    enforce: 'pre' as const,
    resolveId(source: string, importer?: string) {
      if (
        source === '/@vite/env' ||
        source.startsWith('/@vite/env?') ||
        source.includes('/vite/dist/client/env.mjs')
      ) {
        return VITE_ENV_SHIM_ID;
      }

      if (isRootRelative(source)) {
        const { filePath, query } = splitQuery(source);
        const resolved = resolveScriptExtension(path.resolve(process.cwd(), `.${filePath}`));
        return `${resolved}${query}`;
      }

      if (importer && importer.includes('#') && isRelative(source)) {
        const { filePath: importerPath } = splitQuery(importer);
        const { filePath: sourcePath, query } = splitQuery(source);
        const resolved = resolveScriptExtension(path.resolve(path.dirname(importerPath), sourcePath));
        return `${resolved}${query}`;
      }

      const { filePath, query } = splitQuery(source);
      if (isHashAbsolute(filePath)) {
        const resolved = resolveScriptExtension(filePath);
        return `${resolved}${query}`;
      }

      return null;
    },
    async load(id: string) {
      if (id === VITE_ENV_SHIM_ID) {
        return 'export {};\n';
      }

      const { filePath } = splitQuery(id);
      if (!isHashAbsolute(filePath)) {
        return null;
      }

      const resolved = resolveScriptExtension(filePath);

      try {
        return await readFile(resolved, 'utf8');
      } catch {
        return null;
      }
    },
  };
}
