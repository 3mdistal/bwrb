import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeConceptSidebarDrift,
  extractSidebarConceptRefs,
  formatConceptSidebarDrift,
  normalizeConceptRef,
  scanConceptFiles,
} from '../../lib/docs-site/conceptsSidebarGuard.js';

async function collectMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectMarkdownFiles(fullPath);
      files.push(...nested);
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      files.push(fullPath);
    }
  }

  return files;
}

function parseAllowlist(raw: string): Set<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Allowlist file is not valid JSON. Expected an array of concept slugs.');
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Allowlist file must be a JSON array of concept slugs.');
  }

  const invalid: string[] = [];
  const normalized = new Set<string>();

  for (const item of parsed) {
    if (typeof item !== 'string') {
      invalid.push(String(item));
      continue;
    }

    const value = normalizeConceptRef(item);
    if (!value.startsWith('concepts/')) {
      invalid.push(item);
      continue;
    }

    normalized.add(value);
  }

  if (invalid.length > 0) {
    const joined = invalid.map((value) => `- ${value}`).join('\n');
    throw new Error(`Allowlist entries must be concept slugs (concepts/...). Invalid entries:\n${joined}`);
  }

  return normalized;
}

async function loadAllowlist(allowlistPath: string): Promise<Set<string>> {
  try {
    const raw = await readFile(allowlistPath, 'utf-8');
    return parseAllowlist(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return new Set<string>();
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const thisFile = fileURLToPath(import.meta.url);
  const repoRoot = resolve(dirname(thisFile), '../../..');
  const docsRoot = join(repoRoot, 'docs-site', 'src', 'content', 'docs');
  const conceptsDir = join(docsRoot, 'concepts');
  const astroConfigPath = join(repoRoot, 'docs-site', 'astro.config.mjs');
  const allowlistPath = join(repoRoot, 'docs-site', '.concepts-sidebar-allowlist.json');

  const [conceptFiles, astroConfigSource, allowlist] = await Promise.all([
    collectMarkdownFiles(conceptsDir),
    readFile(astroConfigPath, 'utf-8'),
    loadAllowlist(allowlistPath),
  ]);

  const diskEntries = scanConceptFiles(conceptFiles, docsRoot);
  const sidebarRefs = extractSidebarConceptRefs(astroConfigSource);
  const drift = computeConceptSidebarDrift(diskEntries, sidebarRefs, allowlist);

  if (drift.missingFromSidebar.length > 0 || drift.missingOnDisk.length > 0) {
    process.stderr.write(`${formatConceptSidebarDrift(drift)}\n`);
    process.exitCode = 1;
    return;
  }
}

main().catch((error) => {
  process.stderr.write('Docs sidebar drift detected (concepts)\n\n');
  if (error instanceof Error) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write('Unknown error while checking docs concepts sidebar.\n');
  }
  process.exitCode = 1;
});
