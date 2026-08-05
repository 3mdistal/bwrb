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
interface TriageRow { id: string; path: string; revision: string; disposition: string; reviewedAt: string; approvalId: string; targetTaskIds?: string[]; reason?: string; }
interface TriagePlan { items?: Array<{ id: string; path: string; revision: string; disposition: string; targetTaskIds?: string[]; reason?: string }>; }

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
async function evidence(vaultDir: string, exactPath: string): Promise<{ id: string; path: string; revision: string }> {
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
  return { id: normalizeNoteId(id), path: exactPath, revision: semanticEvidenceRevision(await readFile(note.path, 'utf8')) };
}
async function ledger(vaultDir: string): Promise<TriageRow[]> {
  const raw = await readFile(join(vaultDir, TRIAGE_LEDGER), 'utf8').catch(() => ''); const rows: TriageRow[] = [];
  for (const [index, line] of raw.split('\n').entries()) { if (!line.trim()) continue; try { const row = JSON.parse(line) as TriageRow; if (!isValidNoteId(row.id) || !row.path || !row.revision || !DISPOSITIONS.has(row.disposition)) throw new Error(); rows.push(row); } catch { throw new Error(`Malformed triage ledger row ${index + 1}`); } }
  return rows;
}
async function appendLedger(vaultDir: string, rows: TriageRow[]): Promise<void> {
  await withNoteIdRegistryLock(vaultDir, async () => {
    const path = join(vaultDir, TRIAGE_LEDGER); await mkdir(dirname(path), { recursive: true });
    const current = await readFile(path, 'utf8').catch(() => ''); const separator = !current || current.endsWith('\n') ? '' : '\n';
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`; const handle = await open(temp, 'wx');
    try { await handle.writeFile(`${current}${separator}${rows.map((row) => JSON.stringify(row)).join('\n')}\n`); await handle.sync(); await handle.close(); await rename(temp, path); }
    finally { await handle.close().catch(() => undefined); await unlink(temp).catch(() => undefined); }
  });
}

export const triageCommand = new Command('triage').description('Inspect and approve revision-bound evidence dispositions');
triageCommand.command('status').requiredOption('--path <path>', 'Exact vault-relative evidence path').option('--output <format>', 'json').action(async (options, command) => {
  try { const vaultDir = await vault(command); const item = await evidence(vaultDir, options.path); const rows = await ledger(vaultDir); const prior = [...rows].reverse().find((row) => normalizeNoteId(row.id) === item.id); const state = !prior ? 'new' : prior.revision === item.revision ? 'triaged' : 'changed'; printJson(jsonSuccess({ data: { ...item, state, prior: prior ?? null } })); }
  catch (error) { fail(error instanceof Error ? error.message : String(error)); }
});
triageCommand.command('approve').requiredOption('--json-file <path>', 'Exact disposition plan JSON').requiredOption('--approval-id <id>', 'External Alice approval receipt').option('--execute', 'Append approved dispositions').option('--output <format>', 'json').action(async (options, command) => {
  try {
    const plan = JSON.parse(await readFile(options.jsonFile, 'utf8')) as TriagePlan;
    if (!Array.isArray(plan.items) || plan.items.length === 0) return fail('Triage approval plan requires non-empty items');
    const vaultDir = await vault(command); const accepted: TriageRow[] = []; const seen = new Set<string>();
    for (const item of plan.items) { if (!DISPOSITIONS.has(item.disposition)) throw new Error(`${item.path}: invalid triage disposition`); if (item.disposition === 'defer' && !item.reason) throw new Error(`${item.path}: defer requires a reason`); const live = await evidence(vaultDir, item.path); if (live.id !== normalizeNoteId(item.id) || live.revision !== item.revision) throw new Error(`${item.path}: identity or evidence revision changed`); if (seen.has(live.id)) throw new Error(`${item.path}: duplicate plan identity`); seen.add(live.id); accepted.push({ ...item, id: live.id, reviewedAt: new Date().toISOString(), approvalId: options.approvalId }); }
    if (!options.execute) return printJson(jsonSuccess({ data: { mode: 'dry-run', approvalId: options.approvalId, items: accepted } }));
    await appendLedger(vaultDir, accepted); printJson(jsonSuccess({ data: { mode: 'execute', approvalId: options.approvalId, items: accepted } }));
  } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
});
