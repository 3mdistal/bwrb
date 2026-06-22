/**
 * Recurrence fast path (#107).
 * ============================
 *
 * The deterministic side-effect that fires when a recurring note is completed
 * THROUGH bwrb (`bwrb edit`, `bwrb bulk --set status=done`). It detects the
 * trigger transition, guards idempotency, and spawns the successor via the
 * shared recurrence engine — so the fast path and the audit backstop produce
 * identical successors.
 *
 * ATOMICITY (#107 blocker): completing a recurring note must be all-or-nothing.
 * The predecessor must never be left `status: done` with no successor because
 * the spawn failed (missing template, unparseable/partial offset base). To
 * guarantee this, the fast path is two-phase:
 *
 *   1. `prepareRecurrenceFastPath` — VALIDATE and COMPUTE the successor (template
 *      exists, trigger transition detected, offset base parses to a real date)
 *      WITHOUT writing anything. Called BEFORE the predecessor's status change is
 *      written. If the successor can't be produced, it throws and the caller
 *      aborts without mutating the predecessor.
 *   2. `commitRecurrenceFastPath` — create the successor and back-link the
 *      predecessor's `next`. Called AFTER the predecessor write has succeeded.
 *
 * It is a no-op when the type does not recur or no transition occurred.
 */

import { writeNote } from './frontmatter.js';
import { getFrontmatterOrder, getRecurrenceForType } from './schema.js';
import { getType } from './schema.js';
import {
  CHAIN_NEXT_FIELD,
  isTriggerTransition,
  parseTrigger,
  prepareSuccessor,
  commitSuccessor,
  type PreparedSuccessor,
} from './recurrence.js';
import type { LoadedSchema } from '../types/schema.js';

export interface FastPathResult {
  /** Path of the spawned successor, if one was created. */
  successorPath: string | null;
}

/**
 * A validated fast-path spawn, ready to commit once the predecessor write has
 * landed. Null `prepared` means "no spawn needed" (no transition / already
 * chained / type doesn't recur) — committing it is a no-op.
 */
export interface PreparedFastPath {
  prepared: PreparedSuccessor | null;
  predecessorName: string;
  order: string[] | undefined;
  filePath: string;
  body: string;
}

/**
 * Phase 1: validate + compute the fast-path successor WITHOUT writing anything.
 *
 * Throws the real, deterministic error (missing template, partial/unparseable
 * offset base) so the caller can abort BEFORE mutating the predecessor.
 *
 * @param schema - loaded schema
 * @param vaultDir - vault directory
 * @param typeName - resolved type of the note being written
 * @param filePath - absolute path of the (predecessor) note
 * @param oldFrontmatter - frontmatter BEFORE the write (to detect the transition)
 * @param newFrontmatter - frontmatter AFTER the write (about to be on disk)
 * @param body - the note body (preserved when rewriting the `next` link)
 */
export async function prepareRecurrenceFastPath(
  schema: LoadedSchema,
  vaultDir: string,
  typeName: string,
  filePath: string,
  oldFrontmatter: Record<string, unknown>,
  newFrontmatter: Record<string, unknown>,
  body: string
): Promise<PreparedFastPath> {
  const predecessorName = filePath.split('/').pop()?.replace(/\.md$/, '') ?? '';
  const typeDef = getType(schema, typeName);
  const orderList = typeDef ? getFrontmatterOrder(typeDef) : undefined;
  const order = orderList && orderList.length > 0 ? orderList : undefined;

  const noop: PreparedFastPath = { prepared: null, predecessorName, order, filePath, body };

  const resolved = getRecurrenceForType(schema, typeName);
  if (!resolved) return noop;

  const trigger = parseTrigger(resolved.recurrence.on);
  if (!trigger) return noop;

  // Only spawn on a transition INTO the trigger value.
  if (!isTriggerTransition(trigger, oldFrontmatter[trigger.field], newFrontmatter[trigger.field])) {
    return noop;
  }

  // Idempotency guard: never spawn if the chain field already points somewhere.
  const chainValue = newFrontmatter[CHAIN_NEXT_FIELD];
  const chainEmpty =
    chainValue === undefined ||
    chainValue === null ||
    (typeof chainValue === 'string' && chainValue.trim() === '') ||
    (Array.isArray(chainValue) && chainValue.length === 0);
  if (!chainEmpty) {
    return noop;
  }

  // Validate + compute WITHOUT writing. Throws on a spawn that cannot succeed
  // (missing template, partial/unparseable offset base) — the caller aborts
  // before mutating the predecessor.
  const prepared = await prepareSuccessor(schema, vaultDir, typeName, newFrontmatter, predecessorName);
  return { prepared, predecessorName, order, filePath, body };
}

/**
 * Phase 2: commit a prepared fast-path spawn — create the successor and write
 * the predecessor's `next` link. Call only AFTER the predecessor write landed.
 * A no-op when nothing was prepared.
 */
export async function commitRecurrenceFastPath(
  schema: LoadedSchema,
  vaultDir: string,
  plan: PreparedFastPath
): Promise<FastPathResult> {
  if (!plan.prepared) return { successorPath: null };

  // The latest predecessor frontmatter is the one just written. Re-read so the
  // `next` link is added on top of the committed status change.
  const { parseNote } = await import('./frontmatter.js');

  const successorPath = await commitSuccessor(
    schema,
    vaultDir,
    plan.predecessorName,
    plan.prepared,
    async (nextLink) => {
      const latest = await parseNote(plan.filePath);
      const updated = { ...latest.frontmatter, [CHAIN_NEXT_FIELD]: nextLink };
      await writeNote(
        plan.filePath,
        updated,
        latest.body,
        plan.order ?? Object.keys(updated)
      );
    }
  );

  return { successorPath };
}
