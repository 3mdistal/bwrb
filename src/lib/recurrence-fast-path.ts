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
 * The caller has already written the predecessor's new frontmatter to disk.
 * This helper:
 *   1. checks the type recurs and the write transitioned the trigger field
 *      INTO its trigger value (old != trigger, new == trigger),
 *   2. checks the chain field (`next`) is empty (idempotency guard),
 *   3. spawns the successor and writes the predecessor's `next` link back.
 *
 * It is a no-op (and never throws) when the type does not recur or no
 * transition occurred. A spawn failure is surfaced as a thrown error so the
 * command can report it.
 */

import { writeNote } from './frontmatter.js';
import { getFrontmatterOrder, getRecurrenceForType } from './schema.js';
import { getType } from './schema.js';
import {
  CHAIN_NEXT_FIELD,
  isTriggerTransition,
  parseTrigger,
  spawnSuccessor,
} from './recurrence.js';
import type { LoadedSchema } from '../types/schema.js';

export interface FastPathResult {
  /** Path of the spawned successor, if one was created. */
  successorPath: string | null;
}

/**
 * Apply the recurrence fast path after a note write.
 *
 * @param schema - loaded schema
 * @param vaultDir - vault directory
 * @param typeName - resolved type of the written note
 * @param filePath - absolute path of the written (predecessor) note
 * @param oldFrontmatter - frontmatter BEFORE the write (to detect the transition)
 * @param newFrontmatter - frontmatter AFTER the write (now on disk)
 * @param body - the note body (preserved when rewriting the `next` link)
 */
export async function applyRecurrenceFastPath(
  schema: LoadedSchema,
  vaultDir: string,
  typeName: string,
  filePath: string,
  oldFrontmatter: Record<string, unknown>,
  newFrontmatter: Record<string, unknown>,
  body: string
): Promise<FastPathResult> {
  const resolved = getRecurrenceForType(schema, typeName);
  if (!resolved) return { successorPath: null };

  const trigger = parseTrigger(resolved.recurrence.on);
  if (!trigger) return { successorPath: null };

  // Only spawn on a transition INTO the trigger value.
  if (!isTriggerTransition(trigger, oldFrontmatter[trigger.field], newFrontmatter[trigger.field])) {
    return { successorPath: null };
  }

  // Idempotency guard: never spawn if the chain field already points somewhere.
  const chainValue = newFrontmatter[CHAIN_NEXT_FIELD];
  const chainEmpty =
    chainValue === undefined ||
    chainValue === null ||
    (typeof chainValue === 'string' && chainValue.trim() === '') ||
    (Array.isArray(chainValue) && chainValue.length === 0);
  if (!chainEmpty) {
    return { successorPath: null };
  }

  const predecessorName = filePath.split('/').pop()?.replace(/\.md$/, '') ?? '';
  const typeDef = getType(schema, typeName);
  const order = typeDef ? getFrontmatterOrder(typeDef) : undefined;

  const successorPath = await spawnSuccessor(
    schema,
    vaultDir,
    typeName,
    newFrontmatter,
    predecessorName,
    async (nextLink) => {
      // Persist the predecessor's `next` link by rewriting the just-written note.
      const updated = { ...newFrontmatter, [CHAIN_NEXT_FIELD]: nextLink };
      await writeNote(filePath, updated, body, order && order.length > 0 ? order : Object.keys(updated));
    }
  );

  return { successorPath };
}
