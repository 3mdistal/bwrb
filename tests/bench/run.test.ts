import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureChecksum, fixtureDriftContamination, runBenchmark, summarizeObservations, type CommandObservation } from '../../tools/bench/run.js';
import { generateFixture } from '../../tools/bench/generate-fixtures.js';

const temporary: string[] = [];
async function directory(name: string): Promise<string> { const value = await mkdtemp(join(tmpdir(), `bwrb-bench-run-${name}-`)); temporary.push(value); return value; }
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function observation(durationMs: number, classification: CommandObservation['classification'] = 'measured'): CommandObservation {
  return { workflow: 'list-count', cacheState: 'cold', sample: 1, command: ['bwrb'], durationMs, exitCode: 0, signal: null, stdout: { bytes: 2, sha256: 'x', jsonValid: true }, stderr: { bytes: 0, sha256: 'y', jsonValid: false }, peakRss: { classification: 'unmeasured', valueBytes: null, reason: 'test' }, classification };
}

describe('benchmark runner', () => {
  it('summarizes deterministic timings and labels contamination', () => {
    const measured = summarizeObservations([observation(1), observation(4), observation(2)], 'raw.jsonl');
    expect(measured.timing).toEqual({ medianMs: 2, p95Ms: 4, rangeMs: { min: 1, max: 4 } });
    expect(summarizeObservations([observation(1, 'contaminated')], 'raw.jsonl').classification).toBe('contaminated');
  });

  it('recomputes fixture bytes and labels checksum drift as contamination', async () => {
    const fixture = await directory('checksum');
    await generateFixture('small', fixture);
    const before = await fixtureChecksum(fixture);
    await writeFile(join(fixture, 'Notes', 'note-00000.md'), 'mutated fixture bytes\n');
    const after = await fixtureChecksum(fixture);
    expect(after).not.toBe(before);
    expect(fixtureDriftContamination(before, after)).toBe('fixture checksum changed during a non-mutating workflow');
  });

  it('runs the built CLI on an explicit small fixture and leaves parseable raw evidence', async () => {
    const temp = await directory('temp');
    const out = await directory('out');
    const report = await runBenchmark({ profile: 'small', tempDir: temp, outDir: out, mode: 'built', samples: 1, warmRepeats: 1, cwd: process.cwd() });
    const lines = (await readFile(report.rawJsonl, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as CommandObservation);
    expect(report.fixture.noteCount).toBe(25);
    expect(report.workflows).toHaveLength(22);
    expect(lines).toHaveLength(22);
    expect(lines.every(line => line.peakRss.classification === 'unmeasured')).toBe(true);
    expect(lines.filter(line => line.workflow === 'template-new').every(line => line.exitCode === 0)).toBe(true);
  }, 60_000);
});
