import { randomUUID } from 'crypto';
import { mkdir, open, readFile, rename, unlink } from 'fs/promises';
import { dirname, join } from 'path';
import { Command } from 'commander';
import { getGlobalOpts } from '../lib/command.js';
import { buildVaultNoteSnapshot } from '../lib/discovery.js';
import { isValidNoteId, normalizeNoteId, withNoteIdRegistryLock } from '../lib/note-id.js';
import { semanticEvidenceRevision } from '../lib/semantic-revision.js';
import { jsonError, jsonSuccess, printJson } from '../lib/output.js';
import { loadSchema } from '../lib/schema.js';
import { resolveVaultDirWithSelection } from '../lib/vaultSelection.js';

const TRIAGE_LEDGER = '.bwrb/triage.jsonl';
const DISPOSITIONS = new Set(['baseline', 'no-action', 'link-existing', 'update-existing', 'create-task', 'defer']);
interface TriageTarget { id: string; path: string; revision: string; }
interface TriageRow { id: string; path: string; revision: string; disposition: string; reviewedAt: string; approvalId: string; targets?: TriageTarget[]; reason?: string; }
interface TriagePlan { items?: Array<{ id: string; path: string; revision: string; disposition: string; targets?: TriageTarget[]; reason?: string }>; }

function fail(message: string, data?: unknown): void { printJson(jsonError(message, { data })); process.exitCode = 1; }
async function vault(command: Command): Promise<string> { return resolveVaultDirWithSelection({ ...getGlobalOpts(command), jsonMode: true }); }
async function registry(vaultDir: string): Promise<{ byPath: Map<string, string>; errors: string[] }> {
  const byPath = new Map<string, string>(); const byId = new Map<string, string>(); const errors: string[] = [];
  const raw = await readFile(join(vaultDir, '.bwrb/ids.jsonl'), 'utf8').catch(() => '');
  for (const [index, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { id?: unknown; path?: unknown };
      if (!isValidNoteId(row.id) || typeof row.path !== 'string') { errors.push(`identity registry row ${index + 1} is invalid`); continue; }
      const id = normalizeNoteId(row.id);
      if (byPath.has(row.path)) errors.push(`${row.path}: duplicate identity registry path`);
      if (byId.has(id)) errors.push(`${id}: duplicate identity registry ID`);
      byPath.set(row.path, id); byId.set(id, row.path);
    } catch { errors.push(`identity registry row ${index + 1} is malformed`); }
  }
  return { byPath, errors };
}
async function evidence(vaultDir: string, exactPath: string): Promise<{ id: string; path: string; revision: string; type: string }> {
  const schema = await loadSchema(vaultDir); const snapshot = await buildVaultNoteSnapshot(schema, vaultDir);
  const note = snapshot.notes.find((candidate) => candidate.relativePath === exactPath);
  if (!note?.frontmatter) throw new Error(`No readable managed note at ${exactPath}`);
  let id: string | undefined;
  if (schema.config.identityStore === 'registry-v1') {
    const state = await registry(vaultDir); if (state.errors.length) throw new Error(`Stable identity closure failed: ${state.errors.join('; ')}`);
    id = state.byPath.get(exactPath);
    if (typeof note.frontmatter.id === 'string' && id && normalizeNoteId(note.frontmatter.id) !== id) throw new Error(`${exactPath}: frontmatter identity disagrees with registry`);
  } else if (isValidNoteId(note.frontmatter.id)) id = normalizeNoteId(note.frontmatter.id);
  if (!id || !isValidNoteId(id)) throw new Error(`${exactPath}: missing stable identity`);
  return { id: normalizeNoteId(id), path: exactPath, revision: semanticEvidenceRevision(await readFile(note.path, 'utf8')), type: note.resolvedType ?? '' };
}
function validTimestamp(value: unknown): value is string { return typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value; }
function validTargets(value: unknown): value is TriageTarget[] { return Array.isArray(value) && value.every((target) => target && typeof target === 'object' && isValidNoteId((target as TriageTarget).id) && typeof (target as TriageTarget).path === 'string' && typeof (target as TriageTarget).revision === 'string' && (target as TriageTarget).revision.length > 0); }
async function ledger(vaultDir: string): Promise<TriageRow[]> {
  const raw = await readFile(join(vaultDir, TRIAGE_LEDGER), 'utf8').catch(() => ''); const rows: TriageRow[] = [];
  for (const [index, line] of raw.split('\n').entries()) { if (!line.trim()) continue; try { const row = JSON.parse(line) as TriageRow; if (!isValidNoteId(row.id) || !row.path || !row.revision || !DISPOSITIONS.has(row.disposition) || !row.approvalId || !validTimestamp(row.reviewedAt) || (row.targets !== undefined && !validTargets(row.targets)) || (row.disposition === 'defer' && !row.reason)) throw new Error(); rows.push(row); } catch { throw new Error(`Malformed triage ledger row ${index + 1}`); } }
  return rows;
}
async function appendLedgerUnlocked(vaultDir: string, rows: TriageRow[]): Promise<void> {
  const path = join(vaultDir, TRIAGE_LEDGER); await mkdir(dirname(path), { recursive: true });
  const current = await readFile(path, 'utf8').catch(() => ''); const separator = !current || current.endsWith('\n') ? '' : '\n';
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`; const handle = await open(temp, 'wx');
  try { await handle.writeFile(`${current}${separator}${rows.map((row) => JSON.stringify(row)).join('\n')}\n`); await handle.sync(); await handle.close(); await rename(temp, path); }
  finally { await handle.close().catch(() => undefined); await unlink(temp).catch(() => undefined); }
}

export const triageCommand = new Command('triage').description('Inspect and approve revision-bound evidence dispositions');
triageCommand.command('validate').option('--output <format>', 'json').action(async (_options, command) => {
  try {
    const vaultDir = await vault(command); const rows = await ledger(vaultDir);
    for (const row of rows) { const live = await evidence(vaultDir, row.path); if (live.id !== normalizeNoteId(row.id)) throw new Error(`${row.path}: triage ledger identity disagrees with live evidence`); for (const target of row.targets ?? []) { const liveTarget = await evidence(vaultDir, target.path); if (liveTarget.type !== 'task' || liveTarget.id !== normalizeNoteId(target.id)) throw new Error(`${row.path}: triage target identity is invalid`); } }
    printJson(jsonSuccess({ data: { valid: true, rows: rows.length } }));
  } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
});
triageCommand.command('status').requiredOption('--path <path>', 'Exact vault-relative evidence path').option('--output <format>', 'json').action(async (options, command) => {
  try { const vaultDir = await vault(command); const item = await evidence(vaultDir, options.path); const rows = await ledger(vaultDir); const prior = [...rows].reverse().find((row) => normalizeNoteId(row.id) === item.id); const state = !prior ? 'new' : prior.path === item.path && prior.revision === item.revision ? 'triaged' : 'changed'; printJson(jsonSuccess({ data: { ...item, state, prior: prior ?? null } })); }
  catch (error) { fail(error instanceof Error ? error.message : String(error)); }
});
triageCommand.command('approve').requiredOption('--json-file <path>', 'Exact disposition plan JSON').requiredOption('--approval-id <id>', 'External Alice approval receipt').option('--execute', 'Append approved dispositions').option('--output <format>', 'json').action(async (options, command) => {
  try {
    const plan = JSON.parse(await readFile(options.jsonFile, 'utf8')) as TriagePlan;
    if (!options.approvalId || !Array.isArray(plan.items) || plan.items.length === 0) return fail('Triage approval requires non-empty items and --approval-id');
    const vaultDir = await vault(command); const accepted: TriageRow[] = []; const seen = new Set<string>();
    for (const item of plan.items) { if (!DISPOSITIONS.has(item.disposition)) throw new Error(`${item.path}: invalid triage disposition`); if (item.disposition === 'defer' && !item.reason) throw new Error(`${item.path}: defer requires a reason`); const needsTargets = ['link-existing', 'update-existing', 'create-task'].includes(item.disposition); if (needsTargets && (!validTargets(item.targets) || item.targets.length === 0)) throw new Error(`${item.path}: ${item.disposition} requires exact target task identities and revisions`); if (!needsTargets && item.targets !== undefined && !validTargets(item.targets)) throw new Error(`${item.path}: invalid target bindings`); const live = await evidence(vaultDir, item.path); if (live.id !== normalizeNoteId(item.id) || live.revision !== item.revision) throw new Error(`${item.path}: identity or evidence revision changed`); for (const target of item.targets ?? []) { const liveTarget = await evidence(vaultDir, target.path); if (liveTarget.type !== 'task' || liveTarget.id !== normalizeNoteId(target.id) || liveTarget.revision !== target.revision) throw new Error(`${item.path}: target task identity or revision changed`); } if (seen.has(live.id)) throw new Error(`${item.path}: duplicate plan identity`); seen.add(live.id); accepted.push({ ...item, id: live.id, reviewedAt: new Date().toISOString(), approvalId: options.approvalId }); }
    if (!options.execute) return printJson(jsonSuccess({ data: { mode: 'dry-run', approvalId: options.approvalId, items: accepted } }));
    await withNoteIdRegistryLock(vaultDir, async () => { for (const row of accepted) { const live = await evidence(vaultDir, row.path); if (live.id !== row.id || live.revision !== row.revision) throw new Error(`${row.path}: evidence changed before ledger write`); for (const target of row.targets ?? []) { const liveTarget = await evidence(vaultDir, target.path); if (liveTarget.type !== 'task' || liveTarget.id !== normalizeNoteId(target.id) || liveTarget.revision !== target.revision) throw new Error(`${row.path}: target changed before ledger write`); } } await appendLedgerUnlocked(vaultDir, accepted); });
    for (const row of accepted) { const live = await evidence(vaultDir, row.path); if (live.id !== row.id || live.revision !== row.revision) throw new Error(`${row.path}: evidence changed during ledger write; disposition is stale and review remains open`); }
    printJson(jsonSuccess({ data: { mode: 'execute', approvalId: options.approvalId, items: accepted } }));
  } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
});
