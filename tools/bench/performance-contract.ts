import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { generateFixture, type FixtureProfile } from './generate-fixtures.js';

type ContractProfile = Extract<FixtureProfile, 'teenylilthoughts-analogue-5k' | 'teenylilthoughts-analogue'>;
type ScenarioName = 'absolute-path-edit' | 'exact-name-edit' | 'list-count';

export interface ContractObservation {
  scenario: ScenarioName;
  profile: ContractProfile;
  sample: number;
  command: string[];
  totalMs: number;
  mutationObservedMs: number | null;
  firstOutputMs: number | null;
  closeMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: { bytes: number; sha256: string; jsonValid: boolean; valid: boolean; expected: 'json' | 'count' };
  stderr: { bytes: number; sha256: string };
  peakRss: { classification: 'measured' | 'unmeasured'; valueBytes: number | null; reason?: string };
  fixture: { beforeChecksum: string; afterChecksum: string; expectedMutation: boolean; integrityValid: boolean };
  target?: { path: string; beforeSha256: string; afterSha256: string; changed: boolean };
}

export interface ScenarioSummary {
  scenario: string;
  samples: number;
  successfulSamples: number;
  totalMs: TimingSummary | null;
  mutationToFirstOutputMs: TimingSummary | null;
  firstOutputToCloseMs: TimingSummary | null;
  peakRssBytes: TimingSummary | null;
  budget: { target: string; met: boolean | null; observed: number | null; reason?: string };
  phaseBudgets: {
    mutationToFirstOutput: { target: string; met: boolean | null; observed: number | null; reason?: string };
    firstOutputToClose: { target: string; met: boolean | null; observed: number | null; reason?: string };
  };
}

export interface PerformanceContractReport {
  format: 1;
  createdAt: string;
  commit: string;
  executable: { node: string; nodeVersion: string; cli: string; mode: 'built' };
  environment: { platform: NodeJS.Platform; arch: string; cpuCount: number; contention: string };
  fixtures: Array<{ profile: ContractProfile; path: string; noteCount: number; initialChecksum: string }>;
  scenarios: ScenarioSummary[];
  parallel: { processes: 4; profile: ContractProfile; totalMs: number; complete: boolean; observations: ContractObservation[]; budget: { target: string; met: boolean | null; observed: number | null; reason?: string } };
  rawJsonl: string;
  phaseInstrumentation: 'unavailable: production command instrumentation does not expose startup/schema/discovery/etc phase boundaries';
}

export interface PerformanceContractOptions {
  tempDir: string;
  outDir: string;
  cwd: string;
  samples: number;
  contention: string;
  nodePath?: string;
}

const profiles: ContractProfile[] = ['teenylilthoughts-analogue-5k', 'teenylilthoughts-analogue'];
const scenarios: Array<{ name: ScenarioName; targetIndex: number; mutation: boolean }> = [
  { name: 'absolute-path-edit', targetIndex: 2, mutation: true },
  { name: 'exact-name-edit', targetIndex: 9, mutation: true },
  { name: 'list-count', targetIndex: 0, mutation: false },
];

function sha256(value: Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function jsonValid(value: Buffer): boolean { try { JSON.parse(value.toString('utf8')); return true; } catch { return false; } }
function stdoutValidity(scenario: ScenarioName, value: Buffer): { jsonValid: boolean; valid: boolean; expected: 'json' | 'count' } {
  const parsed = jsonValid(value);
  return scenario === 'list-count'
    ? { jsonValid: parsed, valid: /^\d+\n$/.test(value.toString('utf8')), expected: 'count' }
    : { jsonValid: parsed, valid: parsed, expected: 'json' };
}
function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}
export interface TimingSummary { median: number; p95: number; min: number; max: number; }
export function summarizeTimings(values: Array<number | null>): TimingSummary | null {
  const measured = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return measured.length ? { median: percentile(measured, 0.5)!, p95: percentile(measured, 0.95)!, min: Math.min(...measured), max: Math.max(...measured) } : null;
}
/** A deliberately small schema guard for consumers reading durable JSON artifacts. */
export function validatePerformanceContractReport(value: unknown): value is PerformanceContractReport {
  if (!value || typeof value !== 'object') return false;
  const report = value as Partial<PerformanceContractReport>;
  return report.format === 1
    && typeof report.commit === 'string'
    && !!report.executable && report.executable.mode === 'built' && isAbsolute(report.executable.node) && isAbsolute(report.executable.cli)
    && Array.isArray(report.fixtures) && report.fixtures.every(fixture => fixture.noteCount === 5_000 || fixture.noteCount === 10_000)
    && Array.isArray(report.scenarios) && report.scenarios.length === 6
    && report.parallel?.processes === 4
    && typeof report.rawJsonl === 'string'
    && report.phaseInstrumentation === 'unavailable: production command instrumentation does not expose startup/schema/discovery/etc phase boundaries';
}

export async function fixtureChecksum(fixture: string): Promise<string> {
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      // Concurrent edits legitimately create and remove these runtime locks.
      // They are not fixture content and cannot participate in a stable checksum.
      if (path === join(fixture, '.bwrb', 'locks')) continue;
      if (entry.isDirectory()) await walk(path); else files.push(path);
    }
  }
  await walk(fixture);
  const checksum = createHash('sha256');
  for (const file of files.sort()) {
    if (file === join(fixture, 'fixture-manifest.json')) continue;
    try { checksum.update(file.slice(fixture.length + 1)).update('\0').update(await readFile(file)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return checksum.digest('hex');
}

function targetPath(fixture: string, index: number): string {
  const shard = String(index % 12).padStart(2, '0');
  return join(fixture, 'Objectives', 'Tasks', `Area-${shard}`, `Sprint-${Math.floor(index / 120)}`, `task-${String(index).padStart(5, '0')}.md`);
}
function command(options: PerformanceContractOptions, fixture: string, scenario: typeof scenarios[number]): string[] {
  const node = options.nodePath ?? process.execPath;
  const cli = resolve(options.cwd, 'dist/index.js');
  if (scenario.name === 'list-count') return [node, cli, '--vault', fixture, 'list', '--count'];
  const target = targetPath(fixture, scenario.targetIndex);
  // A basename is the command's unambiguous exact-name path. The generated
  // frontmatter display name includes a shared type word and deliberately
  // exercises fuzzy ambiguity instead.
  const query = scenario.name === 'absolute-path-edit' ? target : `task-${String(scenario.targetIndex).padStart(5, '0')}`;
  return [node, cli, '--vault', fixture, 'edit', query, '--json', '{"status":"done"}', '--output', 'json'];
}

async function invoke(options: PerformanceContractOptions, fixture: string, profile: ContractProfile, scenario: typeof scenarios[number], sample: number): Promise<ContractObservation> {
  const commandLine = command(options, fixture, scenario);
  const target = scenario.mutation ? targetPath(fixture, scenario.targetIndex) : undefined;
  const beforeTarget = target ? await readFile(target) : undefined;
  const beforeChecksum = await fixtureChecksum(fixture);
  const started = process.hrtime.bigint();
  let mutationObservedMs: number | null = null;
  let active = true;
  const monitor = target && beforeTarget ? setInterval(() => {
    if (!active || mutationObservedMs !== null) return;
    readFile(target).then(value => {
      if (mutationObservedMs === null && !value.equals(beforeTarget)) mutationObservedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    }).catch(() => undefined);
  }, 5) : undefined;
  const timeOutput = process.platform === 'darwin' ? join(options.outDir, `.time-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`) : undefined;
  const launched = timeOutput ? ['/usr/bin/time', '-l', '-o', timeOutput, ...commandLine] : commandLine;
  const child = spawn(launched[0]!, launched.slice(1), { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout: Buffer[] = []; const stderr: Buffer[] = []; let firstOutputMs: number | null = null;
  child.stdout.on('data', chunk => { if (firstOutputMs === null) firstOutputMs = Number(process.hrtime.bigint() - started) / 1_000_000; stdout.push(Buffer.from(chunk)); });
  child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
  const exited = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => done({ code, signal }));
  });
  const timeText = timeOutput ? await readFile(timeOutput, 'utf8') : undefined;
  if (timeOutput) await rm(timeOutput, { force: true });
  const rssMatch = timeText?.match(/\s(\d+)\s+maximum resident set size/);
  active = false; if (monitor) clearInterval(monitor);
  const closeMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  const afterTarget = target ? await readFile(target) : undefined;
  const afterChecksum = await fixtureChecksum(fixture);
  const changed = target && beforeTarget && afterTarget ? !beforeTarget.equals(afterTarget) : false;
  return {
    scenario: scenario.name, profile, sample, command: commandLine, totalMs: closeMs, mutationObservedMs, firstOutputMs, closeMs,
    exitCode: exited.code, signal: exited.signal,
    stdout: { bytes: Buffer.concat(stdout).length, sha256: sha256(Buffer.concat(stdout)), ...stdoutValidity(scenario.name, Buffer.concat(stdout)) },
    stderr: { bytes: Buffer.concat(stderr).length, sha256: sha256(Buffer.concat(stderr)) },
    peakRss: rssMatch ? { classification: 'measured', valueBytes: Number(rssMatch[1]!) } : { classification: 'unmeasured', valueBytes: null, reason: timeOutput ? 'macOS time output did not include maximum resident set size.' : 'Peak RSS is only measured by this harness on macOS with /usr/bin/time -l.' },
    fixture: { beforeChecksum, afterChecksum, expectedMutation: scenario.mutation, integrityValid: scenario.mutation ? beforeChecksum !== afterChecksum && changed : beforeChecksum === afterChecksum },
    ...(target && beforeTarget && afterTarget ? { target: { path: target, beforeSha256: sha256(beforeTarget), afterSha256: sha256(afterTarget), changed } } : {}),
  };
}

function summary(scenario: ScenarioName, observations: ContractObservation[]): ScenarioSummary {
  const success = observations.filter(item => item.exitCode === 0 && item.stdout.valid && item.fixture.integrityValid);
  const total = summarizeTimings(success.map(item => item.totalMs));
  // A polling observer can prove a mutation occurred, but cannot timestamp its
  // exact syscall. Do not turn that lower-bound observation into a fake phase.
  const mutationToFirst = null;
  const firstOutputToClose = summarizeTimings(success.map(item => item.firstOutputMs !== null ? item.closeMs - item.firstOutputMs : null));
  const rss = summarizeTimings(success.map(item => item.peakRss.valueBytes));
  const limit = scenario === 'absolute-path-edit' ? 1000 : scenario === 'exact-name-edit' ? 2000 : 3000;
  return {
    scenario, samples: observations.length, successfulSamples: success.length, totalMs: total, mutationToFirstOutputMs: mutationToFirst, firstOutputToCloseMs: firstOutputToClose, peakRssBytes: rss,
    budget: total ? { target: `p95 under ${limit} ms`, met: total.p95 < limit, observed: total.p95 } : { target: `p95 under ${limit} ms`, met: null, observed: null, reason: 'No valid successful observations.' },
    phaseBudgets: {
      mutationToFirstOutput: { target: 'under 100 ms', met: null, observed: null, reason: 'Mutation is observed by 5 ms polling, not instrumented at the write boundary.' },
      firstOutputToClose: firstOutputToClose ? { target: 'p95 under 100 ms', met: firstOutputToClose.p95 < 100, observed: firstOutputToClose.p95 } : { target: 'p95 under 100 ms', met: null, observed: null, reason: 'No valid first-output observations.' },
    },
  };
}

async function commit(cwd: string): Promise<string> {
  const child = spawn('git', ['rev-parse', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
  const chunks: Buffer[] = []; child.stdout.on('data', chunk => chunks.push(Buffer.from(chunk)));
  await new Promise<void>((done, reject) => { child.once('error', reject); child.once('close', () => done()); });
  return Buffer.concat(chunks).toString('utf8').trim();
}
async function executableVersion(node: string, cwd: string): Promise<string> {
  const child = spawn(node, ['--version'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
  const chunks: Buffer[] = []; child.stdout.on('data', chunk => chunks.push(Buffer.from(chunk)));
  const result = await new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('close', code => done(code)); });
  if (result !== 0) throw new Error(`Could not read Node version from ${node}.`);
  return Buffer.concat(chunks).toString('utf8').trim();
}

export async function runPerformanceContract(options: PerformanceContractOptions): Promise<PerformanceContractReport> {
  if (!Number.isInteger(options.samples) || options.samples < 1) throw new Error('samples must be a positive integer');
  const node = resolve(options.nodePath ?? process.execPath);
  if (!isAbsolute(node) || !isAbsolute(resolve(options.cwd, 'dist/index.js'))) throw new Error('The Node executable and built CLI must be absolute paths.');
  const nodeVersion = await executableVersion(node, options.cwd);
  if (!nodeVersion.startsWith('v22.')) throw new Error(`WP7.4 product measurements require Node 22; found ${nodeVersion}.`);
  await rm(options.tempDir, { recursive: true, force: true }); await rm(options.outDir, { recursive: true, force: true });
  await mkdir(options.tempDir, { recursive: true }); await mkdir(options.outDir, { recursive: true });
  const rawJsonl = join(options.outDir, 'performance-contract.raw.jsonl');
  const fixtures: PerformanceContractReport['fixtures'] = [];
  const all: ContractObservation[] = [];
  for (const profile of profiles) {
    const base = join(options.tempDir, profile);
    const manifest = await generateFixture(profile, base);
    fixtures.push({ profile, path: base, noteCount: manifest.noteCount, initialChecksum: await fixtureChecksum(base) });
    for (const scenario of scenarios) for (let sample = 1; sample <= options.samples; sample += 1) {
      const fixture = join(options.tempDir, `${profile}-${scenario.name}-${sample}`);
      await cp(base, fixture, { recursive: true });
      const observation = await invoke(options, fixture, profile, scenario, sample);
      all.push(observation); await writeFile(rawJsonl, `${JSON.stringify(observation)}\n`, { encoding: 'utf8', flag: 'a' });
    }
  }
  const parallelFixture = join(options.tempDir, 'parallel');
  const parallelBase = join(options.tempDir, 'teenylilthoughts-analogue');
  await cp(parallelBase, parallelFixture, { recursive: true });
  const parallelStarted = process.hrtime.bigint();
  const parallelObservations = await Promise.all([2, 9, 16, 23].map((index, sample) => invoke(options, parallelFixture, 'teenylilthoughts-analogue', { name: 'absolute-path-edit', targetIndex: index, mutation: true }, sample + 1)));
  const parallelTotalMs = Number(process.hrtime.bigint() - parallelStarted) / 1_000_000;
  for (const observation of parallelObservations) await writeFile(rawJsonl, `${JSON.stringify({ ...observation, invocation: 'four-process-parallel' })}\n`, { encoding: 'utf8', flag: 'a' });
  const parallelComplete = parallelObservations.every(item => item.exitCode === 0 && item.stdout.valid && item.fixture.integrityValid);
  const report: PerformanceContractReport = {
    format: 1, createdAt: new Date().toISOString(), commit: await commit(options.cwd),
    executable: { node, nodeVersion, cli: resolve(options.cwd, 'dist/index.js'), mode: 'built' },
    environment: { platform: process.platform, arch: process.arch, cpuCount: cpus().length, contention: options.contention }, fixtures,
    scenarios: scenarios.flatMap(scenario => profiles.map(profile => ({ ...summary(scenario.name, all.filter(item => item.scenario === scenario.name && item.profile === profile)), scenario: `${profile}:${scenario.name}` }))),
    parallel: { processes: 4, profile: 'teenylilthoughts-analogue', totalMs: parallelTotalMs, complete: parallelComplete, observations: parallelObservations, budget: parallelComplete ? { target: 'all complete under 8000 ms', met: parallelTotalMs < 8000, observed: parallelTotalMs } : { target: 'all complete under 8000 ms', met: null, observed: null, reason: 'One or more parallel observations failed integrity or output validation.' } },
    rawJsonl, phaseInstrumentation: 'unavailable: production command instrumentation does not expose startup/schema/discovery/etc phase boundaries',
  };
  await writeFile(join(options.outDir, 'performance-contract-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (!validatePerformanceContractReport(report)) throw new Error('Internal error: performance contract report failed its schema guard.');
  return report;
}

function parseArgs(argv: string[], cwd: string): PerformanceContractOptions {
  const value = (name: string): string | undefined => { const index = argv.indexOf(name); return index === -1 ? undefined : argv[index + 1]; };
  const temp = value('--temp'); const out = value('--out'); const samples = Number(value('--samples') ?? '3'); const contention = value('--contention') ?? 'unspecified'; const nodePath = value('--node');
  if (!temp || !out || !Number.isInteger(samples)) throw new Error('Usage: pnpm bench:contract -- --temp <absolute-directory> --out <absolute-directory> [--samples 3] [--contention isolated|shared] [--node <absolute-node22-path>]');
  return { tempDir: isAbsolute(temp) ? temp : resolve(cwd, temp), outDir: isAbsolute(out) ? out : resolve(cwd, out), cwd, samples, contention, ...(nodePath ? { nodePath: isAbsolute(nodePath) ? nodePath : resolve(cwd, nodePath) } : {}) };
}

if (process.argv[1]?.endsWith('performance-contract.ts')) {
  const options = parseArgs(process.argv.slice(2), process.cwd());
  runPerformanceContract(options).then(report => process.stdout.write(`${JSON.stringify({ report: join(options.outDir, 'performance-contract-report.json'), rawJsonl: report.rawJsonl })}\n`)).catch(error => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; });
}
