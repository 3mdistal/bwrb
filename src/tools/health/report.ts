import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  collectHealthRunHeader,
  createHealthReport,
  createHealthResult,
  healthCheckIds,
  isHealthCheckId,
  isHealthResultClassification,
  type HealthResultClassification,
} from '../../lib/health-report.js';

interface Arguments {
  check?: string;
  status?: 'passed' | 'failed' | 'not-run';
  classification: HealthResultClassification;
  attempts: number;
  fixture: string;
  retryMode: string;
  workers: number | null;
  pty: 'available' | 'unavailable' | 'skipped' | 'not-applicable';
  rawArtifacts: string[];
  contamination?: string;
  out?: string;
}

function usage(): string {
  return `Usage: pnpm health:report -- [options]\n\n` +
    `Without --check, emits an unmeasured template for every standard check.\n` +
    `--check ${healthCheckIds().join('|')}\n` +
    `--status passed|failed|not-run\n` +
    `--classification measured|inferred|unmeasured|skipped|retried|contaminated\n` +
    `--fixture <identity> --retry-mode <mode> --workers <n>\n` +
    `--pty available|unavailable|skipped|not-applicable\n` +
    `--raw-artifact <path> (repeatable) --attempts <n> --contamination <reason> --out <path>`;
}

function readArguments(argv: string[]): Arguments {
  const args: Arguments = {
    classification: 'unmeasured', attempts: 1, fixture: 'not-applicable', retryMode: 'not-recorded',
    workers: null, pty: 'not-applicable', rawArtifacts: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--') continue;
    if (flag === '--help' || flag === '-h') throw new Error(usage());
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    switch (flag) {
      case '--check': args.check = value; break;
      case '--status':
        if (!['passed', 'failed', 'not-run'].includes(value)) throw new Error(`Invalid status: ${value}`);
        args.status = value as NonNullable<Arguments['status']>;
        break;
      case '--classification':
        if (!isHealthResultClassification(value)) throw new Error(`Invalid classification: ${value}`);
        args.classification = value;
        break;
      case '--fixture': args.fixture = value; break;
      case '--retry-mode': args.retryMode = value; break;
      case '--workers': args.workers = Number.parseInt(value, 10); break;
      case '--pty':
        if (!['available', 'unavailable', 'skipped', 'not-applicable'].includes(value)) throw new Error(`Invalid PTY state: ${value}`);
        args.pty = value as Arguments['pty'];
        break;
      case '--raw-artifact': args.rawArtifacts.push(value); break;
      case '--attempts': args.attempts = Number.parseInt(value, 10); break;
      case '--contamination': args.contamination = value; break;
      case '--out': args.out = value; break;
      default: throw new Error(`Unknown option: ${flag}`);
    }
  }
  if (!Number.isSafeInteger(args.attempts) || args.attempts < 1) throw new Error('--attempts must be a positive integer');
  if (args.workers !== null && (!Number.isSafeInteger(args.workers) || args.workers < 1)) throw new Error('--workers must be a positive integer');
  return args;
}

async function main(): Promise<void> {
  const args = readArguments(process.argv.slice(2));
  if (args.check && !isHealthCheckId(args.check)) throw new Error(`Invalid health check: ${args.check}`);
  const run = await collectHealthRunHeader({
    cwd: process.cwd(), fixture: args.fixture, retryMode: args.retryMode, workerCount: args.workers,
    pty: args.pty, rawArtifactPaths: args.rawArtifacts,
  });
  const checks = args.check ? [args.check as Parameters<typeof createHealthResult>[0]['check']] : healthCheckIds();
  const results = checks.map(check => createHealthResult({
    check,
    status: args.check ? (args.status ?? (args.classification === 'unmeasured' || args.classification === 'skipped' ? 'not-run' : 'passed')) : 'not-run',
    classification: args.check ? args.classification : 'unmeasured',
    attempts: args.check ? args.attempts : 0,
    ...(args.check && args.contamination ? { contamination: args.contamination } : {}),
  }));
  const serialized = `${JSON.stringify(createHealthReport(run, results), null, 2)}\n`;
  if (args.out) {
    await mkdir(dirname(args.out), { recursive: true });
    await writeFile(args.out, serialized, 'utf8');
  }
  else process.stdout.write(serialized);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
