import { readdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

type AssertionStatus = 'passed' | 'failed' | 'pending' | 'skipped' | 'todo';

interface VitestAssertion {
  retryCount?: number;
  status: AssertionStatus;
}

interface VitestTestFile {
  assertionResults?: VitestAssertion[];
  name: string;
}

interface VitestJsonResult {
  success?: boolean;
  testResults?: VitestTestFile[];
}

interface Arguments {
  expectedRoot: string;
  expectedShards: number;
  manifest: string;
  results: string;
  shardDir: string;
  summary: string;
}

interface RetryZeroSummary {
  complete: boolean;
  expectedFiles: number;
  failed: number;
  observedFiles: number;
  passed: number;
  pending: number;
  pty: 'skipped';
  ptySkipped: 0;
  ptySupported: 0;
  retried: number;
  retryMode: 'retry-zero';
  shardReports: number;
  skipped: number;
}

interface RetryZeroManifest {
  duplicateFiles: string[];
  expectedFiles: string[];
  expectedShards: number;
  missingFiles: string[];
  observedFiles: string[];
  ptyFiles: string[];
  shardReports: string[];
  unexpectedFiles: string[];
  violations: string[];
}

const testFilePattern = /\.test\.[cm]?[jt]sx?$/;
const ptyTestFilePattern = /\.pty\.test\.[cm]?[jt]sx?$/;

function usage(): string {
  return 'Usage: pnpm health:retry-zero-aggregate -- ' +
    '--results <path> --expected-root <path> --shard-dir <path> --expected-shards <n> ' +
    '--summary <path> --manifest <path>';
}

function readArguments(argv: string[]): Arguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag) throw new Error(usage());
    if (flag === '--') continue;
    if (flag === '--help' || flag === '-h') throw new Error(usage());
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    values.set(flag, value);
  }

  const required = (flag: string): string => {
    const value = values.get(flag);
    if (!value) throw new Error(`Missing required option: ${flag}`);
    return value;
  };
  const expectedShards = Number.parseInt(required('--expected-shards'), 10);
  if (!Number.isSafeInteger(expectedShards) || expectedShards < 1) {
    throw new Error('--expected-shards must be a positive integer');
  }

  return {
    results: required('--results'),
    expectedRoot: required('--expected-root'),
    shardDir: required('--shard-dir'),
    expectedShards,
    summary: required('--summary'),
    manifest: required('--manifest'),
  };
}

const portablePath = (path: string): string => path.split(sep).join('/');

function resultPath(cwd: string, name: string): string {
  const path = name.startsWith('file:') ? fileURLToPath(name) : name;
  return portablePath(relative(cwd, isAbsolute(path) ? path : resolve(cwd, path)));
}

async function discoverTests(directory: string, cwd: string): Promise<string[]> {
  const discovered: string[] = [];
  const visit = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && testFilePattern.test(entry.name) && !ptyTestFilePattern.test(entry.name)) {
        discovered.push(portablePath(relative(cwd, path)));
      }
    }
  };
  await visit(resolve(cwd, directory));
  return discovered.sort();
}

async function discoverShardReports(directory: string, cwd: string): Promise<string[]> {
  const entries = await readdir(resolve(cwd, directory), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.blob'))
    .map((entry) => portablePath(relative(cwd, resolve(cwd, directory, entry.name))))
    .sort();
}

const difference = (left: string[], right: Set<string>): string[] =>
  left.filter((value) => !right.has(value));

export async function aggregateRetryZero(args: Arguments, cwd = process.cwd()): Promise<{
  manifest: RetryZeroManifest;
  summary: RetryZeroSummary;
}> {
  const data = JSON.parse(await readFile(resolve(cwd, args.results), 'utf8')) as VitestJsonResult;
  if (!Array.isArray(data.testResults)) throw new Error('Vitest JSON results do not contain testResults');

  const expectedFiles = await discoverTests(args.expectedRoot, cwd);
  const observed = data.testResults.map((file) => resultPath(cwd, file.name));
  const observedFiles = [...new Set(observed)].sort();
  const duplicateFiles = [...new Set(observed.filter((file, index) => observed.indexOf(file) !== index))].sort();
  const expectedSet = new Set(expectedFiles);
  const observedSet = new Set(observedFiles);
  const missingFiles = difference(expectedFiles, observedSet);
  const unexpectedFiles = difference(observedFiles, expectedSet);
  const ptyFiles = observedFiles.filter((file) => ptyTestFilePattern.test(file));
  const shardReports = await discoverShardReports(args.shardDir, cwd);

  const assertions = data.testResults.flatMap((file) => file.assertionResults ?? []);
  const count = (...statuses: AssertionStatus[]): number =>
    assertions.filter((assertion) => statuses.includes(assertion.status)).length;
  const retried = assertions.filter((assertion) => (assertion.retryCount ?? 0) > 0).length;
  const violations: string[] = [];
  if (shardReports.length !== args.expectedShards) {
    violations.push(`expected ${args.expectedShards} shard reports, found ${shardReports.length}`);
  }
  if (duplicateFiles.length) violations.push(`duplicate test files: ${duplicateFiles.join(', ')}`);
  if (missingFiles.length) violations.push(`missing test files: ${missingFiles.join(', ')}`);
  if (unexpectedFiles.length) violations.push(`unexpected test files: ${unexpectedFiles.join(', ')}`);
  if (ptyFiles.length) violations.push(`PTY files were executed: ${ptyFiles.join(', ')}`);
  if (retried > 0) violations.push(`${retried} assertions recorded retries`);
  if (count('failed') > 0 || data.success !== true) violations.push('merged retry-zero run failed');

  const manifest: RetryZeroManifest = {
    expectedShards: args.expectedShards,
    shardReports,
    expectedFiles,
    observedFiles,
    duplicateFiles,
    missingFiles,
    unexpectedFiles,
    ptyFiles,
    violations,
  };
  const summary: RetryZeroSummary = {
    passed: count('passed'),
    failed: count('failed'),
    skipped: count('skipped'),
    pending: count('pending', 'todo'),
    retried,
    ptySupported: 0,
    ptySkipped: 0,
    retryMode: 'retry-zero',
    pty: 'skipped',
    expectedFiles: expectedFiles.length,
    observedFiles: observedFiles.length,
    shardReports: shardReports.length,
    complete: violations.length === 0,
  };

  await writeFile(resolve(cwd, args.summary), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await writeFile(resolve(cwd, args.manifest), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { manifest, summary };
}

async function main(): Promise<void> {
  const result = await aggregateRetryZero(readArguments(process.argv.slice(2)));
  process.stdout.write(`Retry-zero summary: ${JSON.stringify(result.summary)}\n`);
  if (result.manifest.violations.length) {
    throw new Error(`Retry-zero aggregation failed:\n- ${result.manifest.violations.join('\n- ')}`);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
