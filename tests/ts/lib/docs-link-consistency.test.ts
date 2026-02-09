import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectConceptRegistry,
  extractLinks,
  normalizeDocHref,
} from '../../../scripts/lib/docs-link-consistency-core.mjs';
import { runDocsLinkConsistencyLint } from '../../../scripts/docs-link-consistency.mjs';

const tempDirs: string[] = [];

const createTempRepo = () => {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bwrb-docs-lint-'));
  tempDirs.push(dirPath);
  return dirPath;
};

const writeFile = (rootDir, relativePath, contents) => {
  const fullPath = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, contents);
};

afterEach(() => {
  for (const dirPath of tempDirs.splice(0)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
});

describe('docs link consistency core', () => {
  it('normalizes trailing slash, .md, hash, and query', () => {
    expect(normalizeDocHref('/concepts/schema')).toBe('/concepts/schema/');
    expect(normalizeDocHref('/concepts/schema.md')).toBe('/concepts/schema/');
    expect(normalizeDocHref('/concepts/schema/?x=1#part')).toBe('/concepts/schema/');
    expect(normalizeDocHref('https://bwrb.dev/concepts/schema/')).toBeNull();
  });

  it('ignores links inside fenced and inline code', () => {
    const markdown = [
      '[Schema](/concepts/schema/)',
      '`[Schema](/concepts/schema/)`',
      '```md',
      '[Schema](/concepts/schema/)',
      '```',
    ].join('\n');

    const links = extractLinks(markdown, 'docs/test.md', '/reference/test/');
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe('Schema');
    expect(links[0].line).toBe(1);
  });

  it('reports ambiguous concept text definitions', () => {
    const registry = collectConceptRegistry([
      { canonicalText: 'Schema', canonicalHref: '/concepts/schema/' },
      { canonicalText: 'Schema', canonicalHref: '/reference/schema/' },
    ]);

    expect(registry.errors).toEqual([
      'Ambiguous concept text "Schema": maps to both /concepts/schema/ and /reference/schema/',
    ]);
  });
});

describe('docs-link-consistency CLI', () => {
  it('returns 0 for allowed aliases and matching canonical links', () => {
    const repoDir = createTempRepo();

    writeFile(
      repoDir,
      'docs-site/src/content/docs/concepts/schema.md',
      ['---', 'title: Schema', '---', '', 'Schema docs'].join('\n')
    );

    writeFile(
      repoDir,
      'docs-site/src/content/docs/reference/targeting.md',
      ['---', 'title: Targeting Model', '---', '', 'Targeting docs'].join('\n')
    );

    writeFile(
      repoDir,
      'docs-site/src/content/docs/reference/commands/new.md',
      '[Schema concepts](/concepts/schema/)\n[Targeting Model](/reference/targeting/)\n'
    );

    writeFile(
      repoDir,
      'docs-site/src/content/docs/.link-consistency.json',
      JSON.stringify(
        {
          version: 1,
          concepts: [
            {
              canonicalText: 'Schema',
              canonicalHref: '/concepts/schema/',
              textAliases: ['Schema concepts'],
              hrefAliases: [],
            },
            {
              canonicalText: 'Targeting Model',
              canonicalHref: '/reference/targeting/',
              textAliases: [],
              hrefAliases: [],
            },
          ],
        },
        null,
        2
      )
    );

    let stderr = '';
    const exitCode = runDocsLinkConsistencyLint({
      cwd: repoDir,
      argv: [],
      stderrWriter: {
        write: (chunk: string | Uint8Array) => {
          stderr += String(chunk);
          return true;
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
  });

  it('returns non-zero with deterministic violations and suggestions', () => {
    const repoDir = createTempRepo();

    writeFile(
      repoDir,
      'docs-site/src/content/docs/concepts/schema.md',
      ['---', 'title: Schema', '---', '', 'Schema docs'].join('\n')
    );

    writeFile(
      repoDir,
      'docs-site/src/content/docs/reference/targeting.md',
      ['---', 'title: Targeting Model', '---', '', 'Targeting docs'].join('\n')
    );

    writeFile(
      repoDir,
      'docs-site/src/content/docs/reference/bad-links.md',
      [
        '[Schema concepts](/concepts/schema/)',
        '[Schema](/concepts/validation-and-audit/)',
        '```md',
        '[Schema concepts](/concepts/schema/)',
        '```',
      ].join('\n')
    );

    writeFile(
      repoDir,
      'docs-site/src/content/docs/.link-consistency.json',
      JSON.stringify(
        {
          version: 1,
          concepts: [
            {
              canonicalText: 'Targeting Model',
              canonicalHref: '/reference/targeting/',
              textAliases: [],
              hrefAliases: [],
            },
          ],
        },
        null,
        2
      )
    );

    let stderr = '';
    const exitCode = runDocsLinkConsistencyLint({
      cwd: repoDir,
      argv: [],
      stderrWriter: {
        write: (chunk: string | Uint8Array) => {
          stderr += String(chunk);
          return true;
        },
      },
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      'docs-site/src/content/docs/reference/bad-links.md:1 text-mismatch Canonical href /concepts/schema/ should use link text "Schema". Suggested: [Schema](/concepts/schema/)'
    );
    expect(stderr).toContain(
      'docs-site/src/content/docs/reference/bad-links.md:2 href-mismatch Concept text "Schema" should link to canonical href /concepts/schema/. Suggested: [Schema](/concepts/schema/)'
    );
    expect(stderr).toContain('docs:lint found 2 link consistency violations.');
  });
});
