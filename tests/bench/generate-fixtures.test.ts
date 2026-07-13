import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { generateFixture } from '../../tools/bench/generate-fixtures.js';

const execFileAsync = promisify(execFile);
const temporary: string[] = [];
async function fixtureDir(name: string): Promise<string> { const dir = await mkdtemp(join(tmpdir(), `bwrb-bench-${name}-`)); temporary.push(dir); return dir; }
afterEach(async () => { await Promise.all(temporary.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('benchmark fixtures', () => {
  it('generates the 25/500/10000 profiles with stable manifests', async () => {
    for (const [profile, count] of [['small', 25], ['medium', 500], ['large', 10_000]] as const) {
      const first = await generateFixture(profile, await fixtureDir(`${profile}-one`));
      const second = await generateFixture(profile, await fixtureDir(`${profile}-two`));
      expect(first.noteCount).toBe(count);
      expect(first.checksum).toBe(second.checksum);
      expect(first.audit).toEqual({ expectedIssueCount: 3, state: 'known-warnings' });
    }
  }, 30_000);

  it('makes the vault-scale analogue body-free, stable, and explicitly synthetic', async () => {
    const realistic = await generateFixture('realistic', await fixtureDir('realistic'));
    const analogueDir = await fixtureDir('analogue');
    const analogue = await generateFixture('teenylilthoughts-analogue', analogueDir);
    const analogueRepeat = await generateFixture('teenylilthoughts-analogue', await fixtureDir('analogue-repeat'));
    expect(Object.keys(realistic.typeCounts)).toHaveLength(7);
    expect(realistic.maxDirectoryDepth).toBeGreaterThanOrEqual(4);
    expect(realistic.relationDensity).toBeGreaterThan(0);
    expect(analogue.noteCount).toBe(10_000);
    expect(analogue.checksum).toBe(analogueRepeat.checksum);
    expect(analogue.bodySizeDistribution).toEqual({ empty: 10_000, small: 0, medium: 0, large: 0 });
    expect(analogue.analogue).toEqual({
      bodyPolicy: 'empty',
      liveSchemaCopied: false,
      noteBodiesCopied: false,
      purpose: 'count-comparable-structurally-synthetic',
    });
    const sample = await readFile(join(analogueDir, 'Objectives', 'objective-00001.md'), 'utf8');
    expect(sample).toContain('metadata-only: true');
    expect(sample).not.toContain('private');
    expect(sample.endsWith('---\n')).toBe(true);
  }, 30_000);

  it('has the recorded advisory-only audit state in the built CLI', async () => {
    const dir = await fixtureDir('audit');
    await generateFixture('realistic', dir);
    const result = await execFileAsync(process.execPath, ['dist/index.js', '--vault', dir, 'audit', '--output', 'json'], { cwd: process.cwd() });
    const parsed = JSON.parse(result.stdout) as { files: Array<{ issues: unknown[] }> };
    expect(parsed.files.flatMap(file => file.issues)).toHaveLength(3);
  }, 20_000);
});
