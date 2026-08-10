import { Command } from 'commander';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { loadSchema } from '../lib/schema.js';
import { resolveVaultDirWithSelection } from '../lib/vaultSelection.js';
import { getGlobalOpts } from '../lib/command.js';
import { buildVaultNoteSnapshot } from '../lib/discovery.js';
import { buildNoteContent, parseNoteContent, writeFileAtomic } from '../lib/frontmatter.js';
import { assertExpectedRevision, noteRevision } from '../lib/note-revision.js';
import { printJson, jsonError, jsonSuccess } from '../lib/output.js';
import { isValidNoteId, normalizeNoteId } from '../lib/note-id.js';
import { PRIORITY_ALGORITHM, suggestPriorities, type PriorityInput } from '../lib/priority.js';
import { semanticEvidenceRevision } from '../lib/semantic-revision.js';
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
  scope?: { taskIds?: string[] };
  tasks?: PriorityPlanItem[];
}

const execFileAsync = promisify(execFile);

function ordinal(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(numeric) && numeric >= 0 && numeric <= 4 ? numeric : null;
}
function rank(value: unknown): number | null { return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null; }
function validateApprovedFactor(value: ApprovedFactor, field: string, path: string, errors: string[]): void {
  if (value === undefined || value === null) return;
  if (!Number.isInteger(value) || value < 0 || value > 4) errors.push(`${path}: ${field} must be null or an integer from 0 to 4`);
}
function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number); const date = new Date(Date.UTC(year!, month! - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
}
async function registryIdentities(vaultDir: string): Promise<{ byPath: Map<string, string[]>; errors: string[] }> {
  const byPath = new Map<string, string[]>();
  const byId = new Map<string, string[]>();
  const errors: string[] = [];
  const content = await readFile(join(vaultDir, '.bwrb/ids.jsonl'), 'utf8').catch(() => '');
  for (const [index, line] of content.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { id?: unknown; path?: unknown };
      if (typeof row.path !== 'string' || !isValidNoteId(row.id)) { errors.push(`identity registry row ${index + 1} is invalid`); continue; }
      const id = normalizeNoteId(row.id);
      byPath.set(row.path, [...(byPath.get(row.path) ?? []), id]);
      byId.set(id, [...(byId.get(id) ?? []), row.path]);
    } catch { errors.push(`identity registry row ${index + 1} is malformed`); }
  }
  for (const [path, ids] of byPath) if (ids.length !== 1) errors.push(`${path}: duplicate identity registry path`);
  for (const [id, paths] of byId) if (paths.length !== 1) errors.push(`${id}: duplicate identity registry ID`);
  return { byPath, errors };
}
async function readTasks(vaultDir: string): Promise<{ tasks: TaskRecord[]; errors: string[] }> {
  const schema = await loadSchema(vaultDir);
  const snapshot = await buildVaultNoteSnapshot(schema, vaultDir);
  const registry = schema.config.identityStore === 'registry-v1' ? await registryIdentities(vaultDir) : { byPath: new Map<string, string[]>(), errors: [] };
  const seen = new Set<string>(); const errors: string[] = [...registry.errors]; const tasks: TaskRecord[] = [];
  if (schema.config.identityStore === 'frontmatter-v1') {
    const allIds = new Map<string, string[]>();
    for (const note of snapshot.notes) if (isValidNoteId(note.frontmatter?.id)) { const id = normalizeNoteId(note.frontmatter.id); allIds.set(id, [...(allIds.get(id) ?? []), note.relativePath]); }
    for (const [id, paths] of allIds) if (paths.length !== 1) errors.push(`${id}: duplicate frontmatter identity across ${paths.join(', ')}`);
  }
  for (const note of snapshot.notes) {
    const fm = note.frontmatter;
    if (note.resolvedType !== 'task' || !fm || ['done', 'dropped'].includes(String(fm.status ?? ''))) continue;
    const candidates = schema.config.identityStore === 'registry-v1'
      ? (registry.byPath.get(note.relativePath) ?? [])
      : (typeof fm.id === 'string' ? [fm.id] : []);
    if (candidates.length !== 1 || !isValidNoteId(candidates[0])) { errors.push(`${note.relativePath}: missing or ambiguous stable identity`); continue; }
    const id = normalizeNoteId(candidates[0]!);
    if (schema.config.identityStore === 'registry-v1' && typeof fm.id === 'string' && normalizeNoteId(fm.id) !== id) errors.push(`${note.relativePath}: frontmatter identity disagrees with registry`);
    if (seen.has(id)) { errors.push(`${note.relativePath}: duplicate stable identity ${id}`); continue; }
    seen.add(id);
    if (Object.prototype.hasOwnProperty.call(fm, 'importance') && fm.importance !== null && ordinal(fm.importance) === null) errors.push(`${note.relativePath}: importance must be null or an integer from 0 to 4`);
    if (Object.prototype.hasOwnProperty.call(fm, 'excitement') && fm.excitement !== null && ordinal(fm.excitement) === null) errors.push(`${note.relativePath}: excitement must be null or an integer from 0 to 4`);
    const raw = await readFile(note.path, 'utf8');
    tasks.push({ id, path: note.relativePath, rawRevision: noteRevision(raw), revision: semanticEvidenceRevision(raw), importance: ordinal(fm.importance), excitement: ordinal(fm.excitement), deadline: typeof fm.deadline === 'string' ? fm.deadline : null, deadlineKind: typeof fm['deadline-kind'] === 'string' ? fm['deadline-kind'] : null, priorRank: rank(fm['priority-rank']), effectiveRank: rank(fm['priority-rank']), override: fm['priority-override'] === true, reason: typeof fm['priority-reason'] === 'string' ? fm['priority-reason'] : null, algorithm: typeof fm['priority-algorithm'] === 'string' ? fm['priority-algorithm'] : null, asOf: typeof fm['priority-as-of'] === 'string' ? fm['priority-as-of'] : null, basisRevision: typeof fm['priority-basis-revision'] === 'string' ? fm['priority-basis-revision'] : null, reviewed: typeof fm['priority-reviewed'] === 'string' ? fm['priority-reviewed'] : null, approvalId: typeof fm['priority-approval-id'] === 'string' ? fm['priority-approval-id'] : null });
  }
  return { tasks, errors };
}
async function readScopeIds(path: string | undefined): Promise<Set<string> | null> {
  if (!path) return null;
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  const values = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { taskIds?: unknown }).taskIds)
      ? (parsed as { taskIds: unknown[] }).taskIds
      : null;
  if (!values || values.some((value) => typeof value !== 'string' || !isValidNoteId(value))) throw new Error('scope file must be a JSON array of stable task IDs or an object with taskIds');
  const ids = values.map((value) => normalizeNoteId(value as string));
  if (new Set(ids).size !== ids.length) throw new Error('scope file contains duplicate task IDs');
  return new Set(ids);
}
function selectScope(tasks: TaskRecord[], scopeIds: Set<string> | null): { tasks: TaskRecord[]; errors: string[] } {
  if (!scopeIds) return { tasks, errors: [] };
  const liveIds = new Set(tasks.map((task) => task.id));
  const errors = [...scopeIds].filter((id) => !liveIds.has(id)).map((id) => `scope contains unknown or terminal task ${id}`);
  return { tasks: tasks.filter((task) => scopeIds.has(task.id)), errors };
}
function hasCompleteSharedOrder(tasks: TaskRecord[]): boolean {
  const ranks = tasks.map((task) => task.effectiveRank).sort((a, b) => (a ?? 0) - (b ?? 0));
  return ranks.length > 0 && ranks.every((value, index) => value === index + 1);
}
async function assertVaultTransactionWorktree(vaultDir: string, transactionId: string): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(transactionId)) throw new Error('transaction ID is invalid');
  const { stdout } = await execFileAsync('git', ['-C', vaultDir, 'branch', '--show-current']);
  if (stdout.trim() !== `vault-tx/${transactionId}`) throw new Error(`priority approval execute requires isolated branch vault-tx/${transactionId}`);
}
function fail(message: string, data?: unknown): void { printJson(jsonError(message, { data })); process.exitCode = 1; }
function priorityVault(command: Command): Promise<string> {
  return resolveVaultDirWithSelection({ ...getGlobalOpts(command), jsonMode: true });
}

export const priorityCommand = new Command('priority').description('Suggest, validate, and explicitly approve deterministic task priorities');
priorityCommand.command('suggest').requiredOption('--type <type>', 'Task type (task)').requiredOption('--as-of <date>', 'YYYY-MM-DD').option('--ids-file <path>', 'JSON stable-ID scope').option('--output <format>', 'json').addHelpText('after', '\nRead-only: no task files are modified.').action(async (options, command) => {
  if (options.type !== 'task' || !validDate(options.asOf)) return fail('priority suggest requires --type task and a valid --as-of YYYY-MM-DD');
  const vaultDir = await priorityVault(command); const result = await readTasks(vaultDir);
  if (result.errors.length) return fail('Stable identity closure failed', { errors: result.errors });
  const scopeIds = await readScopeIds(options.idsFile); const scoped = selectScope(result.tasks, scopeIds);
  if (scoped.errors.length) return fail('Priority scope resolution failed', { errors: scoped.errors });
  const tasks = suggestPriorities(scoped.tasks, options.asOf).map((task) => ({ ...task, algorithm: PRIORITY_ALGORITHM, effectiveRank: task.effectiveRank, semanticEvidenceRevision: task.revision, explanation: `importance ${(task.importance ?? 2)}*4 + deadline pressure ${task.deadlinePressure}*3 + excitement ${(task.excitement ?? 2)}` }));
  printJson(jsonSuccess({ data: { algorithm: PRIORITY_ALGORITHM, asOf: options.asOf, scopeTaskIds: [...(scopeIds ?? new Set(result.tasks.map((task) => task.id)))], tasks } }));
});
priorityCommand.command('validate').option('--complete', 'Require complete approved metadata for the selected shared-order view').option('--as-of <date>', 'Evaluation date for staleness checks (YYYY-MM-DD)').option('--ids-file <path>', 'JSON stable-ID scope').option('--output <format>', 'json').action(async (options, command) => {
  if (options.complete && !validDate(options.asOf)) return fail('priority validate --complete requires a valid --as-of YYYY-MM-DD');
  const vaultDir = await priorityVault(command); const result = await readTasks(vaultDir); const scopeIds = await readScopeIds(options.idsFile); const scoped = selectScope(result.tasks, scopeIds); const errors = [...result.errors, ...scoped.errors]; const ranks = new Set<number>(); const allRanks = new Set<number>(); const approvalIds = new Set<string>();
  for (const task of result.tasks) if (task.effectiveRank !== null && task.effectiveRank !== undefined) { if (allRanks.has(task.effectiveRank)) errors.push(`${task.path}: duplicate priority-rank ${task.effectiveRank}`); allRanks.add(task.effectiveRank); }
  for (const task of scoped.tasks) {
    if (task.override && !task.reason) errors.push(`${task.path}: priority override requires priority-reason`);
    const effectiveRank = task.effectiveRank;
    if (effectiveRank !== null && effectiveRank !== undefined) ranks.add(effectiveRank);
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
  const orderedRanks = [...allRanks].sort((a, b) => a - b);
  if (options.complete && ranks.size !== scoped.tasks.length) errors.push('every task in the selected scope must have an effective rank');
  if (options.complete && (allRanks.size !== result.tasks.length || orderedRanks.some((value, index) => value !== index + 1))) errors.push('live queue ranks must be unique and contiguous from 1 before any scope is complete');
  if (options.complete && approvalIds.size > 1) errors.push('selected scope must share one approved complete-order receipt');
  if (errors.length) return fail('Priority validation failed', { errors }); printJson(jsonSuccess({ data: { valid: true, scopeTaskIds: scoped.tasks.map((task) => task.id) } }));
});
priorityCommand.command('approve').requiredOption('--json-file <path>', 'Suggestion plan JSON').requiredOption('--approval-id <id>', 'External approval receipt').option('--transaction-id <id>', 'Required isolated vault transaction for execute').option('--execute', 'Apply the approved plan').option('--output <format>', 'json').addHelpText('after', '\nDry-run by default; --execute is required to modify task files and is accepted only in the named vault-tx branch.').action(async (options, command) => {
  const plan = JSON.parse(await readFile(options.jsonFile, 'utf8')) as PriorityPlan;
  if (!options.approvalId || !validDate(plan.asOf) || !Array.isArray(plan.tasks) || !plan.algorithm) return fail('Approval plan requires algorithm, a valid asOf date, and tasks plus --approval-id');
  const vaultDir = await priorityVault(command); const live = await readTasks(vaultDir); if (live.errors.length) return fail('Stable identity closure failed', { errors: live.errors });
  const byId = new Map(live.tasks.map((task) => [task.id, task])); const errors: string[] = []; const planned = new Set<string>();
  const scopeValues = plan.scope?.taskIds; const scopeIds = scopeValues === undefined ? new Set(live.tasks.map((task) => task.id)) : new Set(Array.isArray(scopeValues) ? scopeValues.filter((id) => typeof id === 'string' && isValidNoteId(id)).map(normalizeNoteId) : []);
  if (scopeValues !== undefined && (!Array.isArray(scopeValues) || scopeIds.size !== scopeValues.length || scopeIds.size === 0)) errors.push('plan scope.taskIds must contain unique stable task IDs');
  for (const id of scopeIds) if (!byId.has(id)) errors.push(`plan scope contains unknown or terminal task ${id}`);
  if (plan.algorithm !== PRIORITY_ALGORITHM) errors.push(`plan algorithm ${plan.algorithm} does not match ${PRIORITY_ALGORITHM}`);
  if (plan.tasks.length !== live.tasks.length) errors.push('plan must cover every nonterminal task');
  for (const item of plan.tasks) { const task = byId.get(normalizeNoteId(item.id)); if (!task || task.path !== item.path) errors.push(`unknown or path-mismatched task ${item.id}`); else { if (task.rawRevision !== item.revision) errors.push(`stale raw revision for ${item.path}`); if (task.revision !== item.semanticEvidenceRevision) errors.push(`stale semantic evidence for ${item.path}`); const effectiveOverride = item.override ?? task.override ?? false; const effectiveReason = item.reason !== undefined ? item.reason : task.reason; if (effectiveOverride && !effectiveReason) errors.push(`override requires a reason for ${item.path}`); } if (planned.has(normalizeNoteId(item.id))) errors.push(`duplicate plan id ${item.id}`); planned.add(normalizeNoteId(item.id)); validateApprovedFactor(item.importance, 'importance', item.path, errors); validateApprovedFactor(item.excitement, 'excitement', item.path, errors); }
  const ranks = plan.tasks.map((item) => item.rank).sort((a,b) => a-b); if (ranks.some((value,index) => !Number.isInteger(value) || value !== index + 1)) errors.push('approved ranks must be unique and contiguous');
  const outside = plan.tasks.filter((item) => !scopeIds.has(normalizeNoteId(item.id))); const liveOutside = outside.map((item) => byId.get(normalizeNoteId(item.id))).filter((task): task is TaskRecord => Boolean(task));
  if (outside.length) {
    if (!hasCompleteSharedOrder(live.tasks)) errors.push('scoped approval requires an existing complete shared order; use an everything scope to establish it');
    const before = [...liveOutside].sort((a, b) => a.effectiveRank! - b.effectiveRank!).map((task) => task.id);
    const after = [...outside].sort((a, b) => a.rank - b.rank).map((item) => normalizeNoteId(item.id));
    if (before.join('\0') !== after.join('\0')) errors.push('scoped approval must preserve out-of-scope relative order');
    for (const item of outside) { const task = byId.get(normalizeNoteId(item.id)); if (!task) continue; if (item.importance !== undefined || item.excitement !== undefined || item.override !== undefined || item.reason !== undefined) errors.push(`out-of-scope plan item may carry rank only: ${item.path}`); }
  }
  if (errors.length) return fail('Priority approval preflight failed', { errors });
  if (!options.execute) { printJson(jsonSuccess({ data: { mode: 'dry-run', approvalId: options.approvalId, scopeTaskIds: [...scopeIds], tasks: plan.tasks } })); return; }
  if (!options.transactionId) return fail('Priority approval execute requires --transaction-id');
  try { await assertVaultTransactionWorktree(vaultDir, options.transactionId); } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
  const prepared = [] as Array<{ path: string; before: string; after: string }>;
  for (const item of plan.tasks) { const task = byId.get(normalizeNoteId(item.id))!; const path = join(vaultDir, task.path); const raw = await readFile(path, 'utf8'); assertExpectedRevision(item.revision, raw); const parsed = parseNoteContent(raw); const next: Record<string, unknown> = { ...parsed.frontmatter }; if (item.importance !== undefined) { if (item.importance === null) delete next.importance; else next.importance = item.importance; } if (item.excitement !== undefined) { if (item.excitement === null) delete next.excitement; else next.excitement = item.excitement; } const effectiveOverride = item.override ?? task.override ?? false; const effectiveReason = item.reason !== undefined ? item.reason : task.reason; Object.assign(next, { 'priority-rank': item.rank, 'priority-override': effectiveOverride, 'priority-algorithm': PRIORITY_ALGORITHM, 'priority-as-of': plan.asOf, 'priority-basis-revision': semanticEvidenceRevision(buildNoteContent(next, parsed.body)), 'priority-reviewed': plan.asOf, 'priority-approval-id': options.approvalId }); if (effectiveOverride) next['priority-reason'] = effectiveReason; else delete next['priority-reason']; prepared.push({ path, before: raw, after: buildNoteContent(next, parsed.body) }); }
  const written: Array<{ path: string; before: string }> = [];
  try { for (const mutation of prepared) { await writeFileAtomic(mutation.path, mutation.after); written.push(mutation); } }
  catch (error) { for (const mutation of written.reverse()) await writeFileAtomic(mutation.path, mutation.before); throw error; }
  printJson(jsonSuccess({ data: { mode: 'execute', approvalId: options.approvalId, updated: plan.tasks.map((task) => task.path) } }));
});
