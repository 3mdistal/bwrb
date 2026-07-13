import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { generateFixture, type FixtureProfile } from './generate-fixtures.js';

export type RunnerMode = 'built' | 'source';
export type ResultClassification = 'measured' | 'unmeasured' | 'contaminated';

export interface CommandObservation {
  workflow: string;
  cacheState: 'cold' | 'warm';
  sample: number;
  command: string[];
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: { bytes: number; sha256: string; jsonValid: boolean };
  stderr: { bytes: number; sha256: string; jsonValid: boolean };
  peakRss: { classification: 'unmeasured'; valueBytes: null; reason: string };
  classification: ResultClassification;
  contamination?: string;
}

export interface WorkflowSummary {
  workflow: string;
  cacheState: 'cold' | 'warm';
  samples: number;
  classification: ResultClassification;
  successfulSamples: number;
  timing: { medianMs: number | null; p95Ms: number | null; rangeMs: { min: number; max: number } | null };
  rawArtifact: string;
}

export interface BenchmarkReport {
  format: 1;
  createdAt: string;
  mode: RunnerMode;
  profile: FixtureProfile;
  samples: number;
  fixture: { path: string; manifestPath: string; checksum: string; noteCount: number };
  environment: { node: string; platform: NodeJS.Platform; arch: string; cpuCount: number; concurrency: 1; peakRss: 'unmeasured' };
  workflows: WorkflowSummary[];
  rawJsonl: string;
  fullTest: { descriptor: string; classification: ResultClassification; rawArtifact?: string; reason?: string };
  profileInstructions: string[];
}

interface RunOptions {
  profile: FixtureProfile;
  tempDir: string;
  outDir: string;
  mode: RunnerMode;
  samples: number;
  warmRepeats: number;
  contamination?: string;
  fullTestCommand?: string;
  cwd: string;
}

const PROFILES = new Set<FixtureProfile>(['small', 'medium', 'large', 'realistic', 'teenylilthoughts-analogue']);

function hash(value: Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function jsonValid(value: Buffer): boolean { try { JSON.parse(value.toString('utf8')); return true; } catch { return false; } }
function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

export function summarizeObservations(observations: CommandObservation[], rawArtifact: string): WorkflowSummary {
  const durations = observations.filter(run => run.exitCode === 0 && run.classification === 'measured').map(run => run.durationMs);
  const classification: ResultClassification = observations.some(run => run.classification === 'contaminated')
    ? 'contaminated'
    : durations.length ? 'measured' : 'unmeasured';
  return {
    workflow: observations[0]!.workflow, cacheState: observations[0]!.cacheState, samples: observations.length,
    classification, successfulSamples: durations.length,
    timing: durations.length ? { medianMs: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95), rangeMs: { min: Math.min(...durations), max: Math.max(...durations) } } : null,
    rawArtifact,
  };
}

async function invoke(command: string[], cwd: string, workflow: string, cacheState: 'cold' | 'warm', sample: number, contamination?: string): Promise<CommandObservation> {
  const started = process.hrtime.bigint();
  const child = spawn(command[0]!, command.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
  const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveResult, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, exitSignal) => resolveResult({ code: exitCode, signal: exitSignal }));
  });
  const output = Buffer.concat(stdout);
  const error = Buffer.concat(stderr);
  return {
    workflow, cacheState, sample, command, durationMs: Number(process.hrtime.bigint() - started) / 1_000_000,
    exitCode: code, signal,
    stdout: { bytes: output.length, sha256: hash(output), jsonValid: jsonValid(output) },
    stderr: { bytes: error.length, sha256: hash(error), jsonValid: jsonValid(error) },
    peakRss: { classification: 'unmeasured', valueBytes: null, reason: 'Node child_process does not expose a portable per-child peak RSS.' },
    classification: contamination ? 'contaminated' : 'measured',
    ...(contamination ? { contamination } : {}),
  };
}

function cliCommand(options: RunOptions, vault: string, args: string[]): string[] {
  return options.mode === 'built'
    ? [process.execPath, join(options.cwd, 'dist/index.js'), '--vault', vault, ...args]
    : [process.execPath, join(options.cwd, 'node_modules/tsx/dist/cli.mjs'), join(options.cwd, 'src/index.ts'), '--vault', vault, ...args];
}

function workflows(): Array<{ name: string; args: string[]; isolated?: boolean }> {
  return [
    { name: 'version', args: ['--version'] },
    { name: 'schema-list', args: ['schema', 'list', '--output', 'json'] },
    { name: 'list-count', args: ['list', '--count'] },
    { name: 'simple-where', args: ['list', '--type', 'task', '--where', "status == 'active'", '--output', 'json'] },
    { name: 'under', args: ['list', '--type', 'task', '--where', "under(parent, '[[objective-00001]]')", '--output', 'json'] },
    { name: 'frontmatter-sort', args: ['list', '--type', 'task', '--sort', 'deadline', '--output', 'json'] },
    { name: 'file-stat-sort', args: ['list', '--sort', 'file.mtime', '--desc', '--output', 'json'] },
    { name: 'body-search', args: ['list', '--body', 'deterministic benchmark', '--output', 'json'] },
    { name: 'audit-json', args: ['audit', '--output', 'json'] },
    { name: 'bulk-dry-run', args: ['bulk', '--type', 'task', '--where', "status == 'active'", '--set', 'status=done', '--output', 'json'] },
    { name: 'template-new', args: ['--non-interactive', 'template', 'new', 'note', '--name', 'benchmark-template', '--json', '{"description":"benchmark template"}'], isolated: true },
  ];
}

/** Recompute the WP1 fixture checksum; never trust the stored manifest value for drift detection. */
export async function fixtureChecksum(fixture: string): Promise<string> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.push(path);
    }
  }
  await walk(fixture);
  const checksum = createHash('sha256');
  for (const file of files.sort()) {
    if (file === join(fixture, 'fixture-manifest.json')) continue;
    checksum.update(file.slice(fixture.length + 1)).update('\0').update(await readFile(file));
  }
  return checksum.digest('hex');
}

export function fixtureDriftContamination(beforeChecksum: string, afterChecksum: string): string | undefined {
  return beforeChecksum === afterChecksum ? undefined : 'fixture checksum changed during a non-mutating workflow';
}

export async function runBenchmark(options: RunOptions): Promise<BenchmarkReport> {
  if (options.samples < 1 || options.warmRepeats < 0) throw new Error('samples must be at least 1 and warm repeats cannot be negative');
  await rm(options.tempDir, { recursive: true, force: true });
  await mkdir(options.tempDir, { recursive: true });
  await mkdir(options.outDir, { recursive: true });
  const fixture = join(options.tempDir, 'fixture');
  const manifest = await generateFixture(options.profile, fixture);
  const rawJsonl = join(options.outDir, 'benchmark.raw.jsonl');
  await rm(rawJsonl, { force: true });
  const summaries: WorkflowSummary[] = [];
  for (const workflow of workflows()) {
    const observations: CommandObservation[] = [];
    for (const cacheState of ['cold', 'warm'] as const) {
      const repeats = cacheState === 'cold' ? options.samples : options.warmRepeats;
      for (let sample = 1; sample <= repeats; sample += 1) {
        const vault = workflow.isolated ? join(options.tempDir, `fixture-${workflow.name}-${cacheState}-${sample}`) : fixture;
        if (workflow.isolated) await generateFixture(options.profile, vault);
        const beforeChecksum = await fixtureChecksum(vault);
        const observation = await invoke(cliCommand(options, vault, workflow.args), options.cwd, workflow.name, cacheState, sample, options.contamination);
        const afterChecksum = await fixtureChecksum(vault);
        const fixtureContamination = !workflow.isolated ? fixtureDriftContamination(beforeChecksum, afterChecksum) : undefined;
        if (!options.contamination && fixtureContamination) {
          observation.classification = 'contaminated';
          observation.contamination = fixtureContamination;
        }
        await writeFile(rawJsonl, `${JSON.stringify(observation)}\n`, { encoding: 'utf8', flag: 'a' });
        observations.push(observation);
      }
    }
    for (const state of ['cold', 'warm'] as const) {
      const relevant = observations.filter(observation => observation.cacheState === state);
      if (relevant.length) summaries.push(summarizeObservations(relevant, rawJsonl));
    }
  }
  const fullTest = options.fullTestCommand
    ? await runFullTest(options, rawJsonl)
    : { descriptor: 'Optional bounded command: pass --full-test-command "pnpm test -- --exclude=**/*.pty.test.ts"', classification: 'unmeasured' as const, reason: 'No bounded full-test command was supplied.' };
  return {
    format: 1, createdAt: new Date().toISOString(), mode: options.mode, profile: options.profile, samples: options.samples,
    fixture: { path: fixture, manifestPath: join(fixture, 'fixture-manifest.json'), checksum: manifest.checksum, noteCount: manifest.noteCount },
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpuCount: cpus().length, concurrency: 1, peakRss: 'unmeasured' },
    workflows: summaries, rawJsonl, fullTest,
    profileInstructions: [
      '10k list/count profiling is manual by design; do not treat timing output as CPU attribution.',
      `CPU profile for DevTools-compatible tooling: node --cpu-prof --cpu-prof-dir ${resolve(options.outDir, 'cpu-profiles')} dist/index.js --vault ${fixture} list --count (open the generated .cpuprofile in Chrome DevTools or another compatible viewer).`,
      `V8 isolate-log alternative: node --prof --logfile=${resolve(options.outDir, 'isolate-0x...-v8.log')} dist/index.js --vault ${fixture} list --count; inspect with node --prof-process <isolate-log>.`,
    ],
  };
}

async function runFullTest(options: RunOptions, rawJsonl: string): Promise<BenchmarkReport['fullTest']> {
  const observation = await invoke(['sh', '-lc', options.fullTestCommand!], options.cwd, 'full-test-command', 'cold', 1, options.contamination);
  await writeFile(rawJsonl, `${JSON.stringify(observation)}\n`, { encoding: 'utf8', flag: 'a' });
  return { descriptor: options.fullTestCommand!, classification: observation.classification, rawArtifact: rawJsonl };
}

function parseArgs(argv: string[], cwd: string): RunOptions {
  const value = (name: string): string | undefined => { const index = argv.indexOf(name); return index === -1 ? undefined : argv[index + 1]; };
  const profile = (value('--profile') ?? 'realistic') as FixtureProfile;
  const mode = (value('--mode') ?? 'built') as RunnerMode;
  const samples = Number(value('--samples') ?? '10');
  const warmRepeats = Number(value('--warm-repeats') ?? '1');
  const tempDir = value('--temp');
  const outDir = value('--out');
  if (!PROFILES.has(profile) || !['built', 'source'].includes(mode) || !tempDir || !outDir || !Number.isInteger(samples) || !Number.isInteger(warmRepeats)) {
    throw new Error('Usage: pnpm exec tsx tools/bench/run.ts --temp <explicit-directory> --out <explicit-directory> [--profile realistic] [--mode built|source] [--samples 10] [--warm-repeats 1] [--contamination <reason>] [--full-test-command <shell-command>]');
  }
  return { profile, mode, samples, warmRepeats, tempDir: isAbsolute(tempDir) ? tempDir : resolve(cwd, tempDir), outDir: isAbsolute(outDir) ? outDir : resolve(cwd, outDir), contamination: value('--contamination'), fullTestCommand: value('--full-test-command'), cwd };
}

if (process.argv[1]?.endsWith('run.ts')) {
  const cwd = process.cwd();
  const options = parseArgs(process.argv.slice(2), cwd);
  runBenchmark(options).then(async report => {
    const out = join(options.outDir, 'benchmark-report.json');
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ report: out, rawJsonl: report.rawJsonl, workflows: report.workflows.length })}\n`);
  }).catch(error => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; });
}
