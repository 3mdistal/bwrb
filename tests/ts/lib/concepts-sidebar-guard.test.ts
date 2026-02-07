import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  computeConceptSidebarDrift,
  conceptSlugFromDocsRelativePath,
  extractSidebarConceptRefs,
  normalizeConceptRef,
  scanConceptFiles,
} from '../../../src/lib/docs-site/conceptsSidebarGuard.js';

async function collectMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectMarkdownFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      files.push(fullPath);
    }
  }

  return files;
}

describe('concepts sidebar guard', () => {
  it('normalizes concept refs consistently', () => {
    expect(normalizeConceptRef('/concepts/schema/')).toBe('concepts/schema');
    expect(normalizeConceptRef('concepts/schema#intro')).toBe('concepts/schema');
    expect(normalizeConceptRef('concepts/schema?tab=one')).toBe('concepts/schema');
  });

  it('derives concept slug from docs relative paths', () => {
    expect(conceptSlugFromDocsRelativePath('concepts/schema.md')).toBe('concepts/schema');
    expect(conceptSlugFromDocsRelativePath('concepts/nested/overview.md')).toBe('concepts/nested/overview');
    expect(conceptSlugFromDocsRelativePath('concepts/index.md')).toBeNull();
    expect(conceptSlugFromDocsRelativePath('reference/schema.md')).toBeNull();
  });

  it('extracts concept refs from sidebar section only', () => {
    const source = `
const unrelated = [{ slug: 'concepts/not-from-sidebar' }];
export default defineConfig({
  integrations: [
    starlight({
      sidebar: [
        { label: 'Core Concepts', items: [
          { slug: 'concepts/schema' },
          { link: '/concepts/migrations/#deep-dive' },
          // { slug: 'concepts/commented-out' },
        ] }
      ]
    })
  ]
});
`;

    const refs = extractSidebarConceptRefs(source);
    expect(refs.has('concepts/schema')).toBe(true);
    expect(refs.has('concepts/migrations')).toBe(true);
    expect(refs.has('concepts/not-from-sidebar')).toBe(false);
    expect(refs.has('concepts/commented-out')).toBe(false);
  });

  it('computes drift using allowlist', () => {
    const diskEntries = [
      { slug: 'concepts/schema', filePath: 'concepts/schema.md' },
      { slug: 'concepts/hidden', filePath: 'concepts/hidden.md' },
    ];
    const sidebarRefs = new Set(['concepts/schema', 'concepts/missing']);
    const allowlist = new Set(['concepts/hidden']);

    const drift = computeConceptSidebarDrift(diskEntries, sidebarRefs, allowlist);
    expect(drift.missingFromSidebar).toEqual([]);
    expect(drift.missingOnDisk).toEqual(['concepts/missing']);
  });

  it('passes against current repository docs-site configuration', async () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const repoRoot = join(testDir, '..', '..', '..');
    const docsRoot = join(repoRoot, 'docs-site', 'src', 'content', 'docs');
    const conceptsDir = join(docsRoot, 'concepts');
    const astroConfigPath = join(repoRoot, 'docs-site', 'astro.config.mjs');

    const [files, source] = await Promise.all([
      collectMarkdownFiles(conceptsDir),
      readFile(astroConfigPath, 'utf-8'),
    ]);

    const diskEntries = scanConceptFiles(files, docsRoot);
    const sidebarRefs = extractSidebarConceptRefs(source);
    const drift = computeConceptSidebarDrift(diskEntries, sidebarRefs, new Set<string>());

    expect(drift.missingFromSidebar).toEqual([]);
    expect(drift.missingOnDisk).toEqual([]);
  });
});
