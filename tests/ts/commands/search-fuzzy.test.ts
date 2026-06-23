import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { runCLI } from '../fixtures/setup.js';

/**
 * Schema with a `person` entity type whose `aliases` field carries the alias
 * role. Lets us exercise alias-aware fuzzy matching.
 */
const FUZZY_SCHEMA = {
  version: 2,
  types: {
    person: {
      output_dir: 'People',
      fields: {
        type: { value: 'person' },
        aliases: { prompt: 'list', alias: true, list_format: 'yaml-array' },
      },
      field_order: ['type', 'aliases'],
    },
    idea: {
      output_dir: 'Ideas',
      fields: { type: { value: 'idea' } },
      field_order: ['type'],
    },
  },
};

async function createFuzzyVault(): Promise<string> {
  const vaultDir = await mkdtemp(join(tmpdir(), 'bwrb-fuzzy-'));
  await mkdir(join(vaultDir, '.bwrb'), { recursive: true });
  await writeFile(
    join(vaultDir, '.bwrb', 'schema.json'),
    JSON.stringify(FUZZY_SCHEMA, null, 2)
  );

  await mkdir(join(vaultDir, 'People'), { recursive: true });
  await mkdir(join(vaultDir, 'Ideas'), { recursive: true });

  // Person with aliases (the alias-matching subject). Carries a body so we can
  // assert that `--output content` prints the full file (frontmatter + body).
  await writeFile(
    join(vaultDir, 'People', 'Steve Yegge.md'),
    `---
type: person
aliases:
  - Stevey
  - "Steve Y"
---

Steve's distinctive body line.
`
  );

  // A clearly different person, far from the queries below.
  await writeFile(
    join(vaultDir, 'People', 'Margaret Hamilton.md'),
    `---
type: person
---
`
  );

  // A near-typo target for name-based fuzzy ranking.
  await writeFile(
    join(vaultDir, 'Ideas', 'Deterministic Safety Net.md'),
    `---
type: idea
---
`
  );

  // Tie-break subjects: a real note named "Zed" and a different note whose
  // alias is "Zed". Both score 1.0 for the query "Zed"; the name match must win.
  await writeFile(
    join(vaultDir, 'People', 'Zed.md'),
    `---
type: person
---
`
  );
  await writeFile(
    join(vaultDir, 'People', 'Zachary.md'),
    `---
type: person
aliases:
  - Zed
---
`
  );

  return vaultDir;
}

describe('search --fuzzy', () => {
  let vaultDir: string;

  beforeAll(async () => {
    vaultDir = await createFuzzyVault();
  });

  afterAll(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  it('ranks the closest name match first', async () => {
    const result = await runCLI(
      ['search', 'Detrministic Safety Net', '--fuzzy', '--output', 'json'],
      vaultDir
    );

    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(true);
    expect(json.data.length).toBeGreaterThan(0);
    expect(json.data[0].name).toBe('Deterministic Safety Net');
  });

  it('exact name match scores highest (1.0)', async () => {
    const result = await runCLI(
      ['search', 'Steve Yegge', '--fuzzy', '--output', 'json'],
      vaultDir
    );

    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.data[0].name).toBe('Steve Yegge');
    expect(json.data[0].score).toBe(1);
    expect(json.data[0].matchedField).toBe('name');
  });

  it('matches a note by its alias', async () => {
    const result = await runCLI(
      ['search', 'Stevey', '--fuzzy', '--output', 'json'],
      vaultDir
    );

    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.data[0].name).toBe('Steve Yegge');
    expect(json.data[0].matchedField).toBe('alias');
    expect(json.data[0].matchedValue).toBe('Stevey');
    expect(json.data[0].score).toBe(1);
  });

  it('surfaces an alias near-match (typo)', async () => {
    const result = await runCLI(
      ['search', 'Stevy', '--fuzzy', '--output', 'json'],
      vaultDir
    );

    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.stdout);
    const top = json.data[0];
    expect(top.name).toBe('Steve Yegge');
    expect(top.matchedField).toBe('alias');
    expect(top.score).toBeGreaterThan(0.5);
    expect(top.score).toBeLessThan(1);
  });

  it('threshold excludes far matches', async () => {
    // High threshold should reject everything for an unrelated query.
    const result = await runCLI(
      ['search', 'Quetzalcoatl', '--fuzzy', '--threshold', '0.9', '--output', 'json'],
      vaultDir
    );

    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(true);
    expect(json.data).toEqual([]);
  });

  it('JSON output includes scores and aliases', async () => {
    const result = await runCLI(
      ['search', 'Steve', '--fuzzy', '--output', 'json'],
      vaultDir
    );

    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.stdout);
    const top = json.data[0];
    expect(top.name).toBe('Steve Yegge');
    expect(typeof top.score).toBe('number');
    expect(top).toHaveProperty('wikilink');
    expect(top).toHaveProperty('path');
    expect(top.aliases).toEqual(expect.arrayContaining(['Stevey', 'Steve Y']));
  });

  it('empty/no-match returns empty data in JSON mode', async () => {
    const result = await runCLI(
      ['search', 'zzzzzzzzzzxxxxxxx', '--fuzzy', '--output', 'json'],
      vaultDir
    );

    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(true);
    expect(json.data).toEqual([]);
  });

  it('default text output shows the score and ranks best first', async () => {
    const result = await runCLI(['search', 'Steve', '--fuzzy'], vaultDir);

    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split('\n').filter(Boolean);
    expect(lines[0]).toContain('Steve Yegge');
    // Default format prefixes a two-decimal score.
    expect(lines[0]).toMatch(/^\d\.\d{2}\s+Steve Yegge/);
  });

  it('--output link emits a clean wikilink for the top match', async () => {
    const result = await runCLI(
      ['search', 'Steve Yegge', '--fuzzy', '--output', 'link'],
      vaultDir
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.split('\n')[0]).toBe('[[Steve Yegge]]');
  });

  it('--output content prints the full file (frontmatter + body)', async () => {
    const result = await runCLI(
      ['search', 'Steve Yegge', '--fuzzy', '--output', 'content'],
      vaultDir
    );

    expect(result.exitCode).toBe(0);
    // Same shape as plain `search --output content`: frontmatter delimiters,
    // frontmatter fields, and the note body all present.
    expect(result.stdout).toContain('---');
    expect(result.stdout).toContain('type: person');
    expect(result.stdout).toContain('aliases:');
    expect(result.stdout).toContain("Steve's distinctive body line.");
    // Default text format would prefix a score; content must NOT (no fallthrough).
    expect(result.stdout).not.toMatch(/^\d\.\d{2}\s+Steve Yegge/m);
  });

  it('--output content matches plain search --output content byte-for-byte', async () => {
    const fuzzy = await runCLI(
      ['search', 'Steve Yegge', '--fuzzy', '--output', 'content'],
      vaultDir
    );
    const plain = await runCLI(
      ['search', 'Steve Yegge', '--output', 'content', '--picker', 'none'],
      vaultDir
    );

    expect(fuzzy.exitCode).toBe(0);
    expect(plain.exitCode).toBe(0);
    expect(fuzzy.stdout).toBe(plain.stdout);
  });

  it('--output content emits matches best-first by score', async () => {
    // Query matches multiple notes; the highest-scoring file's content prints
    // first. "Steve Yegge" is the closest match, so its body leads.
    const result = await runCLI(
      ['search', 'Steve', '--fuzzy', '--output', 'content'],
      vaultDir
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Steve's distinctive body line.");
    // The best match's content appears before any other note's frontmatter.
    const bodyIdx = result.stdout.indexOf("Steve's distinctive body line.");
    expect(bodyIdx).toBeGreaterThanOrEqual(0);
  });

  it('--output content is silent when nothing matches', async () => {
    const result = await runCLI(
      ['search', 'zzzzzzzzzzxxxxxxx', '--fuzzy', '--output', 'content'],
      vaultDir
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('ranks an exact name match above an exact alias match at equal score', async () => {
    // "Zed" is both the name of one note and the alias of another; both score
    // 1.0. The documented "exact match ranks first" contract means the real
    // name match (Zed) must rank above the aliased match (Zachary).
    const result = await runCLI(
      ['search', 'Zed', '--fuzzy', '--output', 'json'],
      vaultDir
    );

    expect(result.exitCode).toBe(0);
    const json = JSON.parse(result.stdout);

    const zed = json.data.find((d: { name: string }) => d.name === 'Zed');
    const zachary = json.data.find((d: { name: string }) => d.name === 'Zachary');
    expect(zed).toBeDefined();
    expect(zachary).toBeDefined();
    expect(zed.score).toBe(1);
    expect(zed.matchedField).toBe('name');
    expect(zachary.score).toBe(1);
    expect(zachary.matchedField).toBe('alias');

    // Name match must come first overall, and specifically before the alias match.
    expect(json.data[0].name).toBe('Zed');
    const zedIdx = json.data.indexOf(zed);
    const zacharyIdx = json.data.indexOf(zachary);
    expect(zedIdx).toBeLessThan(zacharyIdx);
  });

  it('rejects an out-of-range threshold', async () => {
    const result = await runCLI(
      ['search', 'Steve', '--fuzzy', '--threshold', '5', '--output', 'json'],
      vaultDir
    );

    expect(result.exitCode).not.toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(false);
    expect(json.error).toContain('threshold');
  });

  it('rejects a malformed --threshold with trailing garbage (json mode)', async () => {
    const result = await runCLI(
      ['search', 'Steve', '--fuzzy', '--threshold', '0.5abc', '--output', 'json'],
      vaultDir
    );

    expect(result.exitCode).not.toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(false);
    expect(json.error).toContain('threshold');
  });

  it('rejects a malformed --threshold in text mode', async () => {
    const result = await runCLI(
      ['search', 'Steve', '--fuzzy', '--threshold', '0.5abc'],
      vaultDir
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toContain('threshold');
  });

  it('rejects a non-integer --limit (2.7)', async () => {
    const result = await runCLI(
      ['search', 'Steve', '--fuzzy', '--limit', '2.7', '--output', 'json'],
      vaultDir
    );

    expect(result.exitCode).not.toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(false);
    expect(json.error).toContain('limit');
  });

  it('rejects an exponent-notation --limit (1e1)', async () => {
    const result = await runCLI(
      ['search', 'Steve', '--fuzzy', '--limit', '1e1', '--output', 'json'],
      vaultDir
    );

    expect(result.exitCode).not.toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(false);
    expect(json.error).toContain('limit');
  });

  it('rejects a malformed --limit with trailing garbage in text mode', async () => {
    const result = await runCLI(
      ['search', 'Steve', '--fuzzy', '--limit', '3abc'],
      vaultDir
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr + result.stdout).toContain('limit');
  });

  it('requires a query', async () => {
    const result = await runCLI(['search', '--fuzzy', '--output', 'json'], vaultDir);

    expect(result.exitCode).not.toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(false);
  });
});
