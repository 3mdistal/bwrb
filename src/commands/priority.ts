import { Command } from 'commander';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { loadSchema } from '../lib/schema.js';
import { resolveVaultDirWithSelection } from '../lib/vaultSelection.js';
import { getGlobalOpts } from '../lib/command.js';
import { buildVaultNoteSnapshot } from '../lib/discovery.js';
import { buildNoteContent, parseNoteContent, writeNote } from '../lib/frontmatter.js';
import { assertExpectedRevision, noteRevision } from '../lib/note-revision.js';
import { printJson, jsonError, jsonSuccess } from '../lib/output.js';
import { isValidNoteId, normalizeNoteId } from '../lib/note-id.js';
import { PRIORITY_ALGORITHM, suggestPriorities, type PriorityInput } from '../lib/priority.js';

const PRIORITY_METADATA = new Set([
  'priority-rank',
  'priority-override',
  'priority-reason',
  'priority-algorithm',
  'priority-as-of',
  'priority-basis-revision',
  'priority-reviewed',
  'priority-approval-id',
]);
type TaskRecord = PriorityInput & { path: string; rawRevision: string };
type ApprovedFactor = number | null | undefined;
interface PriorityPlanItem {
  id: string;
  path: string;
  revision: string;
  semanticEvidenceRevision: string;
  rank: number;
  importance?: number | null;
  excitement?: number | null;
  override?: boolean;
  reason?: string | null;
}
interface PriorityPlan {
  algorithm?: string;
  asOf?: string;
  tasks?: PriorityPlanItem[];
}

function ordinal(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(numeric) && numeric >= 0 && numeric <= 4 ? numeric : null;
}
function rank(value: unknown): number | null { return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null; }
function validateApprovedFactor(value: ApprovedFactor, field: string, path: string, errors: string[]): void {
  if (value === undefined || value === null) return;
  if (!Number.isInteger(value) || value < 0 || value > 4) errors.push(`${path}: ${field} must be null or an integer from 0 to 4`);
}
function semanticEvidenceRevision(raw: string): string {
  const parsed = parseNoteContent(raw);
  const evidence = { ...parsed.frontmatter };
  for (const key of PRIORITY_METADATA) delete evidence[key];
  return noteRevision(buildNoteContent(evidence, parsed.body));
}
async function registryIdentities(vaultDir: string): Promise<Map<string, string[]>> {
  const byPath = new Map<string, string[]>();
  const content = await readFile(join(vaultDir, '.bwrb/ids.jsonl'), 'utf8').catch(() => '');
  for (const line of content.split('\n')) {
    try { const row = JSON.parse(line) as { id?: unknown; path?: unknown }; if (typeof row.path === 'string' && isValidNoteId(row.id)) byPath.set(row.path, [...(byPath.get(row.path) ?? []), row.id]); } catch { /* malformed rows do not establish identity */ }
  }
  return byPath;
}
async function readTasks(vaultDir: string): Promise<{ tasks: TaskRecord[]; errors: string[] }> {
  const schema = await loadSchema(vaultDir);
  const snapshot = await buildVaultNoteSnapshot(schema, vaultDir);
  const registry = schema.config.identityStore === 'registry-v1' ? await registryIdentities(vaultDir) : new Map<string, string[]>();
  const seen = new Set<string>(); const errors: string[] = []; const tasks: TaskRecord[] = [];
  for (const note of snapshot.notes) {
    const fm = note.frontmatter;
    if (note.resolvedType !== 'task' || !fm || ['done', 'dropped'].includes(String(fm.status ?? ''))) continue;
    const candidates = typeof fm.id === 'string' ? [fm.id] : (registry.get(note.relativePath) ?? []);
    if (candidates.length !== 1 || !isValidNoteId(candidates[0])) { errors.push(`${note.relativePath}: missing or ambiguous stable identity`); continue; }
    const id = normalizeNoteId(candidates[0]!);
    if (seen.has(id)) { errors.push(`${note.relativePath}: duplicate stable identity ${id}`); continue; }
    seen.add(id); const raw = await readFile(note.path, 'utf8');
    tasks.push({ id, path: note.relativePath, rawRevision: noteRevision(raw), revision: semanticEvidenceRevision(raw), importance: ordinal(fm.importance), excitement: ordinal(fm.excitement), deadline: typeof fm.deadline === 'string' ? fm.deadline : null, deadlineKind: typeof fm['deadline-kind'] === 'string' ? fm['deadline-kind'] : null, priorRank: rank(fm['priority-rank']), effectiveRank: rank(fm['priority-rank']), override: fm['priority-override'] === true, reason: typeof fm['priority-reason'] === 'string' ? fm['priority-reason'] : null, algorithm: typeof fm['priority-algorithm'] === 'string' ? fm['priority-algorithm'] : null, asOf: typeof fm['priority-as-of'] === 'string' ? fm['priority-as-of'] : null, basisRevision: typeof fm['priority-basis-revision'] === 'string' ? fm['priority-basis-revision'] : null, reviewed: typeof fm['priority-reviewed'] === 'string' ? fm['priority-reviewed'] : null, approvalId: typeof fm['priority-approval-id'] === 'string' ? fm['priority-approval-id'] : null });
  }
  return { tasks, errors };
}
function fail(message: string, data?: unknown): void { printJson(jsonError(message, { data })); process.exitCode = 1; }
function priorityVault(command: Command): Promise<string> {
  return resolveVaultDirWithSelection({ ...getGlobalOpts(command), jsonMode: true });
}

export const priorityCommand = new Command('priority').description('Suggest, validate, and explicitly approve deterministic task priorities');
priorityCommand.command('suggest').requiredOption('--type <type>', 'Task type (task)').requiredOption('--as-of <date>', 'YYYY-MM-DD').option('--output <format>', 'json').addHelpText('after', '\nRead-only: no task files are modified.').action(async (options, command) => {
  if (options.type !== 'task' || !/^\d{4}-\d{2}-\d{2}$/.test(options.asOf)) return fail('priority suggest requires --type task and --as-of YYYY-MM-DD');
  const vaultDir = await priorityVault(command); const result = await readTasks(vaultDir);
  if (result.errors.length) return fail('Stable identity closure failed', { errors: result.errors });
  const tasks = suggestPriorities(result.tasks, options.asOf).map((task) => ({ ...task, algorithm: PRIORITY_ALGORITHM, effectiveRank: task.effectiveRank, semanticEvidenceRevision: task.revision, explanation: `importance ${(task.importance ?? 2)}*4 + deadline pressure ${task.deadlinePressure}*3 + excitement ${(task.excitement ?? 2)}` }));
  printJson(jsonSuccess({ data: { algorithm: PRIORITY_ALGORITHM, asOf: options.asOf, tasks } }));
});
priorityCommand.command('validate').option('--complete', 'Require a complete contiguous live queue').option('--as-of <date>', 'Evaluation date for staleness checks (YYYY-MM-DD)').option('--output <format>', 'json').action(async (options, command) => {
  if (options.complete && !/^\d{4}-\d{2}-\d{2}$/.test(options.asOf ?? '')) return fail('priority validate --complete requires --as-of YYYY-MM-DD');
  const vaultDir = await priorityVault(command); const result = await readTasks(vaultDir); const errors = [...result.errors]; const ranks = new Set<number>(); const approvalIds = new Set<string>();
  for (const task of result.tasks) {
    if (task.override && !task.reason) errors.push(`${task.path}: priority override requires priority-reason`);
    const effectiveRank = task.effectiveRank;
    if (effectiveRank !== null && effectiveRank !== undefined) { if (ranks.has(effectiveRank)) errors.push(`${task.path}: duplicate priority-rank ${effectiveRank}`); ranks.add(effectiveRank); }
    if (options.complete) {
      if (!task.algorithm || !task.asOf || !task.basisRevision || !task.reviewed || !task.approvalId) errors.push(`${task.path}: approved priority metadata is incomplete`);
      if (task.approvalId) approvalIds.add(task.approvalId);
      if (task.algorithm !== PRIORITY_ALGORITHM) errors.push(`${task.path}: priority algorithm requires review`);
      if (task.basisRevision !== task.revision) errors.push(`${task.path}: semantic evidence changed after priority approval`);
      const suggestion = suggestPriorities([task], options.asOf)[0]!;
      if (suggestion.staleReasons.includes('as-of')) errors.push(`${task.path}: deadline evaluation date requires review`);
      if (suggestion.staleReasons.includes('review')) errors.push(`${task.path}: subjective priority factors require review`);
    }
  }
  const orderedRanks = [...ranks].sort((a, b) => a - b);
  if (options.complete && (ranks.size !== result.tasks.length || orderedRanks.some((value, index) => value !== index + 1))) errors.push('live queue ranks must be unique and contiguous from 1');
  if (options.complete && approvalIds.size > 1) errors.push('live queue must share one approved complete-order receipt');
  if (errors.length) return fail('Priority validation failed', { errors }); printJson(jsonSuccess({ data: { valid: true } }));
});
priorityCommand.command('approve').requiredOption('--json-file <path>', 'Suggestion plan JSON').requiredOption('--approval-id <id>', 'External approval receipt').option('--execute', 'Apply the approved plan').option('--output <format>', 'json').addHelpText('after', '\nDry-run by default; --execute is required to modify task files.').action(async (options, command) => {
  const plan = JSON.parse(await readFile(options.jsonFile, 'utf8')) as PriorityPlan;
  if (!options.approvalId || !plan.asOf || !Array.isArray(plan.tasks) || !plan.algorithm) return fail('Approval plan requires algorithm, asOf, and tasks plus --approval-id');
  const vaultDir = await priorityVault(command); const live = await readTasks(vaultDir); if (live.errors.length) return fail('Stable identity closure failed', { errors: live.errors });
  const byId = new Map(live.tasks.map((task) => [task.id, task])); const errors: string[] = []; const planned = new Set<string>();
  if (plan.algorithm !== PRIORITY_ALGORITHM) errors.push(`plan algorithm ${plan.algorithm} does not match ${PRIORITY_ALGORITHM}`);
  if (plan.tasks.length !== live.tasks.length) errors.push('plan must cover every nonterminal task');
  for (const item of plan.tasks) { const task = byId.get(normalizeNoteId(item.id)); if (!task || task.path !== item.path) errors.push(`unknown or path-mismatched task ${item.id}`); else { if (task.rawRevision !== item.revision) errors.push(`stale raw revision for ${item.path}`); if (task.revision !== item.semanticEvidenceRevision) errors.push(`stale semantic evidence for ${item.path}`); const effectiveOverride = item.override ?? task.override ?? false; const effectiveReason = item.reason !== undefined ? item.reason : task.reason; if (effectiveOverride && !effectiveReason) errors.push(`override requires a reason for ${item.path}`); } if (planned.has(normalizeNoteId(item.id))) errors.push(`duplicate plan id ${item.id}`); planned.add(normalizeNoteId(item.id)); validateApprovedFactor(item.importance, 'importance', item.path, errors); validateApprovedFactor(item.excitement, 'excitement', item.path, errors); }
  const ranks = plan.tasks.map((item) => item.rank).sort((a,b) => a-b); if (ranks.some((value,index) => !Number.isInteger(value) || value !== index + 1)) errors.push('approved ranks must be unique and contiguous');
  if (errors.length) return fail('Priority approval preflight failed', { errors });
  if (!options.execute) { printJson(jsonSuccess({ data: { mode: 'dry-run', approvalId: options.approvalId, tasks: plan.tasks } })); return; }
  for (const item of plan.tasks) { const task = byId.get(normalizeNoteId(item.id))!; const path = join(vaultDir, task.path); const raw = await readFile(path, 'utf8'); assertExpectedRevision(item.revision, raw); const parsed = parseNoteContent(raw); const next: Record<string, unknown> = { ...parsed.frontmatter }; if (item.importance !== undefined) { if (item.importance === null) delete next.importance; else next.importance = item.importance; } if (item.excitement !== undefined) { if (item.excitement === null) delete next.excitement; else next.excitement = item.excitement; } const effectiveOverride = item.override ?? task.override ?? false; const effectiveReason = item.reason !== undefined ? item.reason : task.reason; Object.assign(next, { 'priority-rank': item.rank, 'priority-override': effectiveOverride, 'priority-algorithm': PRIORITY_ALGORITHM, 'priority-as-of': plan.asOf, 'priority-basis-revision': semanticEvidenceRevision(buildNoteContent(next, parsed.body)), 'priority-reviewed': plan.asOf, 'priority-approval-id': options.approvalId }); if (effectiveOverride) next['priority-reason'] = effectiveReason; else delete next['priority-reason']; await writeNote(path, next, parsed.body); }
  printJson(jsonSuccess({ data: { mode: 'execute', approvalId: options.approvalId, updated: plan.tasks.map((task) => task.path) } }));
});
