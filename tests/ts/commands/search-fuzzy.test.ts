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

  // Person with aliases (the alias-matching subject).
  await writeFile(
    join(vaultDir, 'People', 'Steve Yegge.md'),
    `---
type: person
aliases:
  - Stevey
  - "Steve Y"
---
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

  it('requires a query', async () => {
    const result = await runCLI(['search', '--fuzzy', '--output', 'json'], vaultDir);

    expect(result.exitCode).not.toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.success).toBe(false);
  });
});
