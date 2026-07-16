import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { basename, join, relative } from 'path';
import { z } from 'zod';
import type { AttemptLoop, LoadedSchema } from '../types/schema.js';
import { createNoteFromJson } from '../commands/new/json-mode.js';
import { editNoteFromJson } from './edit.js';
import { parseNote } from './frontmatter.js';
import { generateWikilink, type ManagedFile, type NoteIndex } from './navigation.js';
import { assertExpectedRevision, noteRevision } from './note-revision.js';
import { resolveTypeFromFrontmatter, validateAttemptLoopContract } from './schema.js';
import { withOwnershipFileLock } from './lineage-lock.js';

const MAX_ATTEMPT_OUTPUT_BYTES = 64 * 1024;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const ATTEMPT_ATTESTATION_FIELDS = {
  workflow: 'workflow',
  runId: 'run-id',
  iteration: 'iteration',
  idempotencyKey: 'idempotency-key',
  happened: 'happened',
  failed: 'failed',
  baseline: 'baseline',
  observed: 'observed',
  tokensUsed: 'tokens-used',
  outcome: 'outcome',
} as const;

export const AttemptOutputSchema = z.object({
  happened: z.string().min(1),
  failed: z.string().min(1).nullable(),
  baseline: z.number().finite(),
  observed: z.number().finite(),
  tokens_used: z.number().int().min(0),
}).strict();

export type AttemptOutput = z.infer<typeof AttemptOutputSchema>;

export type AttemptStopReason =
  | 'criterion-accepted'
  | 'max-iterations-reached'
  | 'wall-clock-budget-reached'
  | 'token-budget-reached'
  | 'token-budget-exceeded'
  | 'attempt-process-failed'
  | 'attempt-timed-out'
  | 'invalid-attestation';

export interface AttemptRecord extends AttemptOutput {
  iteration: number;
  idempotencyKey: string;
  outcome: 'accepted' | 'retry';
  path: string;
  reused: boolean;
}

export interface AttemptLoopResult {
  accepted: boolean;
  stopReason: AttemptStopReason;
  runId: string;
  attempts: AttemptRecord[];
  tokensUsed: number;
  terminalPath: string;
  terminalRevision: string;
  idempotentReplay: boolean;
  process?: { exitCode: number | null; signal: NodeJS.Signals | null; stderr: string };
}

export interface RunAttemptLoopOptions {
  schema: LoadedSchema;
  vaultDir: string;
  workflow: ManagedFile;
  index: NoteIndex;
  workflowType: string;
  policy: AttemptLoop;
  expectedRevision: string;
  runId: string;
  command: string;
  args: string[];
}

interface ProcessResult {
  kind: 'success' | 'failed' | 'timeout' | 'invalid';
  attestation?: AttemptOutput;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  detail?: string;
}

export async function runAttemptLoop(options: RunAttemptLoopOptions): Promise<AttemptLoopResult> {
  if (!RUN_ID_PATTERN.test(options.runId)) {
    throw new Error('Run ID must be 1-128 characters using letters, numbers, dot, underscore, or hyphen.');
  }
  const contractErrors = validateAttemptLoopContract(options.schema, options.workflowType, options.policy);
  if (contractErrors.length > 0) throw new Error(`Invalid attempt-loop contract: ${contractErrors.join(' ')}`);

  const lockDigest = createHash('sha256').update(options.workflow.relativePath.normalize('NFC').toLowerCase()).digest('hex');
  const lockPath = join(options.vaultDir, '.bwrb', 'locks', `attempt-loop-${lockDigest}.lock`);
  return withOwnershipFileLock(
    lockPath,
    () => runAttemptLoopLocked(options),
    {},
    'Timed out waiting for this workflow attempt loop; another runner may still own it.'
  );
}

async function runAttemptLoopLocked(options: RunAttemptLoopOptions): Promise<AttemptLoopResult> {
  const initial = await parseNote(options.workflow.path);
  const terminal = options.policy.terminal;
  const storedRunId = initial.frontmatter[terminal.run_id_field];
  const storedStatus = initial.frontmatter[terminal.status_field];
  if (
    storedRunId === options.runId &&
    (storedStatus === terminal.accepted_value || storedStatus === terminal.failed_value)
  ) {
    const attempts = await findExistingAttempts(options);
    attempts.sort((left, right) => left.iteration - right.iteration);
    assertStoredAttemptSequence(attempts, options.policy);
    return {
      accepted: storedStatus === terminal.accepted_value,
      stopReason: parseStoredStopReason(initial.frontmatter[terminal.stop_reason_field]),
      runId: options.runId,
      attempts,
      tokensUsed: attempts.reduce((sum, attempt) => sum + attempt.tokens_used, 0),
      terminalPath: relative(options.vaultDir, options.workflow.path),
      terminalRevision: noteRevision(initial.raw),
      idempotentReplay: true,
    };
  }
  if (typeof storedRunId === 'string' && storedRunId !== '' && storedRunId !== options.runId) {
    throw new Error(`Workflow already records run '${storedRunId}'. Clear it explicitly before starting a different run.`);
  }
  assertExpectedRevision(options.expectedRevision, initial.raw);

  const startedAt = Date.now();
  const attempts = await findExistingAttempts(options);
  attempts.sort((left, right) => left.iteration - right.iteration);
  assertStoredAttemptSequence(attempts, options.policy);
  let tokensUsed = attempts.reduce((sum, attempt) => sum + attempt.tokens_used, 0);

  for (const existing of attempts) {
    if (existing.outcome === 'accepted') {
      return finalize(options, attempts, tokensUsed, true, 'criterion-accepted', true);
    }
    if (tokensUsed > options.policy.limits.max_tokens) {
      return finalize(options, attempts, tokensUsed, false, 'token-budget-exceeded', true);
    }
  }

  for (let iteration = attempts.length + 1; iteration <= options.policy.limits.max_iterations; iteration++) {
    const elapsedMs = Date.now() - startedAt;
    const remainingMs = options.policy.limits.max_seconds * 1000 - elapsedMs;
    if (remainingMs <= 0) return finalize(options, attempts, tokensUsed, false, 'wall-clock-budget-reached', false);
    const remainingTokens = options.policy.limits.max_tokens - tokensUsed;
    if (remainingTokens <= 0) return finalize(options, attempts, tokensUsed, false, 'token-budget-reached', false);

    const processResult = await runAttemptProcess(
      options.command,
      options.args,
      options.vaultDir,
      Math.max(1, remainingMs),
      {
        BWRB_ATTEMPT_WORKFLOW: options.workflow.relativePath,
        BWRB_ATTEMPT_RUN_ID: options.runId,
        BWRB_ATTEMPT_ITERATION: String(iteration),
        BWRB_ATTEMPT_REMAINING_SECONDS: String(Math.max(1, Math.floor(remainingMs / 1000))),
        BWRB_ATTEMPT_REMAINING_TOKENS: String(remainingTokens),
      }
    );
    if (processResult.kind !== 'success' || !processResult.attestation) {
      const reason: AttemptStopReason = processResult.kind === 'timeout'
        ? 'attempt-timed-out'
        : processResult.kind === 'invalid'
          ? 'invalid-attestation'
          : 'attempt-process-failed';
      return finalize(options, attempts, tokensUsed, false, reason, false, processResult);
    }

    const evidence = processResult.attestation;
    const accepted = evidence.tokens_used <= remainingTokens && evidence.failed === null && meetsAcceptance(evidence.observed, options.policy);
    const idempotencyKey = `${options.runId}:${iteration}`;
    const record = await createAttestation(options, iteration, idempotencyKey, evidence, accepted);
    attempts.push(record);
    tokensUsed += evidence.tokens_used;

    if (tokensUsed > options.policy.limits.max_tokens) {
      return finalize(options, attempts, tokensUsed, false, 'token-budget-exceeded', false);
    }
    if (Date.now() - startedAt >= options.policy.limits.max_seconds * 1000) {
      return finalize(options, attempts, tokensUsed, false, 'wall-clock-budget-reached', false);
    }
    if (accepted) return finalize(options, attempts, tokensUsed, true, 'criterion-accepted', false);
  }

  return finalize(options, attempts, tokensUsed, false, 'max-iterations-reached', false);
}

function meetsAcceptance(observed: number, policy: AttemptLoop): boolean {
  return policy.acceptance.operator === 'gte'
    ? observed >= policy.acceptance.threshold
    : observed <= policy.acceptance.threshold;
}

async function createAttestation(
  options: RunAttemptLoopOptions,
  iteration: number,
  idempotencyKey: string,
  evidence: AttemptOutput,
  accepted: boolean
): Promise<AttemptRecord> {
  const workflowLink = generateWikilink(options.index, options.workflow);
  const workflowName = basename(options.workflow.path, '.md');
  const input = {
    name: `${workflowName} ${options.runId.slice(0, 40)} attempt ${iteration}`,
    [ATTEMPT_ATTESTATION_FIELDS.workflow]: workflowLink,
    [ATTEMPT_ATTESTATION_FIELDS.runId]: options.runId,
    [ATTEMPT_ATTESTATION_FIELDS.iteration]: iteration,
    [ATTEMPT_ATTESTATION_FIELDS.idempotencyKey]: idempotencyKey,
    [ATTEMPT_ATTESTATION_FIELDS.happened]: evidence.happened,
    [ATTEMPT_ATTESTATION_FIELDS.failed]: evidence.failed ?? '',
    [ATTEMPT_ATTESTATION_FIELDS.baseline]: evidence.baseline,
    [ATTEMPT_ATTESTATION_FIELDS.observed]: evidence.observed,
    [ATTEMPT_ATTESTATION_FIELDS.tokensUsed]: evidence.tokens_used,
    [ATTEMPT_ATTESTATION_FIELDS.outcome]: accepted ? 'accepted' : 'retry',
  };
  const created = await createNoteFromJson(
    options.schema,
    options.vaultDir,
    options.policy.attestation_type,
    JSON.stringify(input),
    null,
    { noInstances: true }
  );
  return {
    ...evidence,
    iteration,
    idempotencyKey,
    outcome: accepted ? 'accepted' : 'retry',
    path: relative(options.vaultDir, created.path),
    reused: false,
  };
}

async function findExistingAttempts(options: RunAttemptLoopOptions): Promise<AttemptRecord[]> {
  const records: AttemptRecord[] = [];
  for (const file of options.index.allFiles) {
    const note = await parseNote(file.path).catch(() => null);
    if (!note || resolveTypeFromFrontmatter(options.schema, note.frontmatter) !== options.policy.attestation_type) continue;
    if (note.frontmatter[ATTEMPT_ATTESTATION_FIELDS.runId] !== options.runId) continue;
    const workflowValue = note.frontmatter[ATTEMPT_ATTESTATION_FIELDS.workflow];
    if (workflowValue !== generateWikilink(options.index, options.workflow)) continue;
    const parsed = storedAttemptSchema.safeParse({
      happened: note.frontmatter[ATTEMPT_ATTESTATION_FIELDS.happened],
      failed: note.frontmatter[ATTEMPT_ATTESTATION_FIELDS.failed] || null,
      baseline: note.frontmatter[ATTEMPT_ATTESTATION_FIELDS.baseline],
      observed: note.frontmatter[ATTEMPT_ATTESTATION_FIELDS.observed],
      tokens_used: note.frontmatter[ATTEMPT_ATTESTATION_FIELDS.tokensUsed],
      iteration: note.frontmatter[ATTEMPT_ATTESTATION_FIELDS.iteration],
      idempotencyKey: note.frontmatter[ATTEMPT_ATTESTATION_FIELDS.idempotencyKey],
      outcome: note.frontmatter[ATTEMPT_ATTESTATION_FIELDS.outcome],
    });
    if (!parsed.success) throw new Error(`Stored attempt attestation is invalid: ${relative(options.vaultDir, file.path)}.`);
    if (parsed.data.idempotencyKey !== `${options.runId}:${parsed.data.iteration}`) {
      throw new Error(`Stored attempt idempotency key is invalid: ${relative(options.vaultDir, file.path)}.`);
    }
    records.push({ ...parsed.data, path: relative(options.vaultDir, file.path), reused: true });
  }
  return records;
}

const storedAttemptSchema = AttemptOutputSchema.extend({
  iteration: z.number().int().min(1),
  idempotencyKey: z.string().min(1),
  outcome: z.enum(['accepted', 'retry']),
});

function assertStoredAttemptSequence(attempts: AttemptRecord[], policy: AttemptLoop): void {
  let tokensUsed = 0;
  for (let index = 0; index < attempts.length; index++) {
    const attempt = attempts[index]!;
    if (attempt.iteration !== index + 1) {
      throw new Error(`Stored attempts are not contiguous at iteration ${index + 1}; refusing to guess which attempt comes next.`);
    }
    if (attempts.filter((item) => item.idempotencyKey === attempt.idempotencyKey).length !== 1) {
      throw new Error(`Duplicate idempotency key '${attempt.idempotencyKey}' found; refusing to execute another attempt.`);
    }
    const remainingTokens = policy.limits.max_tokens - tokensUsed;
    const shouldAccept = attempt.tokens_used <= remainingTokens
      && attempt.failed === null
      && meetsAcceptance(attempt.observed, policy);
    if ((attempt.outcome === 'accepted') !== shouldAccept) {
      throw new Error(`Stored attempt outcome disagrees with the configured acceptance rule: ${attempt.path}.`);
    }
    if (attempt.outcome === 'accepted' && index !== attempts.length - 1) {
      throw new Error(`Stored attempts continue after accepted evidence: ${attempt.path}.`);
    }
    tokensUsed += attempt.tokens_used;
  }
}

async function finalize(
  options: RunAttemptLoopOptions,
  attempts: AttemptRecord[],
  tokensUsed: number,
  accepted: boolean,
  stopReason: AttemptStopReason,
  idempotentReplay: boolean,
  processResult?: ProcessResult
): Promise<AttemptLoopResult> {
  const terminal = options.policy.terminal;
  const edit = await editNoteFromJson(
    options.schema,
    options.vaultDir,
    options.workflow.path,
    JSON.stringify({
      [terminal.status_field]: accepted ? terminal.accepted_value : terminal.failed_value,
      [terminal.stop_reason_field]: stopReason,
      [terminal.run_id_field]: options.runId,
    }),
    { jsonMode: false, expectedRevision: options.expectedRevision }
  );
  return {
    accepted,
    stopReason,
    runId: options.runId,
    attempts,
    tokensUsed,
    terminalPath: relative(options.vaultDir, options.workflow.path),
    terminalRevision: edit.revision,
    idempotentReplay,
    ...(processResult ? {
      process: {
        exitCode: processResult.exitCode,
        signal: processResult.signal,
        stderr: processResult.detail ? `${processResult.stderr}\n${processResult.detail}`.trim() : processResult.stderr,
      },
    } : {}),
  };
}

function parseStoredStopReason(value: unknown): AttemptStopReason {
  const parsed = z.enum([
    'criterion-accepted',
    'max-iterations-reached',
    'wall-clock-budget-reached',
    'token-budget-reached',
    'token-budget-exceeded',
    'attempt-process-failed',
    'attempt-timed-out',
    'invalid-attestation',
  ]).safeParse(value);
  if (!parsed.success) throw new Error('Terminal workflow has an unknown attempt-loop stop reason.');
  return parsed.data;
}

async function runAttemptProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  environment: Record<string, string>
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      shell: false,
      cwd,
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let overflow = false;
    let timedOut = false;
    const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
      const next = Buffer.concat([current, chunk]);
      if (next.length > MAX_ATTEMPT_OUTPUT_BYTES) {
        overflow = true;
        return next.subarray(0, MAX_ATTEMPT_OUTPUT_BYTES);
      }
      return next;
    };
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const terminate = (): void => {
      timedOut = true;
      if (process.platform === 'win32') child.kill('SIGKILL');
      else {
        try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const timer = setTimeout(terminate, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ kind: 'failed', exitCode: null, signal: null, stderr: stderr.toString('utf8'), detail: error.message });
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      const stderrText = stderr.toString('utf8').trim();
      if (timedOut) return resolve({ kind: 'timeout', exitCode, signal, stderr: stderrText });
      if (overflow) return resolve({ kind: 'invalid', exitCode, signal, stderr: stderrText, detail: 'Attempt output exceeded 64 KiB.' });
      if (exitCode !== 0) return resolve({ kind: 'failed', exitCode, signal, stderr: stderrText });
      let raw: unknown;
      try { raw = JSON.parse(stdout.toString('utf8').trim()); }
      catch (error) {
        return resolve({ kind: 'invalid', exitCode, signal, stderr: stderrText, detail: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}` });
      }
      const parsed = AttemptOutputSchema.safeParse(raw);
      if (!parsed.success) return resolve({ kind: 'invalid', exitCode, signal, stderr: stderrText, detail: parsed.error.issues.map(issue => issue.message).join('; ') });
      resolve({ kind: 'success', attestation: parsed.data, exitCode, signal, stderr: stderrText });
    });
  });
}
