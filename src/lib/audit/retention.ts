import { unlink } from 'fs/promises';
import { getRetentionForType, getFieldsForType, resolveTypeFromFrontmatter } from '../schema.js';
import { parseNote, writeNote } from '../frontmatter.js';
import { validateFrontmatter } from '../validation.js';
import { formatLocalDate } from '../local-date.js';
import { withLineageMutationLocks } from '../lineage-lock.js';
import { executeBulkMove, findAllMarkdownFiles, findWikilinksToFile } from '../bulk/move.js';
import { buildVaultNoteSnapshot } from '../discovery.js';
import { assessDeleteLineage } from '../delete-lineage-guard.js';
import { basename, relative } from 'path';
import type { LoadedSchema } from '../../types/schema.js';
import type { FileAuditResult } from './types.js';

type ActionKind = 'archive' | 'tombstone' | 'delete';

function matches(fm: Record<string, unknown>, condition: Record<string, { in: string[] }>): boolean {
  return Object.entries(condition).every(([key, rule]) => typeof fm[key] === 'string' && rule.in.includes(fm[key] as string));
}
function isDue(fm: Record<string, unknown>, retention: NonNullable<ReturnType<typeof getRetentionForType>>, today: string): boolean {
  if (!matches(fm, retention.when) || (retention.resolved_when && matches(fm, retention.resolved_when))) return false;
  const value = fm[retention.clock.field];
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const clock = new Date(`${value}T00:00:00`);
  if (Number.isNaN(clock.getTime())) return false;
  clock.setDate(clock.getDate() + Number(retention.clock.after.slice(0, -1)));
  const due = `${clock.getFullYear()}-${String(clock.getMonth() + 1).padStart(2, '0')}-${String(clock.getDate()).padStart(2, '0')}`;
  return today >= due;
}

/** Explicit retention execution; intentionally separate from ordinary audit auto-fix. */
export async function runRetentionRemediation(args: {
  results: FileAuditResult[]; schema: LoadedSchema; vaultDir: string; action: ActionKind; execute: boolean;
}): Promise<{ attempted: number; applied: number; skipped: number; messages: string[] }> {
  const today = formatLocalDate();
  const candidates = args.results.filter(r => r.issues.some(i => i.code === 'retention-due' && i.meta?.diagnostic !== 'invalid-clock'));
  const messages: string[] = [];
  let applied = 0; let skipped = 0;
  for (const candidate of candidates) {
    const initial = await parseNote(candidate.path);
    const type = resolveTypeFromFrontmatter(args.schema, initial.frontmatter);
    const retention = type ? getRetentionForType(args.schema, type) : undefined;
    const action = retention?.actions.find(item => item.kind === args.action);
    if (!type || !retention || !action || !isDue(initial.frontmatter, retention, today)) { skipped++; messages.push(`${candidate.relativePath}: no longer due or action is not configured`); continue; }
    if (!args.execute) { messages.push(`Would ${args.action} ${candidate.relativePath}`); continue; }
    if (action.kind === 'archive') {
      // The move rewrites backlink source files too, so lock the complete
      // mutation set rather than only the note being archived.
      const allVaultFiles = await findAllMarkdownFiles(args.vaultDir);
      const references = await findWikilinksToFile(args.vaultDir, candidate.path, allVaultFiles);
      await withLineageMutationLocks(args.vaultDir, [candidate.path, ...references.map(reference => reference.sourceFile)], async () => {
        const live = await parseNote(candidate.path);
        const liveType = resolveTypeFromFrontmatter(args.schema, live.frontmatter);
        const liveRetention = liveType ? getRetentionForType(args.schema, liveType) : undefined;
        if (!liveRetention || !isDue(live.frontmatter, liveRetention, today)) { skipped++; messages.push(`${candidate.relativePath}: no longer due`); return; }
        const result = await executeBulkMove({ vaultDir: args.vaultDir, targetDir: action.directory, filesToMove: [candidate.path], execute: true, allVaultFiles });
        if (result.errors.length) { skipped++; messages.push(...result.errors); } else { applied++; messages.push(`Archived ${candidate.relativePath}`); }
      });
      continue;
    }
    await withLineageMutationLocks(args.vaultDir, [candidate.path], async () => {
      const live = await parseNote(candidate.path);
      const liveType = resolveTypeFromFrontmatter(args.schema, live.frontmatter);
      const liveRetention = liveType ? getRetentionForType(args.schema, liveType) : undefined;
      if (!liveType || !liveRetention || !isDue(live.frontmatter, liveRetention, today)) { skipped++; messages.push(`${candidate.relativePath}: no longer due`); return; }
      if (action.kind === 'tombstone') {
        const patch = Object.fromEntries(Object.entries(action.set).map(([key, value]) => [key, value === '$TODAY' ? today : value]));
        const next = { ...live.frontmatter, ...patch };
        const validation = validateFrontmatter(args.schema, liveType, next, { strictFields: true });
        if (!validation.valid) { skipped++; messages.push(`${candidate.relativePath}: tombstone patch invalid: ${validation.errors[0]?.message}`); return; }
        await writeNote(candidate.path, next, live.body, getFieldsForType(args.schema, liveType) ? Object.keys(getFieldsForType(args.schema, liveType)) : undefined);
        applied++; messages.push(`Tombstoned ${candidate.relativePath}`); return;
      }
      const snapshot = await buildVaultNoteSnapshot(args.schema, args.vaultDir);
      const lineage = assessDeleteLineage(snapshot, [candidate.path]);
      const files = await findAllMarkdownFiles(args.vaultDir);
      const links = await findWikilinksToFile(args.vaultDir, candidate.path, files);
      const relationRefs = await findTypedRelationReferences(args.schema, args.vaultDir, candidate.path, files);
      if (lineage.blocked.length || links.length || relationRefs.length) { skipped++; messages.push(`${candidate.relativePath}: refusing delete; live lineage, backlinks, or relations remain`); return; }
      await unlink(candidate.path); applied++; messages.push(`Deleted ${candidate.relativePath}`);
    });
  }
  return { attempted: candidates.length, applied, skipped, messages };
}

/** Conservative relation safety independent of wikilink vs markdown link format. */
async function findTypedRelationReferences(schema: LoadedSchema, vaultDir: string, targetPath: string, files: string[]): Promise<string[]> {
  const targetName = basename(targetPath, '.md');
  const targetRelative = relative(vaultDir, targetPath).replace(/\.md$/, '');
  const references: string[] = [];
  for (const file of files) {
    if (file === targetPath) continue;
    const note = await parseNote(file);
    const type = resolveTypeFromFrontmatter(schema, note.frontmatter);
    if (!type) continue;
    for (const [name, field] of Object.entries(getFieldsForType(schema, type))) {
      if (field.prompt !== 'relation') continue;
      const values = Array.isArray(note.frontmatter[name]) ? note.frontmatter[name] : [note.frontmatter[name]];
      if (values.some(value => typeof value === 'string' && (value.includes(`[[${targetName}`) || value.includes(`[[${targetRelative}`) || value.includes(`](${targetRelative}.md`) || value === targetName || value === targetRelative))) {
        references.push(file);
      }
    }
  }
  return references;
}
