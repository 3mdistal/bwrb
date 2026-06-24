/**
 * Audit fix operations.
 * 
 * This module handles applying fixes to audit issues.
 */

import chalk from 'chalk';
import { readFile, writeFile, unlink } from 'fs/promises';
import { join, dirname, basename } from 'path';
import { parseDocument, isMap, isSeq, isScalar } from 'yaml';
import type { YAMLSeq } from 'yaml';
import { isDeepStrictEqual } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  getType,
  getFieldsForType,
  resolveTypeFromFrontmatter,
  getDiscriminatorFieldsFromTypePath,
  getOptionsForField,
  getConcreteTypeNames,
  getTypeFamilies,
  getDescendants,
} from '../schema.js';
import { coerceBooleanFromString, coerceNumberFromString } from './coercion.js';
import { suggestIsoDate } from './date-suggest.js';
import {
  getExpectedScalarType,
  getScalarCoercion,
  getScalarFromList,
  getScalarToList,
  getUnambiguousDateNormalization,
  isCanonicalIsoDate,
} from './fix-policy.js';
import { parseNote, writeNote, generateBodySections } from '../frontmatter.js';
import { levenshteinDistance } from '../levenshtein.js';
import { promptSelection, promptConfirm, promptInput } from '../prompt.js';
import type { LoadedSchema, Field, BodySection } from '../../types/schema.js';
import {
  findAllMarkdownFiles,
  findWikilinksToFile,
  executeBulkMove,
  type WikilinkReference,
} from '../bulk/move.js';
import { formatValue } from '../vault.js';
import { buildNoteTargetIndex, type NoteTargetIndex } from '../discovery.js';
import { BacklinkScanner } from './backlink-index.js';
import { isBwrbBuiltinFrontmatterField } from '../frontmatter/systemFields.js';

// Alias for backward compatibility
const resolveTypePathFromFrontmatter = resolveTypeFromFrontmatter;
const getTypeDefByPath = getType;
import {
  type AuditIssue,
  type FileAuditResult,
  type FixResult,
  type FixSummary,
  type FixContext,
} from './types.js';
import { toMarkdownLink, toWikilink } from '../links.js';
import { spawnSuccessor, needsSuccessor, CHAIN_NEXT_FIELD } from '../recurrence.js';
import { maskNonProse } from './unlinked-mention.js';
import { isBodySectionPresent } from './body-sections.js';
import {
  readStructuralFrontmatterFromRaw,
  movePrimaryBlockToTop,
  replacePrimaryYaml,
  getAllPairsForKey,
  getLastPairForKey,
  getStringSequenceItem,
} from './structural.js';
import {
  splitLinesPreserveEol,
  parseSimpleYamlKeyValueLine,
  isBlockScalarHeader,
} from './raw.js';
import { extractYamlNodeValue, isEffectivelyEmpty } from './value-utils.js';
import {
  getAutoUnknownFieldMigrationTarget,
  getSimilarFieldCandidates,
  getExpectedFieldShape,
  getValueShape,
} from './unknown-field.js';

// ============================================================================
// Helpers
// ============================================================================

function maybeUnquoteFormattedLink(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    trimmed.startsWith('"') &&
    trimmed.endsWith('"') &&
    trimmed.includes('[[') &&
    trimmed.includes(']]')
  ) {
    return trimmed.slice(1, -1);
  }
  return value;
}

const dryRunStorage = new AsyncLocalStorage<boolean>();

function isDryRunEnabled(): boolean {
  return dryRunStorage.getStore() ?? false;
}

/**
 * A list entry that the `invalid-list-element` remover is allowed to drop:
 * `null`/`undefined` or a whitespace-only string. Mirrors the blank/empty
 * detection in checkInvalidListElements (detection.ts) so the fixer only ever
 * removes the entries that detection flagged for removal — never distinct
 * content (#683).
 */
function isBlankListEntry(entry: unknown): boolean {
  if (entry === null || entry === undefined) return true;
  return typeof entry === 'string' && entry.trim().length === 0;
}

function registerManualReview(
  list: { file: string; issue: AuditIssue }[],
  file: string,
  issue: AuditIssue
): void {
  if (
    list.some(
      (entry) =>
        entry.file === file &&
        entry.issue.code === issue.code &&
        entry.issue.field === issue.field &&
        entry.issue.message === issue.message
    )
  ) {
    return;
  }

  list.push({ file, issue });
}


/**
 * Apply an `unlinked-mention` auto-fix: rewrite the first unlinked, word-bounded
 * occurrence of the mention surface in the body to a wikilink.
 *
 * The fix re-derives the target position from the live body (rather than a
 * stored offset) so it stays correct when multiple mentions in the same file are
 * fixed sequentially — each call re-reads and converges on the next occurrence.
 * Only exact/alias (auto-fixable) mentions reach here; fuzzy/ambiguous mentions
 * are flag-only and never dispatched to a fix.
 */
async function applyUnlinkedMentionFix(
  schema: LoadedSchema,
  filePath: string,
  issue: AuditIssue
): Promise<FixResult> {
  const surface = (issue.meta?.['surface'] as string | undefined) ?? (typeof issue.value === 'string' ? issue.value : undefined);
  const replacement = issue.meta?.['replacement'] as string | undefined;
  if (!surface || !replacement) {
    return { file: filePath, issue, action: 'failed', message: 'Missing mention surface/replacement' };
  }

  const parsed = await parseNote(filePath);
  const body = parsed.body;

  // Mask non-prose regions so we never relink inside code/links/existing
  // wikilinks, then find the first word-bounded occurrence of the surface.
  const masked = maskNonProse(body);
  const re = new RegExp(`(?<![\\w'])${escapeRegExp(surface)}(?![\\w'])`, 'g');
  let match: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    // Confirm the original (unmasked) text at this position is the exact surface.
    if (body.slice(m.index, m.index + surface.length) === surface) {
      match = m;
      break;
    }
  }

  if (!match) {
    return { file: filePath, issue, action: 'skipped', message: `Mention '${surface}' no longer present as plain text` };
  }

  const newBody =
    body.slice(0, match.index) + replacement + body.slice(match.index + surface.length);

  const typePath = resolveTypePathFromFrontmatter(schema, parsed.frontmatter);
  const typeDef = typePath ? getTypeDefByPath(schema, typePath) : undefined;
  const order = typeDef?.fieldOrder;

  if (!isDryRunEnabled()) {
    await writeNote(filePath, parsed.frontmatter, newBody, order);
  }

  return { file: filePath, issue, action: 'fixed' };
}

/**
 * Find a declared body section by title anywhere in a (possibly nested) section
 * tree. Returns the full `BodySection` so the fix can regenerate the canonical
 * scaffold (heading + content_type placeholder), not just a bare heading line.
 */
function findBodySectionByTitle(
  sections: BodySection[],
  title: string
): BodySection | undefined {
  for (const section of sections) {
    if (section.title === title) return section;
    if (section.children && section.children.length > 0) {
      const found = findBodySectionByTitle(section.children, title);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Apply a `missing-body-section` auto-fix (#510): append the declared heading
 * section (with its canonical content-type placeholder) to the end of the body.
 *
 * Deterministic and additive — it only appends the missing heading using the
 * SAME `generateBodySections` scaffold that `new`/`edit` emit, so it never
 * deletes or rewrites existing prose. Re-reads + re-checks before writing so the
 * fix is idempotent (a now-present heading is skipped, never duplicated).
 */
async function applyBodySectionFix(
  schema: LoadedSchema,
  filePath: string,
  issue: AuditIssue
): Promise<FixResult> {
  const title = issue.meta?.['title'] as string | undefined;
  const level = (issue.meta?.['level'] as number | undefined) ?? 2;
  if (!title) {
    return { file: filePath, issue, action: 'failed', message: 'Missing section title' };
  }

  const parsed = await parseNote(filePath);
  const typePath = resolveTypePathFromFrontmatter(schema, parsed.frontmatter);
  const typeDef = typePath ? getTypeDefByPath(schema, typePath) : undefined;
  if (!typeDef) {
    return { file: filePath, issue, action: 'failed', message: 'Could not resolve note type' };
  }

  const section = findBodySectionByTitle(typeDef.bodySections, title);
  if (!section) {
    return {
      file: filePath,
      issue,
      action: 'skipped',
      message: `Section "${title}" no longer declared in schema`,
    };
  }

  // Idempotency: skip if the heading is already present at its declared level.
  if (isBodySectionPresent(parsed.body, section.level ?? level, title)) {
    return {
      file: filePath,
      issue,
      action: 'skipped',
      message: `Section "${title}" already present`,
    };
  }

  // Append just this section (without its children — children get their own
  // issues/fixes), using the canonical scaffold.
  const sectionScaffold = generateBodySections([{ ...section, children: undefined }]);
  const existing = parsed.body.replace(/\s*$/, '');
  const newBody = existing.length > 0
    ? `${existing}\n\n${sectionScaffold}`
    : sectionScaffold;

  const order = typeDef.fieldOrder;
  if (!isDryRunEnabled()) {
    await writeNote(filePath, parsed.frontmatter, newBody, order);
  }

  return { file: filePath, issue, action: 'fixed' };
}

/**
 * Apply a `missing-successor` auto-fix (#107): spawn the missing successor for a
 * recurring note completed outside bwrb. Uses the SAME `spawnSuccessor` engine
 * as the fast path, so the backstop produces an identical successor.
 *
 * Re-reads the note and re-checks `needsSuccessor` so the fix is idempotent: if
 * the chain field is no longer empty (e.g. fixed earlier in the run, or the rule
 * changed), it skips rather than spawning a duplicate. Honors dry-run by not
 * writing — but spawning a file IS a write, so in dry-run we skip the spawn.
 */
async function applyMissingSuccessorFix(
  schema: LoadedSchema,
  vaultDir: string,
  filePath: string,
  issue: AuditIssue
): Promise<FixResult> {
  if (isDryRunEnabled()) {
    return { file: filePath, issue, action: 'skipped', message: 'Dry-run: would spawn successor' };
  }

  const parsed = await parseNote(filePath);
  const typePath = resolveTypeFromFrontmatter(schema, parsed.frontmatter);
  if (!typePath) {
    return { file: filePath, issue, action: 'failed', message: 'Could not resolve note type' };
  }

  // Idempotency: only spawn if still needed (trigger satisfied AND next empty).
  if (!needsSuccessor(schema, typePath, parsed.frontmatter)) {
    return { file: filePath, issue, action: 'skipped', message: 'Successor no longer needed' };
  }

  const predecessorName = basename(filePath, '.md');
  const typeDef = getTypeDefByPath(schema, typePath);
  const order = typeDef?.fieldOrder;

  try {
    const successorPath = await spawnSuccessor(
      schema,
      vaultDir,
      typePath,
      parsed.frontmatter,
      predecessorName,
      async (nextLink) => {
        // Re-read to avoid clobbering any concurrent edits, then set `next`.
        const latest = await parseNote(filePath);
        const updated = { ...latest.frontmatter, [CHAIN_NEXT_FIELD]: nextLink };
        await writeNote(filePath, updated, latest.body, order);
      }
    );
    if (!successorPath) {
      return { file: filePath, issue, action: 'skipped', message: 'Type does not recur' };
    }
    return { file: filePath, issue, action: 'fixed', message: successorPath };
  } catch (err) {
    return { file: filePath, issue, action: 'failed', message: (err as Error).message };
  }
}

async function applyTrailingWhitespaceFix(filePath: string, issue: AuditIssue): Promise<FixResult> {
  const lineNumber = issue.lineNumber;
  if (!lineNumber || lineNumber <= 0) {
    return { file: filePath, issue, action: 'failed', message: 'No line number for whitespace fix' };
  }

  const content = await readFile(filePath, 'utf-8');
  const lines = splitLinesPreserveEol(content);

  const index = lineNumber - 1;
  if (index < 0 || index >= lines.length) {
    return { file: filePath, issue, action: 'failed', message: `Line ${lineNumber} out of range` };
  }

  const current = lines[index]!;
  if (!/[ \t]+$/.test(current.text)) {
    return { file: filePath, issue, action: 'skipped', message: 'No trailing whitespace found' };
  }

  lines[index] = {
    ...current,
    text: current.text.replace(/[ \t]+$/, ''),
  };

  const updated = lines.map((l) => l.text + l.eol).join('');

  if (!isDryRunEnabled()) {
    await writeFile(filePath, updated, 'utf-8');
  }

  return { file: filePath, issue, action: 'fixed' };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getTopLevelIndent(
  lines: Array<ReturnType<typeof splitLinesPreserveEol>[number]>,
  yamlStart: number,
  yamlEnd: number
): number | null {
  let inBlockScalar = false;
  let blockScalarIndent = 0;
  let minIndent: number | null = null;

  for (const line of lines) {
    if (line.startOffset < yamlStart || line.startOffset >= yamlEnd) continue;

    const parsed = parseSimpleYamlKeyValueLine(line.text);

    if (inBlockScalar) {
      if (parsed && parsed.indent <= blockScalarIndent) {
        inBlockScalar = false;
      } else {
        continue;
      }
    }

    if (!parsed) continue;

    const restTrimStart = parsed.rest.replace(/^[ \t]*/, '');
    if (isBlockScalarHeader(restTrimStart)) {
      inBlockScalar = true;
      blockScalarIndent = parsed.indent;
    }

    minIndent = minIndent === null ? parsed.indent : Math.min(minIndent, parsed.indent);
  }

  return minIndent;
}

async function applyFrontmatterKeyRenameFix(
  filePath: string,
  issue: AuditIssue
): Promise<FixResult> {
  if (issue.hasConflict) {
    return { file: filePath, issue, action: 'skipped', message: 'Key conflict detected' };
  }

  if (!issue.field || !issue.canonicalKey) {
    return { file: filePath, issue, action: 'failed', message: 'Missing key metadata' };
  }

  const content = await readFile(filePath, 'utf-8');
  const structural = readStructuralFrontmatterFromRaw(content);
  if (!structural.primaryBlock || structural.yaml === null) {
    return { file: filePath, issue, action: 'failed', message: 'No frontmatter block found' };
  }

  const { yamlStart, yamlEnd } = structural.primaryBlock;
  const lines = splitLinesPreserveEol(content);

  const topIndent = getTopLevelIndent(lines, yamlStart, yamlEnd);
  if (topIndent === null) {
    return { file: filePath, issue, action: 'failed', message: 'Could not determine frontmatter indentation' };
  }

  const fromKey = issue.field;
  const toKey = issue.canonicalKey;
  const targetIndexes: number[] = [];

  let inBlockScalar = false;
  let blockScalarIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startOffset < yamlStart || line.startOffset >= yamlEnd) continue;

    const parsed = parseSimpleYamlKeyValueLine(line.text);

    if (inBlockScalar) {
      if (parsed && parsed.indent <= blockScalarIndent) {
        inBlockScalar = false;
      } else {
        continue;
      }
    }

    if (!parsed) continue;

    const restTrimStart = parsed.rest.replace(/^[ \t]*/, '');
    if (isBlockScalarHeader(restTrimStart)) {
      inBlockScalar = true;
      blockScalarIndent = parsed.indent;
    }

    if (parsed.indent !== topIndent) continue;
    if (parsed.key !== fromKey) continue;

    targetIndexes.push(i);
  }

  if (targetIndexes.length === 0) {
    return { file: filePath, issue, action: 'skipped', message: `Key '${fromKey}' not found` };
  }

  if (targetIndexes.length > 1) {
    return { file: filePath, issue, action: 'failed', message: `Multiple '${fromKey}' keys found` };
  }

  const targetIndex = targetIndexes[0]!;
  const targetLine = lines[targetIndex]!;
  const keyPattern = new RegExp(`^([ \t]*)${escapeRegExp(fromKey)}(\\s*:)`);
  const match = targetLine.text.match(keyPattern);
  if (!match) {
    return { file: filePath, issue, action: 'failed', message: 'Unable to rewrite key line' };
  }

  const replacement = `${match[1]}${toKey}${match[2]}`;
  lines[targetIndex] = {
    ...targetLine,
    text: replacement + targetLine.text.slice(match[0].length),
  };

  const updated = lines.map((line) => line.text + line.eol).join('');

  if (!isDryRunEnabled()) {
    await writeFile(filePath, updated, 'utf-8');
  }

  return { file: filePath, issue, action: 'fixed' };
}

// ============================================================================
// Fix Application
// ============================================================================

/**
 * Apply a single fix to a file.
 */
async function applyFix(
  schema: LoadedSchema,
  filePath: string,
  issue: AuditIssue,
  newValue?: unknown
): Promise<FixResult> {
  try {
    // Phase 4 structural fixes operate on raw content.
    if (issue.code === 'frontmatter-not-at-top' || issue.code === 'duplicate-frontmatter-keys' || issue.code === 'malformed-wikilink') {
      return await applyStructuralFix(filePath, issue, newValue);
    }

    if (issue.code === 'trailing-whitespace') {
      return await applyTrailingWhitespaceFix(filePath, issue);
    }

    if (issue.code === 'unlinked-mention') {
      return await applyUnlinkedMentionFix(schema, filePath, issue);
    }

    if (issue.code === 'missing-body-section') {
      return await applyBodySectionFix(schema, filePath, issue);
    }

    if (issue.code === 'frontmatter-key-casing') {
      return await applyFrontmatterKeyRenameFix(filePath, issue);
    }

    const parsed = await parseNote(filePath);
    const frontmatter = { ...parsed.frontmatter };

    switch (issue.code) {
      case 'orphan-file': {
        // newValue should be a type path (e.g., 'objective/task')
        if (typeof newValue !== 'string') {
          return { file: filePath, issue, action: 'failed', message: 'No type path provided' };
        }
        // Convert type path to discriminator fields and add them
        const discriminatorFields = getDiscriminatorFieldsFromTypePath(newValue);
        Object.assign(frontmatter, discriminatorFields);
        break;
      }
      case 'missing-required': {
        if (issue.field && newValue !== undefined) {
          frontmatter[issue.field] = newValue;
        } else {
          return { file: filePath, issue, action: 'failed', message: 'No value provided' };
        }
        break;
      }
      case 'invalid-option': {
        if (issue.field && newValue !== undefined) {
          frontmatter[issue.field] = newValue;
        } else {
          return { file: filePath, issue, action: 'failed', message: 'No value provided' };
        }
        break;
      }
      case 'format-violation': {
        if (issue.field && issue.expectedFormat) {
          const currentValue = frontmatter[issue.field];
          if (typeof currentValue === 'string') {
            if (issue.expectedFormat === 'wikilink') {
              frontmatter[issue.field] = toWikilink(currentValue);
            } else if (issue.expectedFormat === 'markdown') {
              frontmatter[issue.field] = toMarkdownLink(currentValue);
            }
          } else {
            return { file: filePath, issue, action: 'failed', message: 'Cannot fix non-string value' };
          }
        } else {
          return { file: filePath, issue, action: 'failed', message: 'No field or format specified' };
        }
        break;
      }
      case 'unknown-field': {
        // This is handled by removeField instead
        return { file: filePath, issue, action: 'skipped', message: 'Use removeField for unknown-field issues' };
      }
      case 'invalid-source-type': {
        // Fix invalid source type by updating the field value
        if (issue.field && newValue !== undefined) {
          frontmatter[issue.field] = newValue;
        } else {
          return { file: filePath, issue, action: 'failed', message: 'No value provided' };
        }
        break;
      }

      case 'self-reference':
      case 'ambiguous-link-target': {
        if (!issue.field || typeof newValue !== 'string') {
          return { file: filePath, issue, action: 'failed', message: 'No field or value provided' };
        }

        if (newValue.length === 0) {
          delete frontmatter[issue.field];
        } else {
          frontmatter[issue.field] = maybeUnquoteFormattedLink(newValue);
        }
        break;
      }
      // Phase 2: Low-risk hygiene fixes
      case 'invalid-boolean-coercion': {
        if (issue.field && typeof frontmatter[issue.field] === 'string') {
          const result = coerceBooleanFromString(frontmatter[issue.field] as string);
          if (result.ok) {
            frontmatter[issue.field] = result.value;
          } else {
            return { file: filePath, issue, action: 'failed', message: 'Cannot coerce boolean value' };
          }
        } else {
          return { file: filePath, issue, action: 'failed', message: 'Cannot coerce non-string value' };
        }
        break;
      }
      case 'wrong-scalar-type': {
        if (!issue.field) {
          return { file: filePath, issue, action: 'failed', message: 'Missing field for coercion' };
        }

        const current = frontmatter[issue.field];
        if (typeof current !== 'string') {
          return { file: filePath, issue, action: 'failed', message: 'Cannot coerce non-string value' };
        }

        if (issue.expected === 'number') {
          const result = coerceNumberFromString(current);
          if (result.ok) {
            frontmatter[issue.field] = result.value;
          } else {
            return { file: filePath, issue, action: 'failed', message: 'Cannot coerce number value' };
          }
        } else if (issue.expected === 'boolean') {
          const result = coerceBooleanFromString(current);
          if (result.ok) {
            frontmatter[issue.field] = result.value;
          } else {
            return { file: filePath, issue, action: 'failed', message: 'Cannot coerce boolean value' };
          }
        } else {
          return { file: filePath, issue, action: 'failed', message: 'Unsupported coercion target' };
        }

        break;
      }
      case 'invalid-date-format': {
        if (!issue.field || typeof newValue !== 'string') {
          return { file: filePath, issue, action: 'failed', message: 'No date value provided' };
        }
        frontmatter[issue.field] = newValue;
        break;
      }
      case 'unknown-enum-casing': {
        const suggested = issue.canonicalValue ?? (issue.meta?.['suggested'] as string | undefined);
        if (issue.field && suggested) {
          frontmatter[issue.field] = suggested;
        } else {
          return { file: filePath, issue, action: 'failed', message: 'No canonical value provided' };
        }
        break;
      }
      case 'duplicate-list-values': {
        const currentValue = issue.field ? frontmatter[issue.field] : undefined;
        if (issue.field && Array.isArray(currentValue)) {
          if (!currentValue.every(item => typeof item === 'string')) {
            return { file: filePath, issue, action: 'failed', message: 'Cannot dedupe non-string list values' };
          }
          const seen = new Set<string>();
          const deduped: string[] = [];
          for (const item of currentValue) {
            if (!seen.has(item)) {
              seen.add(item);
              deduped.push(item);
            }
          }
          frontmatter[issue.field] = deduped;
        } else {
          return { file: filePath, issue, action: 'failed', message: 'Cannot dedupe non-array value' };
        }
        break;
      }
      case 'illegal-aliases': {
        // Safe, idempotent alias cleanup: drop empty/whitespace entries and
        // de-duplicate (preserving the first occurrence). Reuses the same
        // dedupe-style apply as `duplicate-list-values`, extended to also drop
        // blanks. A non-string entry is never auto-dispatched here (the detector
        // marks such issues non-fixable), so we fail safe if one appears (#617).
        const currentValue = issue.field ? frontmatter[issue.field] : undefined;
        if (!issue.field || !Array.isArray(currentValue)) {
          return { file: filePath, issue, action: 'failed', message: 'Cannot clean non-array aliases' };
        }
        if (!currentValue.every((item) => typeof item === 'string')) {
          return { file: filePath, issue, action: 'failed', message: 'Cannot auto-fix non-string aliases' };
        }
        const seen = new Set<string>();
        const cleaned: string[] = [];
        for (const item of currentValue as string[]) {
          if (item.trim() === '') continue; // drop empty/whitespace
          if (seen.has(item)) continue; // dedupe (first wins)
          seen.add(item);
          cleaned.push(item);
        }
        frontmatter[issue.field] = cleaned;
        break;
      }
      case 'singular-plural-mismatch': {
        if (!issue.field || !issue.canonicalKey) {
          return { file: filePath, issue, action: 'failed', message: 'No field or canonical key provided' };
        }
        const oldKey = issue.field;
        const newKey = issue.canonicalKey;

        if (!(oldKey in frontmatter)) {
          return { file: filePath, issue, action: 'skipped', message: `Key '${oldKey}' not found` };
        }

        const oldValue = frontmatter[oldKey];
        const existingValue = frontmatter[newKey];
        
        // Handle merge logic
        if (existingValue !== undefined && !isEffectivelyEmpty(existingValue)) {
          // Both have values - cannot auto-fix unless old is empty
          if (!isEffectivelyEmpty(oldValue)) {
            return { file: filePath, issue, action: 'failed', message: 'Both keys have values, manual merge required' };
          }
          // Old is empty, just delete it
          delete frontmatter[oldKey];
        } else {
          // Move value from old key to new key
          frontmatter[newKey] = oldValue;
          delete frontmatter[oldKey];
        }
        break;
      }
      default:
        return { file: filePath, issue, action: 'skipped', message: 'Not auto-fixable' };
    }

    // Write the updated frontmatter
    // Get the type path to determine frontmatter order
    const typePath = resolveTypePathFromFrontmatter(schema, frontmatter);
    const typeDef = typePath ? getTypeDefByPath(schema, typePath) : undefined;
    const order = typeDef?.fieldOrder;

    if (!isDryRunEnabled()) {
      await writeNote(filePath, frontmatter, parsed.body, order);
    }
    return { file: filePath, issue, action: 'fixed' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { file: filePath, issue, action: 'failed', message };
  }
}

async function applyStructuralFix(
  filePath: string,
  issue: AuditIssue,
  newValue?: unknown
): Promise<FixResult> {
  const raw = await readFile(filePath, 'utf-8');
  const structural = readStructuralFrontmatterFromRaw(raw);
  const block = structural.primaryBlock;

  if (!block || structural.yaml === null) {
    return { file: filePath, issue, action: 'failed', message: 'No frontmatter block found' };
  }

  switch (issue.code) {
    case 'frontmatter-not-at-top': {
      const eligible =
        !structural.atTop &&
        structural.frontmatterBlocks.length === 1 &&
        !structural.unterminated &&
        structural.yamlErrors.length === 0;

      if (!eligible) {
        return { file: filePath, issue, action: 'skipped', message: 'Ambiguous frontmatter; manual fix required' };
      }

      const updated = movePrimaryBlockToTop(raw, block);
      if (!isDryRunEnabled()) {
        await writeFile(filePath, updated, 'utf-8');
      }
      return { file: filePath, issue, action: 'fixed' };
    }

    case 'duplicate-frontmatter-keys': {
      const key = issue.duplicateKey ?? issue.field;
      if (!key) {
        return { file: filePath, issue, action: 'failed', message: 'No duplicate key specified' };
      }

      const doc = parseDocument(structural.yaml);
      if (!isMap(doc.contents)) {
        return { file: filePath, issue, action: 'failed', message: 'Frontmatter is not a YAML map' };
      }

      const map = doc.contents;
      const matches = getAllPairsForKey(map, key);

      if (matches.length < 2) {
        return { file: filePath, issue, action: 'skipped', message: 'No duplicate keys found' };
      }

      const strategy = typeof newValue === 'string' ? newValue : undefined;
      let keepIndex: number | null = null;

      if (strategy === 'keep-first') {
        keepIndex = matches[0]!.index;
      } else if (strategy === 'keep-last') {
        keepIndex = matches[matches.length - 1]!.index;
      } else {
        // Auto-merge only when values are effectively the same, or one side is empty.
        const values = matches.map((m) => extractYamlNodeValue(m.pair.value as unknown));
        const nonEmptyLocalIndexes = values
          .map((v, i) => (!isEffectivelyEmpty(v) ? i : -1))
          .filter((i) => i >= 0);

        if (nonEmptyLocalIndexes.length === 0) {
          // All empty; keep last
          keepIndex = matches[matches.length - 1]!.index;
        } else {
          const nonEmptyValues = nonEmptyLocalIndexes.map((i) => values[i]!);
          const uniqueNonEmpty: unknown[] = [];
          for (const v of nonEmptyValues) {
            if (!uniqueNonEmpty.some((u) => isDeepStrictEqual(u, v))) {
              uniqueNonEmpty.push(v);
            }
          }

          if (uniqueNonEmpty.length !== 1) {
            return {
              file: filePath,
              issue,
              action: 'skipped',
              message: 'Duplicate values differ; run interactive fix',
            };
          }

          // Keep the last non-empty occurrence.
          const lastNonEmptyLocal = nonEmptyLocalIndexes[nonEmptyLocalIndexes.length - 1]!;
          keepIndex = matches[lastNonEmptyLocal]!.index;
        }
      }

      if (keepIndex === null) {
        return { file: filePath, issue, action: 'failed', message: 'Unable to determine resolution strategy' };
      }

      const removeIndexes = matches
        .map((m) => m.index)
        .filter((i) => i !== keepIndex)
        .sort((a, b) => b - a);

      for (const idx of removeIndexes) {
        map.items.splice(idx, 1);
      }

      // Allow stringification even if other duplicate errors remain (handled per-issue).
      (doc.errors as unknown[]).length = 0;
      const newYaml = doc.toString().trimEnd();
      const updated = replacePrimaryYaml(raw, block, newYaml);
      if (!isDryRunEnabled()) {
        await writeFile(filePath, updated, 'utf-8');
      }
      return { file: filePath, issue, action: 'fixed' };
    }

    case 'malformed-wikilink': {
      if (!issue.field || !issue.fixedValue) {
        return { file: filePath, issue, action: 'failed', message: 'No field/fixed value provided' };
      }

      const doc = parseDocument(structural.yaml);
      if (!isMap(doc.contents)) {
        return { file: filePath, issue, action: 'failed', message: 'Frontmatter is not a YAML map' };
      }

      const map = doc.contents;
      const pair = getLastPairForKey(map, issue.field);
      if (!pair) {
        return { file: filePath, issue, action: 'failed', message: `Key not found: ${issue.field}` };
      }

      if (issue.listIndex !== undefined) {
        if (!isSeq(pair.value)) {
          return { file: filePath, issue, action: 'failed', message: `Expected list value for ${issue.field}` };
        }
        const item = getStringSequenceItem(pair.value as YAMLSeq, issue.listIndex);
        if (!item) {
          return { file: filePath, issue, action: 'failed', message: `List item not found: ${issue.field}[${issue.listIndex}]` };
        }
        item.value = issue.fixedValue;
      } else {
        if (isScalar(pair.value) && typeof pair.value.value === 'string') {
          pair.value.value = issue.fixedValue;
        } else {
          return { file: filePath, issue, action: 'failed', message: `Expected string value for ${issue.field}` };
        }
      }

      (doc.errors as unknown[]).length = 0;
      const newYaml = doc.toString().trimEnd();
      const updated = replacePrimaryYaml(raw, block, newYaml);
      if (!isDryRunEnabled()) {
        await writeFile(filePath, updated, 'utf-8');
      }
      return { file: filePath, issue, action: 'fixed' };
    }

    default:
      return { file: filePath, issue, action: 'skipped', message: 'Not structural-fixable' };
  }
}

/**
 * Remove a field from a file's frontmatter.
 */
async function removeField(
  schema: LoadedSchema,
  filePath: string,
  fieldName: string
): Promise<FixResult> {
  try {
    const parsed = await parseNote(filePath);
    const frontmatter = { ...parsed.frontmatter };

    if (!(fieldName in frontmatter)) {
      return {
        file: filePath,
        issue: { severity: 'warning', code: 'unknown-field', message: '', autoFixable: false },
        action: 'skipped',
        message: 'Field not found',
      };
    }

    delete frontmatter[fieldName];

    // Get frontmatter order if available
    const typePath = resolveTypePathFromFrontmatter(schema, frontmatter);
    const typeDef = typePath ? getTypeDefByPath(schema, typePath) : undefined;
    const order = typeDef?.fieldOrder;

    if (!isDryRunEnabled()) {
      await writeNote(filePath, frontmatter, parsed.body, order);
    }
    return {
      file: filePath,
      issue: { severity: 'warning', code: 'unknown-field', message: '', field: fieldName, autoFixable: false },
      action: 'fixed',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      file: filePath,
      issue: { severity: 'warning', code: 'unknown-field', message: '', autoFixable: false },
      action: 'failed',
      message,
    };
  }
}

/**
 * Get the default value for a missing required field.
 */
function getDefaultValue(
  schema: LoadedSchema,
  frontmatter: Record<string, unknown>,
  fieldName: string
): unknown | undefined {
  const typePath = resolveTypePathFromFrontmatter(schema, frontmatter);
  if (!typePath) return undefined;

  const fields = getFieldsForType(schema, typePath);
  const field = fields[fieldName];
  return field?.default;
}

// ============================================================================
// High-Confidence Match Detection
// ============================================================================

/**
 * Check if a similar file is a high-confidence match for auto-fix.
 * 
 * High confidence means:
 * - Levenshtein distance <= 2 (very similar names)
 * - OR one is a prefix/suffix of the other (typo at start/end)
 * - OR case-insensitive exact match
 */
function isHighConfidenceMatch(target: string, similar: string): boolean {
  const targetLower = target.toLowerCase();
  const similarLower = similar.toLowerCase();
  
  // Case-insensitive exact match
  if (targetLower === similarLower) {
    return true;
  }
  
  // Prefix/suffix relationship (handles singular/plural, minor additions)
  if (targetLower.startsWith(similarLower) || similarLower.startsWith(targetLower)) {
    const diff = Math.abs(target.length - similar.length);
    if (diff <= 2) {
      return true;
    }
  }
  
  // Levenshtein distance <= 2
  const distance = levenshteinDistance(targetLower, similarLower);
  if (distance <= 2) {
    return true;
  }
  
  return false;
}

// ============================================================================
// Auto-Fix Mode
// ============================================================================

/**
 * Run automatic fixes on all auto-fixable issues.
 */
export async function runAutoFix(
  results: FileAuditResult[],
  schema: LoadedSchema,
  vaultDir: string,
  options?: { dryRun?: boolean; dryRunReason?: FixSummary['dryRunReason'] }
): Promise<FixSummary> {
  const dryRun = options?.dryRun ?? false;
  const dryRunReason = dryRun ? options?.dryRunReason : undefined;
  dryRunStorage.enterWith(dryRun);
  
  console.log(chalk.bold('Auditing vault...\n'));
  console.log(chalk.bold('Auto-fixing unambiguous issues...\n'));

  let fixed = 0;
  let skipped = 0;
  let failed = 0;
  const manualReviewNeeded: { file: string; issue: AuditIssue }[] = [];
  const resolvedNonFixable = new Set<AuditIssue>();

  // Per-run backlink scanner: caches vault file contents so the repeated move
  // backlink-count lookups below don't re-read the whole vault per operation.
  const backlinkScanner = new BacklinkScanner(vaultDir);

  for (const result of results) {
    const fixableIssues = result.issues.filter(i => i.autoFixable);
    const nonFixableIssues = result.issues.filter(i => !i.autoFixable);


    // Handle wrong-directory issues
    for (const issue of [...fixableIssues]) {

      if (issue.code === 'wrong-directory' && issue.expectedDirectory) {
        if (dryRun) {
          // Show what would be done
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.yellow(`    ⚠ Would move to ${issue.expectedDirectory}/`));
          skipped++;
          // Remove from fixableIssues so we don't process it again
          const idx = fixableIssues.indexOf(issue);
          if (idx > -1) fixableIssues.splice(idx, 1);
          continue;
        }
        
        // Get wikilink count for warning
        const refs = await backlinkScanner.findReferences(result.path);

        if (refs.length > 0) {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.yellow(`    ⚠ ${refs.length} wikilink(s) will be updated`));
        }

        // Execute the move
        const targetDir = join(vaultDir, issue.expectedDirectory);
        const moveResult = await executeBulkMove({
          vaultDir,
          targetDir,
          filesToMove: [result.path],
          execute: true,
        });

        // The move rewrote source files and renamed the moved file; rebuild the
        // backlink index so subsequent lookups reflect the mutated graph.
        backlinkScanner.invalidate();

        if (moveResult.errors.length === 0) {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.green(`    ✓ Moved to ${issue.expectedDirectory}/`));
          if (moveResult.totalLinksUpdated > 0) {
            console.log(chalk.green(`    ✓ Updated ${moveResult.totalLinksUpdated} wikilink(s)`));
          }
          fixed++;
        } else {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.red(`    ✗ Failed to move: ${moveResult.errors[0]}`));
          failed++;
        }

        // Remove from fixableIssues so we don't process it again
        const idx = fixableIssues.indexOf(issue);
        if (idx > -1) fixableIssues.splice(idx, 1);
        continue;
      }

      // Handle owned-wrong-location issues
      if (issue.code === 'owned-wrong-location' && issue.expectedDirectory) {
        if (dryRun) {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.yellow(`    ⚠ Would move to ${issue.expectedDirectory}/`));
          skipped++;
          const idx = fixableIssues.indexOf(issue);
          if (idx > -1) fixableIssues.splice(idx, 1);
          continue;
        }
        
        // Get wikilink count for warning
        const refs = await backlinkScanner.findReferences(result.path);

        if (refs.length > 0) {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.yellow(`    ⚠ ${refs.length} wikilink(s) will be updated`));
        }

        // Execute the move
        const targetDir = join(vaultDir, issue.expectedDirectory);
        const moveResult = await executeBulkMove({
          vaultDir,
          targetDir,
          filesToMove: [result.path],
          execute: true,
        });

        // The move rewrote source files and renamed the moved file; rebuild the
        // backlink index so subsequent lookups reflect the mutated graph.
        backlinkScanner.invalidate();

        if (moveResult.errors.length === 0) {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.green(`    ✓ Moved to ${issue.expectedDirectory}/`));
          if (moveResult.totalLinksUpdated > 0) {
            console.log(chalk.green(`    ✓ Updated ${moveResult.totalLinksUpdated} wikilink(s)`));
          }
          fixed++;
        } else {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.red(`    ✗ Failed to move: ${moveResult.errors[0]}`));
          failed++;
        }

        const idx = fixableIssues.indexOf(issue);
        if (idx > -1) fixableIssues.splice(idx, 1);
        continue;
      }
    }

    // Handle stale-reference issues with high-confidence matches and safe unknown-field migrations
    for (const issue of nonFixableIssues) {
      if (issue.code === 'stale-reference' && !issue.inBody && issue.field) {

        // Check for high-confidence match
        if (issue.similarFiles?.length === 1 && 
            issue.targetName && 
            isHighConfidenceMatch(issue.targetName, issue.similarFiles[0]!)) {
          const replacement = `[[${issue.similarFiles[0]}]]`;
          const fixResult = await applyFix(schema, result.path, { ...issue, code: 'invalid-option' }, replacement);
          if (fixResult.action === 'fixed') {
            console.log(chalk.cyan(`  ${result.relativePath}`));
            console.log(chalk.green(`    ✓ Fixed ${issue.field}: [[${issue.targetName}]] → ${replacement}`));
            fixed++;
            resolvedNonFixable.add(issue);
            continue; // Don't add to manual review
          } else {
            console.log(chalk.cyan(`  ${result.relativePath}`));
            console.log(chalk.red(`    ✗ Failed to fix ${issue.field}: ${fixResult.message}`));
            failed++;
            continue;
          }
        }
      }

      if (issue.code === 'unknown-field' && issue.field) {
        if (isBwrbBuiltinFrontmatterField(issue.field)) {
          resolvedNonFixable.add(issue);
          continue;
        }
        const hasBetterAutoFix = fixableIssues.some(
          i =>
            (i.code === 'frontmatter-key-casing' || i.code === 'singular-plural-mismatch') &&
            i.field === issue.field
        );
        if (hasBetterAutoFix) {
          resolvedNonFixable.add(issue);
          continue; // Defer to specialized auto-fix
        }

        try {
          const latest = await parseNote(result.path);
          const targetField = getAutoUnknownFieldMigrationTarget(
            schema,
            latest.frontmatter,
            issue.field,
            issue.value
          );

          if (targetField) {
            if (!(issue.field in latest.frontmatter)) {
              skipped++;
              continue;
            }

            const frontmatter = { ...latest.frontmatter };
            frontmatter[targetField] = frontmatter[issue.field];
            delete frontmatter[issue.field];

            const updatedTypePath = resolveTypePathFromFrontmatter(schema, frontmatter);
            const updatedTypeDef = updatedTypePath ? getTypeDefByPath(schema, updatedTypePath) : undefined;
            const order = updatedTypeDef?.fieldOrder;

            if (!dryRun) {
              await writeNote(result.path, frontmatter, latest.body, order);
            }

            console.log(chalk.cyan(`  ${result.relativePath}`));
            console.log(chalk.green(`    ✓ Migrated ${issue.field} → ${targetField}`));
            fixed++;
            resolvedNonFixable.add(issue);
            continue; // Don't add to manual review
          }
        } catch {
          // Fall through to manual review
        }
      }
    }

    for (const issue of nonFixableIssues) {
      if (!resolvedNonFixable.has(issue)) {
        registerManualReview(manualReviewNeeded, result.relativePath, issue);
      }
    }

    // Apply auto-fixes
    for (const issue of fixableIssues) {
      if (issue.code === 'orphan-file' && issue.inferredType) {
        // Auto-fix orphan-file when we have inferred type from directory
        const fixResult = await applyFix(schema, result.path, issue, issue.inferredType);
        if (fixResult.action === 'fixed') {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          const fields = getDiscriminatorFieldsFromTypePath(issue.inferredType);
          const fieldStr = Object.entries(fields)
            .map(([k, v]) => `${k}: ${v}`)
            .join(', ');
          console.log(chalk.green(`    ✓ Added ${fieldStr} (from directory)`));
          fixed++;
        } else if (fixResult.action === 'skipped') {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.yellow(`    ⚠ ${fixResult.message}`));
          skipped++;
          registerManualReview(manualReviewNeeded, result.relativePath, issue);
        } else {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.red(`    ✗ Failed to add type: ${fixResult.message}`));
          failed++;
        }
      } else if (issue.code === 'missing-required' && issue.field) {
        const parsed = await parseNote(result.path);
        const defaultValue = getDefaultValue(schema, parsed.frontmatter, issue.field);

        if (defaultValue !== undefined) {
          const fixResult = await applyFix(schema, result.path, issue, defaultValue);
          if (fixResult.action === 'fixed') {
            console.log(chalk.cyan(`  ${result.relativePath}`));
            console.log(chalk.green(`    ✓ Added ${issue.field}: ${JSON.stringify(defaultValue)} (default)`));
            fixed++;
          } else if (fixResult.action === 'skipped') {
            console.log(chalk.cyan(`  ${result.relativePath}`));
            console.log(chalk.yellow(`    ⚠ ${fixResult.message}`));
            skipped++;
            registerManualReview(manualReviewNeeded, result.relativePath, issue);
          } else {
            console.log(chalk.cyan(`  ${result.relativePath}`));
            console.log(chalk.red(`    ✗ Failed to fix ${issue.field}: ${fixResult.message}`));
            failed++;
          }
        } else {
          skipped++;
          registerManualReview(manualReviewNeeded, result.relativePath, issue);
        }
      } else if (issue.code === 'empty-string-required' && issue.field) {
        const parsed = await parseNote(result.path);
        const defaultValue = getDefaultValue(schema, parsed.frontmatter, issue.field);
        if (defaultValue !== undefined) {
          if (dryRun) {
            console.log(chalk.cyan(`  ${result.relativePath}`));
            console.log(chalk.yellow(`    ⚠ Would fill ${issue.field} with default ${JSON.stringify(defaultValue)}`));
            skipped++;
            continue;
          }

          const fixResult = await setFrontmatterField(schema, result, issue.field, defaultValue);
          if (fixResult.action === 'fixed') {
            console.log(chalk.cyan(`  ${result.relativePath}`));
            console.log(chalk.green(`    ✓ Filled ${issue.field}: ${JSON.stringify(defaultValue)} (default)`));
            fixed++;
          } else if (fixResult.action === 'skipped') {
            console.log(chalk.cyan(`  ${result.relativePath}`));
            console.log(chalk.yellow(`    ⚠ ${fixResult.message}`));
            skipped++;
            registerManualReview(manualReviewNeeded, result.relativePath, issue);
          } else {
            console.log(chalk.cyan(`  ${result.relativePath}`));
            console.log(chalk.red(`    ✗ Failed to fix ${issue.field}: ${fixResult.message}`));
            failed++;
          }
        } else {
          skipped++;
          registerManualReview(manualReviewNeeded, result.relativePath, issue);
        }
      } else if (
        issue.code === 'wrong-scalar-type' &&
        issue.field &&
        issue.listIndex !== undefined &&
        issue.meta?.['action'] === 'quote-element'
      ) {
        // Per-element quoting (#673): a VALID numeric element of a multiple date
        // field (e.g. unquoted `2026` at year granularity) only needs to be
        // quoted as a string — quote THAT element in place, leaving the rest of
        // the array intact. We must NOT reuse the whole-field scalar coercion
        // below (getScalarFromList collapses the array to one scalar).
        //
        // Index-safe mutation, mirroring the #683 blank-removal pattern: each
        // issue is applied as its own read-modify-write, so re-derive the target
        // from the live array and only quote an element that is still a number.
        // Storing the JS string `String(2026)` is what makes this idempotent and
        // round-trip-stable (the #700 trap): yaml serializes a numeric-looking
        // JS string as a quoted scalar (`"2026"`) and gray-matter re-reads it as
        // a string, so a second pass finds no numeric element. We never quote a
        // non-number (e.g. a value already fixed earlier in the run).
        const listIndex = issue.listIndex;
        const quoted =
          typeof issue.meta['quoted'] === 'string' ? issue.meta['quoted'] : undefined;

        if (dryRun) {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.yellow(`    ⚠ Would quote ${issue.field}[${listIndex}]`));
          skipped++;
          continue;
        }

        const fixResult = await updateFrontmatterValue(schema, result, (frontmatter) => {
          const current = frontmatter[issue.field!];
          if (!Array.isArray(current)) return false;
          if (listIndex < 0 || listIndex >= current.length) return false;
          if (typeof current[listIndex] !== 'number') return false;
          // Prefer the exact string detection computed; fall back to String() of
          // the live value if the meta is missing for any reason.
          current[listIndex] = quoted ?? String(current[listIndex]);
          frontmatter[issue.field!] = current;
          return true;
        });

        if (fixResult.action === 'fixed') {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.green(`    ✓ Quoted ${issue.field}[${listIndex}]`));
          fixed++;
        } else if (fixResult.action === 'skipped') {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.yellow(`    ⚠ ${fixResult.message}`));
          skipped++;
          registerManualReview(manualReviewNeeded, result.relativePath, issue);
        } else {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.red(`    ✗ Failed to quote ${issue.field}[${listIndex}]: ${fixResult.message}`));
          failed++;
        }
      } else if (issue.code === 'wrong-scalar-type' && issue.field) {
        const parsed = await parseNote(result.path);
        const currentValue = parsed.frontmatter[issue.field];
        const expected = typeof issue.expected === 'string' ? issue.expected : undefined;
        let nextValue: unknown | null = null;

        if (expected === 'list') {
          const wrapped = getScalarToList(currentValue);
          if (wrapped.ok) {
            nextValue = wrapped.value;
          }
        } else if (expected === 'string' || expected === 'number' || expected === 'boolean') {
          if (Array.isArray(currentValue)) {
            const coerced = getScalarFromList(currentValue, expected);
            if (coerced.ok) {
              nextValue = coerced.value;
            }
          } else {
            const coerced = getScalarCoercion(currentValue, expected);
            if (coerced.ok) {
              nextValue = coerced.value;
            }
          }
        }

        if (nextValue === null) {
          skipped++;
          registerManualReview(manualReviewNeeded, result.relativePath, issue);
          continue;
        }

        if (dryRun) {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.yellow(`    ⚠ Would coerce ${issue.field} to ${expected}`));
          skipped++;
          continue;
        }

        const fixResult = await setFrontmatterField(schema, result, issue.field, nextValue);
        if (fixResult.action === 'fixed') {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.green(`    ✓ Coerced ${issue.field} to ${expected}`));
          fixed++;
        } else if (fixResult.action === 'skipped') {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.yellow(`    ⚠ ${fixResult.message}`));
          skipped++;
          registerManualReview(manualReviewNeeded, result.relativePath, issue);
        } else {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.red(`    ✗ Failed to coerce ${issue.field}: ${fixResult.message}`));
          failed++;
        }
      } else if (issue.code === 'invalid-date-format' && issue.field) {
        const normalized = typeof issue.meta?.['normalized'] === 'string'
          ? issue.meta['normalized']
          : undefined;
        if (!normalized) {
          skipped++;
          registerManualReview(manualReviewNeeded, result.relativePath, issue);
          continue;
        }

        if (dryRun) {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.yellow(`    ⚠ Would normalize ${issue.field} to ${normalized}`));
          skipped++;
          continue;
        }

        const fixResult = await setFrontmatterField(schema, result, issue.field, normalized);
        if (fixResult.action === 'fixed') {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.green(`    ✓ Normalized ${issue.field} to ${normalized}`));
          fixed++;
        } else if (fixResult.action === 'skipped') {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.yellow(`    ⚠ ${fixResult.message}`));
          skipped++;
          registerManualReview(manualReviewNeeded, result.relativePath, issue);
        } else {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.red(`    ✗ Failed to normalize ${issue.field}: ${fixResult.message}`));
          failed++;
        }
      } else if (issue.code === 'invalid-list-element' && issue.field) {
        const listIndex = issue.listIndex;
        const action = typeof issue.meta?.['action'] === 'string' ? issue.meta['action'] : undefined;

        if (listIndex === undefined || !action) {
          skipped++;
          registerManualReview(manualReviewNeeded, result.relativePath, issue);
          continue;
        }

        if (dryRun) {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.yellow(`    ⚠ Would ${action} element ${issue.field}[${listIndex}]`));
          skipped++;
          continue;
        }

        const fixResult = await updateFrontmatterValue(schema, result, (frontmatter) => {
          const current = frontmatter[issue.field!];
          if (!Array.isArray(current)) return false;

          if (action === 'remove') {
            // Index-safe blank removal (#683). Detection reports each blank/null
            // entry with its ORIGINAL index, but every issue is applied as its
            // own read-modify-write to a SHRINKING array. Splicing blindly by the
            // original index uses a stale offset once an earlier blank has been
            // removed and can delete a distinct, non-blank element (data loss).
            //
            // Only ever remove a blank/null entry: prefer the reported index when
            // it still points at a blank, otherwise drop the first remaining
            // blank. This preserves every distinct value regardless of how many
            // blanks there are or where they sit, and is idempotent — once no
            // blanks remain the predicate returns false and the file is untouched.
            const removeAt =
              listIndex >= 0 && listIndex < current.length && isBlankListEntry(current[listIndex])
                ? listIndex
                : current.findIndex((entry) => isBlankListEntry(entry));
            if (removeAt < 0) return false;
            current.splice(removeAt, 1);
            frontmatter[issue.field!] = current;
            return true;
          }

          if (listIndex < 0 || listIndex >= current.length) return false;

          if (action === 'coerce') {
            current[listIndex] = String(current[listIndex]);
            frontmatter[issue.field!] = current;
            return true;
          }

          if (action === 'flatten') {
            if (current.length !== 1 || !Array.isArray(current[0])) return false;
            const nested = current[0];
            if (!nested.every((entry) => typeof entry === 'string')) return false;
            frontmatter[issue.field!] = nested;
            return true;
          }

          return false;
        });

        if (fixResult.action === 'fixed') {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.green(`    ✓ Fixed ${issue.field}[${listIndex}] (${action})`));
          fixed++;
        } else if (fixResult.action === 'skipped') {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.yellow(`    ⚠ ${fixResult.message}`));
          skipped++;
          registerManualReview(manualReviewNeeded, result.relativePath, issue);
        } else {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.red(`    ✗ Failed to fix ${issue.field}[${listIndex}]: ${fixResult.message}`));
          failed++;
        }
      } else if (issue.code === 'format-violation' && issue.field && issue.expectedFormat) {
        // Auto-fix format violations
        const fixResult = await applyFix(schema, result.path, issue);
        if (fixResult.action === 'fixed') {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.green(`    ✓ Fixed ${issue.field} format to ${issue.expectedFormat}`));
          fixed++;
        } else {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.red(`    ✗ Failed to fix ${issue.field}: ${fixResult.message}`));
          failed++;
        }
      } else if (issue.code === 'frontmatter-not-at-top') {
        const fixResult = await applyFix(schema, result.path, issue);
        if (fixResult.action === 'fixed') {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.green('    ✓ Moved frontmatter to top'));
          fixed++;
        } else if (fixResult.action === 'skipped') {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.yellow(`    ⚠ ${fixResult.message}`));
          skipped++;
          registerManualReview(manualReviewNeeded, result.relativePath, issue);
        } else {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.red(`    ✗ Failed to move frontmatter: ${fixResult.message}`));
          failed++;
        }
      } else if (issue.code === 'duplicate-frontmatter-keys') {
        const fixResult = await applyFix(schema, result.path, issue);
        if (fixResult.action === 'fixed') {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.green(`    ✓ Resolved duplicate key: ${issue.duplicateKey ?? issue.field ?? ''}`));
          fixed++;
        } else if (fixResult.action === 'skipped') {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.yellow(`    ⚠ ${fixResult.message}`));
          skipped++;
          registerManualReview(manualReviewNeeded, result.relativePath, issue);
        } else {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.red(`    ✗ Failed to resolve duplicate keys: ${fixResult.message}`));
          failed++;
        }
      } else if (issue.code === 'malformed-wikilink') {
        const fixResult = await applyFix(schema, result.path, issue);
        if (fixResult.action === 'fixed') {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.green('    ✓ Fixed malformed wikilink'));
          fixed++;
        } else if (fixResult.action === 'skipped') {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.yellow(`    ⚠ ${fixResult.message}`));
          skipped++;
          registerManualReview(manualReviewNeeded, result.relativePath, issue);
        } else {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.red(`    ✗ Failed to fix malformed wikilink: ${fixResult.message}`));
          failed++;
        }
      } else if (issue.code === 'trailing-whitespace' && issue.field) {
        // Auto-fix trailing whitespace
        const fixResult = await applyFix(schema, result.path, issue);
        if (fixResult.action === 'fixed') {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.green(`    ✓ Trimmed whitespace from ${issue.field}`));
          fixed++;
        } else if (fixResult.action === 'skipped') {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.yellow(`    ⚠ ${fixResult.message}`));
          skipped++;
          registerManualReview(manualReviewNeeded, result.relativePath, issue);
        } else {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.red(`    ✗ Failed to trim ${issue.field}: ${fixResult.message}`));
          failed++;
        }
      } else if (issue.code === 'invalid-boolean-coercion' && issue.field) {
        // Auto-fix boolean coercion
        const fixResult = await applyFix(schema, result.path, issue);
        if (fixResult.action === 'fixed') {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.green(`    ✓ Coerced ${issue.field} to boolean`));
          fixed++;
        } else {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.red(`    ✗ Failed to coerce ${issue.field}: ${fixResult.message}`));
          failed++;
        }
      } else if (issue.code === 'unknown-enum-casing' && issue.field && (issue.canonicalValue || issue.meta?.['suggested'])) {
        // Auto-fix enum casing
        const fixResult = await applyFix(schema, result.path, issue);
        if (fixResult.action === 'fixed') {
          const canonicalValue = issue.canonicalValue ?? (issue.meta?.['suggested'] as string | undefined) ?? '';
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.green(`    ✓ Fixed ${issue.field} casing: ${issue.value} → ${canonicalValue}`));
          fixed++;
        } else {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.red(`    ✗ Failed to fix ${issue.field}: ${fixResult.message}`));
          failed++;
        }
      } else if (issue.code === 'duplicate-list-values' && issue.field) {
        // Auto-fix duplicate list values
        const fixResult = await applyFix(schema, result.path, issue);
        if (fixResult.action === 'fixed') {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.green(`    ✓ Deduplicated ${issue.field}`));
          fixed++;
        } else {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.red(`    ✗ Failed to dedupe ${issue.field}: ${fixResult.message}`));
          failed++;
        }
      } else if (issue.code === 'illegal-aliases' && issue.field) {
        // Clean an alias list: drop empty/whitespace entries and dedupe. Only
        // dispatched for auto-fixable issues (those with no non-string entry).
        const fixResult = await applyFix(schema, result.path, issue);
        if (fixResult.action === 'fixed') {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.green(`    ✓ Cleaned aliases in ${issue.field}`));
          fixed++;
        } else {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.red(`    ✗ Failed to clean ${issue.field}: ${fixResult.message}`));
          failed++;
        }
      } else if (issue.code === 'unlinked-mention') {
        // Only exact/alias mentions are auto-fixable (fuzzy/ambiguous are
        // flag-only and never reach here, since autoFixable is false on them).
        const fixResult = await applyFix(schema, result.path, issue);
        if (fixResult.action === 'fixed') {
          const replacement = (issue.meta?.['replacement'] as string | undefined) ?? '';
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.green(`    ✓ Linked '${String(issue.value)}' → ${replacement}`));
          fixed++;
        } else if (fixResult.action === 'skipped') {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.yellow(`    ⚠ ${fixResult.message}`));
          skipped++;
          registerManualReview(manualReviewNeeded, result.relativePath, issue);
        } else {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.red(`    ✗ Failed to link mention: ${fixResult.message}`));
          failed++;
        }
      } else if ((issue.code === 'frontmatter-key-casing' || issue.code === 'singular-plural-mismatch') && issue.field && issue.canonicalKey) {
        // Auto-fix key casing/singular-plural mismatch
        const fixResult = await applyFix(schema, result.path, issue);
        if (fixResult.action === 'fixed') {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.green(`    ✓ Renamed ${issue.field} → ${issue.canonicalKey}`));
          fixed++;
        } else if (fixResult.action === 'skipped') {
          skipped++;
          registerManualReview(manualReviewNeeded, result.relativePath, issue);
        } else if (fixResult.action === 'failed' && fixResult.message?.includes('manual merge')) {
          // Conflict case - requires interactive resolution
          skipped++;
          registerManualReview(manualReviewNeeded, result.relativePath, issue);
        } else {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.red(`    ✗ Failed to rename ${issue.field}: ${fixResult.message}`));
          failed++;
        }
      } else if (issue.code === 'missing-body-section') {
        // Append the canonical heading scaffold for a declared body section.
        const fixResult = await applyFix(schema, result.path, issue);
        if (fixResult.action === 'fixed') {
          const title = (issue.meta?.['title'] as string | undefined) ?? '';
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.green(`    ✓ Added body section: ${title}`));
          fixed++;
        } else if (fixResult.action === 'skipped') {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.yellow(`    ⚠ ${fixResult.message}`));
          skipped++;
          registerManualReview(manualReviewNeeded, result.relativePath, issue);
        } else {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.red(`    ✗ Failed to add body section: ${fixResult.message}`));
          failed++;
        }
      } else if (issue.code === 'missing-successor') {
        // Spawn the missing recurrence successor (same engine as the fast path).
        const fixResult = await applyMissingSuccessorFix(schema, vaultDir, result.path, issue);
        if (fixResult.action === 'fixed') {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.green(`    ✓ Spawned successor${fixResult.message ? `: ${fixResult.message}` : ''}`));
          fixed++;
        } else if (fixResult.action === 'skipped') {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.yellow(`    ⚠ ${fixResult.message}`));
          skipped++;
          if (!isDryRunEnabled()) {
            registerManualReview(manualReviewNeeded, result.relativePath, issue);
          }
        } else {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.red(`    ✗ Failed to spawn successor: ${fixResult.message}`));
          failed++;
        }
      } else {
        skipped++;
      }
    }
  }

  // Show issues requiring manual review
  if (manualReviewNeeded.length > 0) {
    console.log('');
    console.log(chalk.bold('Issues requiring manual review:'));
    let currentFile = '';
    for (const { file, issue } of manualReviewNeeded) {
      if (file !== currentFile) {
        console.log(chalk.cyan(`  ${file}`));
        currentFile = file;
      }
      const symbol = issue.severity === 'error' ? chalk.red('✗') : chalk.yellow('⚠');
      console.log(`    ${symbol} ${issue.message}`);
    }
  }

  return {
    dryRun,
    ...(dryRunReason ? { dryRunReason } : {}),
    fixed,
    skipped,
    failed,
    remaining: manualReviewNeeded.length,
  };
}

// ============================================================================
// Interactive Fix Mode
// ============================================================================

/**
 * Run interactive fixes, prompting for each issue.
 */
export async function runInteractiveFix(
  results: FileAuditResult[],
  schema: LoadedSchema,
  vaultDir: string,
  options?: { dryRun?: boolean }
): Promise<FixSummary> {
  const dryRun = options?.dryRun ?? false;
  const dryRunReason = dryRun ? 'explicit' : undefined;
  dryRunStorage.enterWith(dryRun);
  const noteTargetIndex = await buildNoteTargetIndex(schema, vaultDir);
  const backlinkScanner = new BacklinkScanner(vaultDir);
  const context: FixContext = { schema, vaultDir, dryRun, noteTargetIndex, backlinkScanner };

  console.log(chalk.bold('Auditing vault...\n'));

  if (results.length === 0) {
    console.log(chalk.green('✓ No issues found\n'));
    return {
      dryRun,
      ...(dryRunReason ? { dryRunReason } : {}),
      fixed: 0,
      skipped: 0,
      failed: 0,
      remaining: 0,
    };
  }

  let fixed = 0;
  let skipped = 0;
  let failed = 0;
  let quit = false;

  for (const result of results) {
    if (quit) break;

    console.log(chalk.cyan(result.relativePath));

    for (const issue of result.issues) {
      if (quit) break;

      const symbol = issue.severity === 'error' ? chalk.red('✗') : chalk.yellow('⚠');
      console.log(`  ${symbol} ${issue.message}`);

      // Handle based on issue type
      const fixOutcome = await handleInteractiveFix(context, result, issue);
      
      if (fixOutcome === 'quit') {
        quit = true;
        console.log(chalk.dim('    → Quit'));
      } else if (fixOutcome === 'fixed') {
        fixed++;
      } else if (fixOutcome === 'failed') {
        failed++;
      } else {
        skipped++;
      }
    }

    console.log('');
  }

  // Count remaining issues (issues not fixed)
  let remaining = 0;
  for (const result of results) {
    remaining += result.issues.length;
  }
  remaining = remaining - fixed;

  return {
    dryRun,
    ...(dryRunReason ? { dryRunReason } : {}),
    fixed,
    skipped,
    failed,
    remaining,
  };
}

/**
 * Handle interactive fix for a single issue.
 * Returns the outcome: 'fixed', 'skipped', 'failed', or 'quit'.
 */
async function handleInteractiveFix(
  context: FixContext,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  const { schema } = context;
  
  switch (issue.code) {
    case 'orphan-file':
      return handleOrphanFileFix(schema, result, issue, context);
    case 'missing-required':
      return handleMissingRequiredFix(schema, result, issue);
    case 'empty-string-required':
      return handleEmptyStringRequiredFix(schema, result, issue);
    case 'invalid-option':
      return handleInvalidOptionFix(schema, result, issue);
    case 'invalid-type':
      return handleInvalidTypeFix(schema, result, issue, context);
    case 'unknown-field':
      return handleUnknownFieldFix(schema, result, issue);
    case 'format-violation':
      return handleFormatViolationFix(schema, result, issue);
    case 'stale-reference':
      return handleStaleReferenceFix(schema, result, issue);
    case 'owned-note-referenced':
      return handleOwnedNoteReferencedFix(schema, result, issue);
    case 'wrong-directory':
      return handleWrongDirectoryFix(context, result, issue);
    case 'owned-wrong-location':
      return handleOwnedWrongLocationFix(context, result, issue);
    case 'invalid-source-type':
      return handleInvalidSourceTypeFix(context, result, issue);
    case 'parent-cycle':
      return handleParentCycleFix(context, result, issue);
    case 'self-reference':
      return handleSelfReferenceFix(context, result, issue);
    case 'ambiguous-link-target':
      return handleAmbiguousLinkTargetFix(context, result, issue);
    case 'invalid-list-element':
      return handleInvalidListElementFix(context, result, issue);
    // Phase 4: Structural integrity issues
    case 'frontmatter-not-at-top':
      return handleFrontmatterNotAtTopFix(schema, result, issue);
    case 'duplicate-frontmatter-keys':
      return handleDuplicateFrontmatterKeysFix(schema, result, issue);
    case 'malformed-wikilink':
      return handleMalformedWikilinkFix(schema, result, issue);
    // Phase 2: Hygiene issues
    case 'trailing-whitespace':
      return handleTrailingWhitespaceFix(context, result, issue);
    case 'invalid-boolean-coercion':
      return handleBooleanCoercionFix(schema, result, issue);
    case 'wrong-scalar-type':
      return handleWrongScalarTypeFix(schema, result, issue);
    case 'invalid-date-format':
      return handleInvalidDateFormatFix(schema, result, issue);
    case 'unknown-enum-casing':
      return handleEnumCasingFix(schema, result, issue);
    case 'duplicate-list-values':
      return handleDuplicateListFix(schema, result, issue);
    case 'illegal-aliases':
      return handleIllegalAliasesFix(schema, result, issue);
    case 'frontmatter-key-casing':
    case 'singular-plural-mismatch':
      return handleKeyCasingFix(schema, result, issue);
    case 'unlinked-mention':
      return handleUnlinkedMentionFix(schema, result, issue);
    case 'missing-body-section':
      return handleBodySectionFix(schema, result, issue);
    case 'missing-successor':
      return handleMissingSuccessorFix(context, result, issue);
    default:
      // Truly non-fixable issues
      if (issue.suggestion) {
        console.log(chalk.dim(`    ${issue.suggestion}`));
      }
      console.log(chalk.dim('    (Manual fix required - skipping)'));
      return 'skipped';
  }
}

// ============================================================================
// Shared interactive-handler scaffold (#598)
// ============================================================================

/**
 * The outcome contract every interactive handler returns. Centralizing the type
 * keeps the many handler signatures (and the shared helpers below) in lock-step.
 */
type InteractiveFixOutcome = 'fixed' | 'skipped' | 'failed' | 'quit';

/**
 * Report the result of an applied fix using the standard three-branch logging
 * that nearly every interactive handler repeats verbatim:
 *
 *   - `fixed`   → green success line (caller supplies the exact message)
 *   - `skipped` → yellow `⚠ <fixResult.message>` line
 *   - `failed`  → red `✗ Failed: <fixResult.message>` line
 *
 * This is a pure logging + mapping helper: it performs no prompting and no
 * filesystem work, so swapping a hand-written tail for a call here is
 * behavior-identical for handlers that already followed this exact shape.
 *
 * The `successMessage` is the text printed after the green check; it must match
 * the previous inline string exactly (callers pass the already-formatted line
 * body, e.g. `Updated foo: bar`).
 */
function reportFixResult(
  fixResult: FixResult,
  successMessage: string
): 'fixed' | 'skipped' | 'failed' {
  if (fixResult.action === 'fixed') {
    console.log(chalk.green(`    ✓ ${successMessage}`));
    return 'fixed';
  }
  if (fixResult.action === 'skipped') {
    console.log(chalk.yellow(`    ⚠ ${fixResult.message}`));
    return 'skipped';
  }
  console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
  return 'failed';
}

/**
 * The simplest, most-repeated interactive scaffold: confirm → quit/skip →
 * `applyFix` → report. Used by the confirm-style handlers that have no
 * per-option branching (boolean coercion, enum casing, dedupe, format
 * conversion, trailing whitespace, etc.).
 *
 * Behavior preserved exactly:
 *   - `promptConfirm` returning `null` (Ctrl+C) → `'quit'`
 *   - a declined confirm → dim `→ Skipped` then `'skipped'`
 *   - otherwise `applyFix` runs and the result is reported via `reportFixResult`
 *
 * `successMessage` is the green line body printed on success. `newValue` is
 * forwarded to `applyFix` so callers that pass a value (or rely on the
 * issue-driven default) keep doing so unchanged.
 */
async function confirmAndApplyFix(
  schema: LoadedSchema,
  result: FileAuditResult,
  issue: AuditIssue,
  confirmMessage: string,
  successMessage: string,
  newValue?: unknown
): Promise<InteractiveFixOutcome> {
  const confirm = await promptConfirm(confirmMessage);
  if (confirm === null) return 'quit';
  if (!confirm) {
    console.log(chalk.dim('    → Skipped'));
    return 'skipped';
  }

  const fixResult = await applyFix(schema, result.path, issue, newValue);
  return reportFixResult(fixResult, successMessage);
}

/**
 * Interactive handler for `missing-successor` (#107): prompt to spawn the
 * missing recurrence successor, using the shared engine.
 */
async function handleMissingSuccessorFix(
  context: FixContext,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  const { schema, vaultDir, dryRun } = context;

  if (dryRun) {
    console.log(chalk.yellow('    ⚠ Would spawn missing successor'));
    return 'fixed';
  }

  const confirmed = await promptConfirm('    Spawn the missing successor?');
  if (confirmed === null) return 'quit';
  if (!confirmed) {
    console.log(chalk.dim('    → Skipped'));
    return 'skipped';
  }

  const fixResult = await applyMissingSuccessorFix(schema, vaultDir, result.path, issue);
  if (fixResult.action === 'fixed') {
    console.log(chalk.green(`    ✓ Spawned successor${fixResult.message ? `: ${fixResult.message}` : ''}`));
    return 'fixed';
  }
  if (fixResult.action === 'skipped') {
    console.log(chalk.yellow(`    ⚠ ${fixResult.message}`));
    return 'skipped';
  }
  // Note: failure here logs `✗ <message>` (no "Failed:" prefix), so this tail
  // intentionally stays inline rather than using reportFixResult.
  console.log(chalk.red(`    ✗ ${fixResult.message}`));
  return 'failed';
}

/**
 * Find all wikilink backlinks to a file, reusing the per-run backlink scanner
 * when available so repeated delete-safety / move lookups don't re-read the
 * whole vault each time. Falls back to a one-off scan when no scanner is present
 * (e.g. callers that build a `FixContext` without one).
 *
 * The fallback path is behavior-identical to the cached path for a given on-disk
 * state — both ultimately use the same `scanWikilinkReferencesInContent` logic.
 */
async function findBacklinkReferences(
  context: FixContext,
  targetPath: string
): Promise<WikilinkReference[]> {
  if (context.backlinkScanner) {
    return context.backlinkScanner.findReferences(targetPath);
  }
  const allFiles = await findAllMarkdownFiles(context.vaultDir);
  return findWikilinksToFile(context.vaultDir, targetPath, allFiles);
}

async function deleteNoteWithSafety(
  context: FixContext,
  result: FileAuditResult
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  const { dryRun } = context;

  try {
    const refs = await findBacklinkReferences(context, result.path);

    console.log(chalk.yellow(`    ⚠ Permanent delete requested for ${result.relativePath}`));
    if (refs.length > 0) {
      console.log(chalk.yellow(`    ⚠ ${refs.length} wikilink(s) reference this note:`));
      for (const ref of refs.slice(0, 5)) {
        console.log(chalk.dim(`      - ${ref.sourceRelativePath}`));
      }
      if (refs.length > 5) {
        console.log(chalk.dim(`      ... and ${refs.length - 5} more`));
      }
    }

    if (dryRun) {
      console.log(chalk.yellow(`    ⚠ Would delete ${result.relativePath}`));
      if (refs.length > 0) {
        console.log(chalk.yellow(`    ⚠ Would leave ${refs.length} backlink(s) unresolved`));
      }
      return 'fixed';
    }

    const confirmed = await promptConfirm('    Delete this note permanently?');
    if (confirmed === null) {
      return 'quit';
    }
    if (!confirmed) {
      console.log(chalk.dim('    → Skipped'));
      return 'skipped';
    }

    if (refs.length > 0) {
      const backlinksConfirmed = await promptConfirm(
        `    Proceed and leave ${refs.length} backlink(s) unresolved?`
      );
      if (backlinksConfirmed === null) {
        return 'quit';
      }
      if (!backlinksConfirmed) {
        console.log(chalk.dim('    → Skipped'));
        return 'skipped';
      }
    }

    await unlink(result.path);
    // Keep the backlink index consistent with the live filesystem: the deleted
    // note can no longer be a backlink source for subsequent operations.
    context.backlinkScanner?.noteDeleted(result.path);
    console.log(chalk.green(`    ✓ Deleted ${result.relativePath}`));
    if (refs.length > 0) {
      console.log(chalk.yellow(`    ⚠ ${refs.length} note(s) still contain links to this file`));
    }
    return 'fixed';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(chalk.red(`    ✗ Failed to delete note: ${message}`));
    return 'failed';
  }
}

async function handleOrphanFileFix(
  schema: LoadedSchema,
  result: FileAuditResult,
  issue: AuditIssue,
  context?: FixContext
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  let typePath: string | undefined;

  const availableTypes = getConcreteTypeNames(schema);

  const inferredLabel = issue.inferredType ? `[add inferred type: ${issue.inferredType}]` : undefined;

  // Deduplicate the inferred type from available types
  const deduplicatedTypes = availableTypes.filter(t => t !== issue.inferredType);

  const options = [
    ...(inferredLabel ? [inferredLabel] : []),
    ...deduplicatedTypes,
    '[delete note]',
    '[skip]',
    '[quit]',
  ];

  const selected = await promptSelection('    Action for orphan file:', options);

  if (selected === null || selected === '[quit]') {
    return 'quit';
  }
  if (selected === '[skip]') {
    console.log(chalk.dim('    → Skipped'));
    return 'skipped';
  }
  if (selected === '[delete note]') {
    if (!context) {
      console.log(chalk.red('    ✗ Failed: missing fix context'));
      return 'failed';
    }
    return deleteNoteWithSafety(context, result);
  }

  if (inferredLabel && selected === inferredLabel) {
    typePath = issue.inferredType;
  } else {
    typePath = selected;
  }

  if (typePath) {
    const fixResult = await applyFix(schema, result.path, issue, typePath);
    if (fixResult.action === 'fixed') {
      const fields = getDiscriminatorFieldsFromTypePath(typePath);
      const fieldStr = Object.entries(fields)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ');
      console.log(chalk.green(`    ✓ Added ${fieldStr}`));
      return 'fixed';
    } else {
      console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
      return 'failed';
    }
  }

  console.log(chalk.dim('    → Skipped'));
  return 'skipped';
}

async function handleMissingRequiredFix(
  schema: LoadedSchema,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  if (!issue.field) return 'skipped';

  const parsed = await parseNote(result.path);
  const defaultValue = getDefaultValue(schema, parsed.frontmatter, issue.field);

  if (defaultValue !== undefined) {
    // Has default value - offer to use it
    const confirm = await promptConfirm(`    → Add with default '${JSON.stringify(defaultValue)}'?`);
    if (confirm === null) {
      return 'quit';
    }
    if (confirm) {
      const fixResult = await applyFix(schema, result.path, issue, defaultValue);
      if (fixResult.action === 'fixed') {
        console.log(chalk.green(`    ✓ Added ${issue.field}: ${JSON.stringify(defaultValue)}`));
        return 'fixed';
      } else {
        console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
        return 'failed';
      }
    }
    console.log(chalk.dim('    → Skipped'));
    return 'skipped';
  }

  // No default - check if field has options or allow text input
  const typePath = resolveTypePathFromFrontmatter(schema, parsed.frontmatter);
  const fieldOptions = typePath ? getOptionsForField(schema, typePath, issue.field) : [];

  if (fieldOptions.length > 0) {
    // Field has options - prompt to select
    const options = [...fieldOptions, '[skip]', '[quit]'];
    const selected = await promptSelection(
      `    Select value for ${issue.field}:`,
      options
    );

    if (selected === null || selected === '[quit]') {
      return 'quit';
    } else if (selected === '[skip]') {
      console.log(chalk.dim('    → Skipped'));
      return 'skipped';
    }

    const fixResult = await applyFix(schema, result.path, issue, selected);
    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Added ${issue.field}: ${selected}`));
      return 'fixed';
    } else {
      console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
      return 'failed';
    }
  }

  // No enum - prompt for text input
  const value = await promptInput(`    Enter value for ${issue.field}:`);
  if (value === null) {
    return 'quit';
  }
  if (value) {
    const fixResult = await applyFix(schema, result.path, issue, value);
    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Added ${issue.field}: ${value}`));
      return 'fixed';
    } else {
      console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
      return 'failed';
    }
  }

  console.log(chalk.dim('    → Skipped'));
  return 'skipped';
}

async function handleEmptyStringRequiredFix(
  schema: LoadedSchema,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  if (!issue.field) return 'skipped';

  const parsed = await parseNote(result.path);
  const defaultValue = getDefaultValue(schema, parsed.frontmatter, issue.field);

  if (defaultValue !== undefined) {
    const confirm = await promptConfirm(`    → Replace with default '${JSON.stringify(defaultValue)}'?`);
    if (confirm === null) {
      return 'quit';
    }
    if (confirm) {
      const fixResult = await setFrontmatterField(schema, result, issue.field, defaultValue);
      if (fixResult.action === 'fixed') {
        console.log(chalk.green(`    ✓ Updated ${issue.field}: ${JSON.stringify(defaultValue)}`));
        return 'fixed';
      }
      console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
      return 'failed';
    }
  }

  const typePath = resolveTypePathFromFrontmatter(schema, parsed.frontmatter);
  const fieldOptions = typePath ? getOptionsForField(schema, typePath, issue.field) : [];

  if (fieldOptions.length > 0) {
    const options = [...fieldOptions, '[quit]'];
    const selected = await promptSelection(
      `    Select value for ${issue.field}:`,
      options
    );

    if (selected === null || selected === '[quit]') {
      return 'quit';
    }

    const fixResult = await setFrontmatterField(schema, result, issue.field, selected);
    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Updated ${issue.field}: ${selected}`));
      return 'fixed';
    }

    console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
    return 'failed';
  }

  while (true) {
    const value = await promptInput(`    Enter value for ${issue.field}:`);
    if (value === null) {
      return 'quit';
    }
    if (!value.trim()) {
      console.log(chalk.yellow('    ⚠ Required field cannot be empty.'));
      continue;
    }

    const fixResult = await setFrontmatterField(schema, result, issue.field, value);
    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Updated ${issue.field}: ${value}`));
      return 'fixed';
    }

    console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
    return 'failed';
  }
}

async function handleInvalidOptionFix(
  schema: LoadedSchema,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  if (!issue.field || !issue.expected || !Array.isArray(issue.expected)) {
    console.log(chalk.dim('    (Cannot fix - skipping)'));
    return 'skipped';
  }

  const options = [...issue.expected, '[skip]', '[quit]'];
  const selected = await promptSelection(
    `    Select valid value for ${issue.field}:`,
    options
  );

  if (selected === null || selected === '[quit]') {
    return 'quit';
  } else if (selected === '[skip]') {
    console.log(chalk.dim('    → Skipped'));
    return 'skipped';
  }

  const fixResult = await applyFix(schema, result.path, issue, selected);
  if (fixResult.action === 'fixed') {
    console.log(chalk.green(`    ✓ Updated ${issue.field}: ${selected}`));
    return 'fixed';
  } else {
    console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
    return 'failed';
  }
}

async function handleUnknownFieldFix(
  schema: LoadedSchema,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  if (!issue.field) return 'skipped';

  if (isBwrbBuiltinFrontmatterField(issue.field)) {
    console.log(chalk.dim(`    → Skipped (system-managed field: ${issue.field})`));
    return 'skipped';
  }

  if (issue.suggestion) {
    console.log(chalk.dim(`    ${issue.suggestion}`));
  }

  const parsed = await parseNote(result.path);
  const typePath = resolveTypePathFromFrontmatter(schema, parsed.frontmatter);
  const schemaFields: Record<string, Field> = typePath ? getFieldsForType(schema, typePath) : {};

  const candidates = getSimilarFieldCandidates(issue.field, schemaFields, issue.value, 3);

  const labelToField = new Map<string, { field: string; typeMismatch: boolean }>();
  const fieldOptions: string[] = [];

  for (const c of candidates) {
    const label = c.typeMismatch ? `${c.field} (TYPE MISMATCH)` : c.field;
    labelToField.set(label, { field: c.field, typeMismatch: c.typeMismatch });
    fieldOptions.push(label);
  }

  const options = [...fieldOptions, '[skip]', '[remove field]', '[quit]'];
  const selected = await promptSelection(
    `    Select target for unknown field '${issue.field}':`,
    options
  );

  if (selected === null || selected === '[quit]') {
    return 'quit';
  }

  if (selected === '[skip]') {
    console.log(chalk.dim('    → Skipped'));
    return 'skipped';
  }

  if (selected === '[remove field]') {
    const fixResult = await removeField(schema, result.path, issue.field);
    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Removed field: ${issue.field}`));
      return 'fixed';
    }

    console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
    return 'failed';
  }

  const choice = labelToField.get(selected);
  if (!choice) {
    console.log(chalk.dim('    → Skipped'));
    return 'skipped';
  }

  const { field: targetField, typeMismatch } = choice;
  const existingTarget = parsed.frontmatter[targetField];
  const targetHasValue = !isEffectivelyEmpty(existingTarget);

  if (typeMismatch) {
    const actualShape = getValueShape(issue.value);
    const expectedShape = getExpectedFieldShape(schemaFields[targetField]);
    console.log(chalk.yellow(`    ⚠ TYPE MISMATCH: '${issue.field}' is ${actualShape}, '${targetField}' expects ${expectedShape}`));

    const mismatchConfirm = await promptConfirm('    TYPE MISMATCH: Proceed with migration?');
    if (mismatchConfirm === null) return 'quit';
    if (!mismatchConfirm) {
      console.log(chalk.dim('    → Skipped'));
      return 'skipped';
    }
  }

  if (targetHasValue) {
    console.log(chalk.dim(`    Current '${targetField}': ${JSON.stringify(existingTarget)}`));
    console.log(chalk.dim(`    New '${targetField}': ${JSON.stringify(issue.value)}`));

    const overwriteConfirm = await promptConfirm(`    Overwrite existing '${targetField}' value?`);
    if (overwriteConfirm === null) return 'quit';
    if (!overwriteConfirm) {
      console.log(chalk.dim('    → Skipped'));
      return 'skipped';
    }
  }

  try {
    const latest = await parseNote(result.path);
    const frontmatter = { ...latest.frontmatter };

    if (!(issue.field in frontmatter)) {
      console.log(chalk.dim(`    (Field '${issue.field}' no longer present - skipping)`));
      return 'skipped';
    }

    frontmatter[targetField] = frontmatter[issue.field];
    delete frontmatter[issue.field];

    const updatedTypePath = resolveTypePathFromFrontmatter(schema, frontmatter);
    const updatedTypeDef = updatedTypePath ? getTypeDefByPath(schema, updatedTypePath) : undefined;
    const order = updatedTypeDef?.fieldOrder;

    if (!isDryRunEnabled()) {
      await writeNote(result.path, frontmatter, latest.body, order);
    }
    console.log(chalk.green(`    ✓ Migrated ${issue.field} → ${targetField}`));
    return 'fixed';
  } catch (err) {
    console.log(chalk.red(`    ✗ Failed: ${err instanceof Error ? err.message : String(err)}`));
    return 'failed';
  }
}

function collectTargetsBySource(
  schema: LoadedSchema,
  source: string | string[],
  targetIndex: NoteTargetIndex
): string[] {
  const sources = Array.isArray(source) ? source : [source];

  if (sources.includes('any')) {
    // `targetToPaths` keys are lowercased (case-insensitive resolution), so they
    // are unsuitable as display/fix targets. Reconstruct real-case basenames from
    // the resolved paths instead.
    const realBasenames = new Set<string>();
    for (const paths of targetIndex.targetToPaths.values()) {
      for (const path of paths) {
        realBasenames.add(basename(path, '.md'));
      }
    }
    return Array.from(realBasenames.values()).sort((a, b) => a.localeCompare(b));
  }

  const validTypes = new Set<string>();
  for (const src of sources) {
    const sourceType = schema.types.get(src);
    if (sourceType) {
      validTypes.add(src);
      for (const descendant of getDescendants(schema, src)) {
        validTypes.add(descendant);
      }
    }
  }

  if (validTypes.size === 0) return [];

  const targets = new Set<string>();
  for (const [pathKey, typeName] of targetIndex.pathNoExtToType.entries()) {
    if (validTypes.has(typeName)) {
      targets.add(pathKey);
      const basenameKey = basename(pathKey);
      targets.add(basenameKey);
    }
  }

  return Array.from(targets.values()).sort((a, b) => a.localeCompare(b));
}

async function handleFormatViolationFix(
  schema: LoadedSchema,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  if (!issue.field || !issue.expectedFormat || !issue.autoFixable) {
    console.log(chalk.dim('    (Cannot auto-fix - skipping)'));
    return 'skipped';
  }

  return confirmAndApplyFix(
    schema,
    result,
    issue,
    `    → Convert to ${issue.expectedFormat} format?`,
    `Converted ${issue.field} to ${issue.expectedFormat}`
  );
}

async function handleStaleReferenceFix(
  schema: LoadedSchema,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  // Stale references in body content can't be auto-fixed easily
  if (issue.inBody) {
    console.log(chalk.dim('    (Body reference - manual fix required)'));
    if (issue.similarFiles && issue.similarFiles.length > 0) {
      console.log(chalk.dim(`    Similar files: ${issue.similarFiles.slice(0, 3).join(', ')}`));
    }
    return 'skipped';
  }

  // For frontmatter fields, offer to select a similar file or clear
  if (!issue.field) {
    console.log(chalk.dim('    (Cannot fix - skipping)'));
    return 'skipped';
  }

  const options: string[] = [];
  if (issue.similarFiles && issue.similarFiles.length > 0) {
    options.push(...issue.similarFiles.slice(0, 5).map(f => `[[${f}]]`));
  }
  options.push('[clear field]', '[skip]', '[quit]');

  const selected = await promptSelection(
    `    Select replacement for '${issue.targetName}':`,
    options
  );

  if (selected === null || selected === '[quit]') {
    return 'quit';
  } else if (selected === '[skip]') {
    console.log(chalk.dim('    → Skipped'));
    return 'skipped';
  } else if (selected === '[clear field]') {
    // Clear the field by setting it to empty
    const fixResult = await applyFix(schema, result.path, { ...issue, code: 'invalid-option' }, '');
    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Cleared ${issue.field}`));
      return 'fixed';
    } else {
      console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
      return 'failed';
    }
  } else {
    // User selected a similar file
    const fixResult = await applyFix(schema, result.path, { ...issue, code: 'invalid-option' }, selected);
    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Updated ${issue.field}: ${selected}`));
      return 'fixed';
    } else {
      console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
      return 'failed';
    }
  }
}

/**
 * Handle owned-note-referenced fix.
 * 
 * This occurs when a note references an owned note via a schema field.
 * Owned notes can only be referenced by their owner.
 * 
 * Options:
 * 1. Clear the reference field
 * 2. Skip (requires manual resolution)
 * 
 * Moving the owned note to shared space would require:
 * - Removing it from owner's field
 * - Moving the file
 * - Updating the reference here
 * This is too complex for automatic fix.
 */
async function handleOwnedNoteReferencedFix(
  schema: LoadedSchema,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  if (!issue.field) {
    console.log(chalk.dim('    (Cannot fix - no field specified)'));
    return 'skipped';
  }

  // Show context
  console.log(chalk.dim(`    Owned by: ${issue.ownerPath}`));
  console.log(chalk.dim('    Options: Clear reference or manually move the note to shared location'));

  const options = ['[clear reference]', '[skip]', '[quit]'];
  const selected = await promptSelection(
    `    Action for reference to owned note:`,
    options
  );

  if (selected === null || selected === '[quit]') {
    return 'quit';
  } else if (selected === '[clear reference]') {
    // Clear the field
    const fixResult = await applyFix(schema, result.path, { ...issue, code: 'invalid-option' }, '');
    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Cleared ${issue.field}`));
      return 'fixed';
    } else {
      console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
      return 'failed';
    }
  }

  console.log(chalk.dim('    → Skipped'));
  return 'skipped';
}

/**
 * Handle invalid-source-type fix.
 * 
 * This occurs when a context field references a note of the wrong type.
 * For example, a task's milestone field referencing an objective instead of a milestone.
 * 
 * Options:
 * 1. Select a valid note of the correct type
 * 2. Clear the field
 * 3. Skip (leave for manual fix)
 */
async function handleInvalidSourceTypeFix(
  context: FixContext,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  if (!issue.field) {
    console.log(chalk.dim('    (Cannot fix - no field specified)'));
    return 'skipped';
  }

  const { schema, vaultDir } = context;

  // Get the source type constraint from the schema
  const parsed = await parseNote(result.path);
  const typePath = resolveTypePathFromFrontmatter(schema, parsed.frontmatter);
  if (!typePath) {
    console.log(chalk.dim('    (Cannot fix - unknown type)'));
    return 'skipped';
  }

  const fields = getFieldsForType(schema, typePath);
  const field = fields[issue.field];
  if (!field || !field.source) {
    console.log(chalk.dim('    (Cannot fix - field source not defined)'));
    return 'skipped';
  }

  // Show context about the type mismatch
  console.log(chalk.dim(`    Current value: ${issue.value}`));
  console.log(chalk.dim(`    Target type: ${issue.actualType}`));
  const expectedTypes = Array.isArray(issue.expected) ? issue.expected.join(', ') : issue.expected;
  console.log(chalk.dim(`    Expected types: ${expectedTypes || field.source}`));

  const targetIndex = await buildNoteTargetIndex(schema, vaultDir);
  const validTargets = collectTargetsBySource(schema, field.source, targetIndex);

  // Build options
  const options: string[] = [];
  if (validTargets.length > 0) {
    // Format as wikilinks
    options.push(...validTargets.slice(0, 20).map(n => `[[${n}]]`));
    if (validTargets.length > 20) {
      options.push(`... (${validTargets.length - 20} more)`);
    }
  }
  options.push('[clear field]', '[skip]', '[quit]');

  const selected = await promptSelection(
    `    Select valid ${field.source}:`,
    options
  );

  if (selected === null || selected === '[quit]') {
    return 'quit';
  } else if (selected === '[skip]' || selected.startsWith('... (')) {
    console.log(chalk.dim('    → Skipped'));
    return 'skipped';
  } else if (selected === '[clear field]') {
    const fixResult = await applyFix(schema, result.path, issue, '');
    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Cleared ${issue.field}`));
      return 'fixed';
    } else {
      console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
      return 'failed';
    }
  } else {
    // User selected a valid note
    const fixResult = await applyFix(schema, result.path, issue, selected);
    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Updated ${issue.field}: ${selected}`));
      return 'fixed';
    } else {
      console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
      return 'failed';
    }
  }
}

/**
 * Handle owned-wrong-location fix.
 * 
 * This occurs when an owned note is not in the expected location
 * (e.g., should be in owner's folder but isn't).
 * 
 * Options:
 * 1. Move file to correct location
 * 2. Skip (leave for manual fix)
 */
async function handleOwnedWrongLocationFix(
  context: FixContext,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  const { vaultDir, dryRun } = context;
  
  // Show context
  console.log(chalk.dim(`    Expected location: ${issue.expectedDirectory}/`));
  console.log(chalk.dim(`    Owner: ${issue.ownerPath}`));

  // Check for wikilinks that will be affected
  const refs = await findBacklinkReferences(context, result.path);

  if (refs.length > 0) {
    console.log(chalk.yellow(`    ⚠ ${refs.length} wikilink(s) will be updated`));
  }

  const options = ['[move file]', '[skip]', '[quit]'];

  const selected = await promptSelection(
    `    Action for misplaced owned note:`,
    options
  );

  if (selected === null || selected === '[quit]') {
    return 'quit';
  } else if (selected === '[move file]' && issue.expectedDirectory) {
    if (dryRun) {
      console.log(chalk.yellow(`    ⚠ Would move to ${issue.expectedDirectory}/`));
      return 'fixed';
    }

    // Execute the move
    const targetDir = join(vaultDir, issue.expectedDirectory);
    const moveResult = await executeBulkMove({
      vaultDir,
      targetDir,
      filesToMove: [result.path],
      execute: true,
    });

    // The move rewrote source files and renamed the moved file; rebuild the
    // backlink index so subsequent lookups reflect the mutated graph.
    context.backlinkScanner?.invalidate();

    if (moveResult.errors.length === 0) {
      console.log(chalk.green(`    ✓ Moved to ${issue.expectedDirectory}/`));
      if (moveResult.totalLinksUpdated > 0) {
        console.log(chalk.green(`    ✓ Updated ${moveResult.totalLinksUpdated} wikilink(s)`));
      }
      return 'fixed';
    } else {
      console.log(chalk.red(`    ✗ Failed to move: ${moveResult.errors[0]}`));
      return 'failed';
    }
  }

  console.log(chalk.dim('    → Skipped'));
  return 'skipped';
}

/**
 * Handle wrong-directory fix.
 * 
 * This occurs when a file is in the wrong directory for its type.
 * 
 * Options:
 * 1. Move file to correct directory
 * 2. Skip (leave for manual fix)
 */
async function handleWrongDirectoryFix(
  context: FixContext,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  const { vaultDir, dryRun } = context;
  
  // Show context
  console.log(chalk.dim(`    Current location: ${dirname(result.relativePath)}/`));
  console.log(chalk.dim(`    Expected location: ${issue.expectedDirectory}/`));

  // Check for wikilinks that will be affected
  const refs = await findBacklinkReferences(context, result.path);

  if (refs.length > 0) {
    console.log(chalk.yellow(`    ⚠ ${refs.length} wikilink(s) will be updated`));
  }

  const options = ['[move file]', '[skip]', '[quit]'];

  const selected = await promptSelection(
    `    Action for wrong directory:`,
    options
  );

  if (selected === null || selected === '[quit]') {
    return 'quit';
  } else if (selected === '[move file]' && issue.expectedDirectory) {
    if (dryRun) {
      console.log(chalk.yellow(`    ⚠ Would move to ${issue.expectedDirectory}/`));
      return 'fixed';
    }

    // Execute the move
    const targetDir = join(vaultDir, issue.expectedDirectory);
    const moveResult = await executeBulkMove({
      vaultDir,
      targetDir,
      filesToMove: [result.path],
      execute: true,
    });

    // The move rewrote source files and renamed the moved file; rebuild the
    // backlink index so subsequent lookups reflect the mutated graph.
    context.backlinkScanner?.invalidate();

    if (moveResult.errors.length === 0) {
      console.log(chalk.green(`    ✓ Moved to ${issue.expectedDirectory}/`));
      if (moveResult.totalLinksUpdated > 0) {
        console.log(chalk.green(`    ✓ Updated ${moveResult.totalLinksUpdated} wikilink(s)`));
      }
      return 'fixed';
    } else {
      console.log(chalk.red(`    ✗ Failed to move: ${moveResult.errors[0]}`));
      return 'failed';
    }
  }

  console.log(chalk.dim('    → Skipped'));
  return 'skipped';
}

/**
 * Handle invalid-type fix.
 * 
 * This occurs when the type field value is not recognized.
 * 
 * Options:
 * 1. Select a valid type from the schema
 * 2. Skip (leave for manual fix)
 */
async function handleInvalidTypeFix(
  schema: LoadedSchema,
  result: FileAuditResult,
  issue: AuditIssue,
  context?: FixContext
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  // Get available types
  const availableTypes = getTypeFamilies(schema);
  
  if (availableTypes.length === 0) {
    console.log(chalk.dim('    (No types defined in schema - skipping)'));
    return 'skipped';
  }
  
  // Show current invalid value
  console.log(chalk.dim(`    Current value: ${issue.value}`));
  if (issue.suggestion) {
    console.log(chalk.dim(`    ${issue.suggestion}`));
  }
  
  const options = [...availableTypes, '[delete note]', '[skip]', '[quit]'];
  const selected = await promptSelection(
    '    Select valid type:',
    options
  );

  if (selected === null || selected === '[quit]') {
    return 'quit';
  } else if (selected === '[delete note]') {
    if (!context) {
      console.log(chalk.red('    ✗ Failed: missing fix context'));
      return 'failed';
    }
    return deleteNoteWithSafety(context, result);
  } else if (selected === '[skip]') {
    console.log(chalk.dim('    → Skipped'));
    return 'skipped';
  }

  // Apply the fix - update the type field
  const fixResult = await applyFix(schema, result.path, { ...issue, code: 'orphan-file' }, selected);
  if (fixResult.action === 'fixed') {
    const fields = getDiscriminatorFieldsFromTypePath(selected);
    const fieldStr = Object.entries(fields)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
    console.log(chalk.green(`    ✓ Updated ${fieldStr}`));
    return 'fixed';
  } else {
    console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
    return 'failed';
  }
}

/**
 * Handle parent-cycle fix.
 * 
 * This occurs when a recursive type has a cycle in its parent references.
 * E.g., A -> B -> A creates a cycle.
 * 
 * Options:
 * 1. Clear the parent field
 * 2. Select a different parent
 * 3. Skip (leave for manual fix)
 */
async function handleParentCycleFix(
  context: FixContext,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  const { schema, vaultDir } = context;

  // Show the cycle path
  if (issue.cyclePath && issue.cyclePath.length > 0) {
    console.log(chalk.dim(`    Cycle: ${issue.cyclePath.join(' → ')}`));
  }
  
  // Get the current note's name to exclude from parent options
  const noteName = basename(result.path, '.md');
  
  // Get notes of the same type to offer as alternative parents
  const parsed = await parseNote(result.path);
  const typePath = resolveTypePathFromFrontmatter(schema, parsed.frontmatter);
  let validParents: string[] = [];
  
  if (typePath) {
    const targetIndex = await buildNoteTargetIndex(schema, vaultDir);
    const validTargets = collectTargetsBySource(schema, typePath, targetIndex);
    // Filter out the current note and notes in the cycle
    const cycleSet = new Set(issue.cyclePath ?? []);
    validParents = validTargets.filter(n => n !== noteName && !cycleSet.has(n));
  }
  
  // Build options
  const options: string[] = ['[clear parent]'];
  if (validParents.length > 0) {
    // Add up to 10 valid parent options as wikilinks
    options.push(...validParents.slice(0, 10).map(n => `[[${n}]]`));
    if (validParents.length > 10) {
      options.push(`... (${validParents.length - 10} more options)`);
    }
  }
  options.push('[skip]', '[quit]');
  
  const selected = await promptSelection(
    '    Action for parent cycle:',
    options
  );

  if (selected === null || selected === '[quit]') {
    return 'quit';
  } else if (selected === '[skip]' || selected.startsWith('... (')) {
    console.log(chalk.dim('    → Skipped'));
    return 'skipped';
  } else if (selected === '[clear parent]') {
    // Clear the parent field
    const fixResult = await applyFix(schema, result.path, { ...issue, code: 'invalid-option', field: 'parent' }, '');
    if (fixResult.action === 'fixed') {
      console.log(chalk.green('    ✓ Cleared parent field'));
      return 'fixed';
    } else {
      console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
      return 'failed';
    }
  } else {
    // User selected a new parent
    const fixResult = await applyFix(schema, result.path, { ...issue, code: 'invalid-option', field: 'parent' }, selected);
    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Updated parent: ${selected}`));
      return 'fixed';
    } else {
      console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
      return 'failed';
    }
  }
}

async function handleFrontmatterNotAtTopFix(
  schema: LoadedSchema,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  if (!issue.autoFixable) {
    console.log(chalk.dim('    (Ambiguous frontmatter; manual fix required - skipping)'));
    return 'skipped';
  }

  return confirmAndApplyFix(
    schema,
    result,
    issue,
    '    → Move frontmatter to the top of the file?',
    'Moved frontmatter to top'
  );
}

async function handleDuplicateFrontmatterKeysFix(
  schema: LoadedSchema,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  const key = issue.duplicateKey ?? issue.field;
  if (!key) return 'skipped';

  const options = ['keep last', 'keep first', '[skip]', '[quit]'];
  const selected = await promptSelection(
    `    Resolve duplicate key '${key}':`,
    options
  );

  if (selected === null || selected === '[quit]') {
    return 'quit';
  }
  if (selected === '[skip]') {
    console.log(chalk.dim('    → Skipped'));
    return 'skipped';
  }

  const strategy = selected === 'keep first' ? 'keep-first' : 'keep-last';
  const fixResult = await applyFix(schema, result.path, issue, strategy);
  return reportFixResult(fixResult, `Resolved duplicate key '${key}' (${selected})`);
}

async function handleMalformedWikilinkFix(
  schema: LoadedSchema,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  const loc = issue.listIndex !== undefined
    ? `${issue.field}[${issue.listIndex}]`
    : issue.field;

  return confirmAndApplyFix(
    schema,
    result,
    issue,
    `    → Fix malformed wikilink${loc ? ` in '${loc}'` : ''}?`,
    'Fixed malformed wikilink'
  );
}

async function updateFrontmatterValue(
  schema: LoadedSchema,
  result: FileAuditResult,
  update: (frontmatter: Record<string, unknown>) => boolean
): Promise<FixResult> {
  try {
    const parsed = await parseNote(result.path);
    const frontmatter = { ...parsed.frontmatter };
    const changed = update(frontmatter);
    if (!changed) {
      return {
        file: result.path,
        issue: { severity: 'warning', code: 'invalid-option', message: '', autoFixable: false },
        action: 'skipped',
        message: 'No changes applied',
      };
    }

    const typePath = resolveTypePathFromFrontmatter(schema, frontmatter);
    const typeDef = typePath ? getTypeDefByPath(schema, typePath) : undefined;
    const order = typeDef?.fieldOrder;

    if (!isDryRunEnabled()) {
      await writeNote(result.path, frontmatter, parsed.body, order);
    }

    return {
      file: result.path,
      issue: { severity: 'warning', code: 'invalid-option', message: '', autoFixable: false },
      action: 'fixed',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      file: result.path,
      issue: { severity: 'warning', code: 'invalid-option', message: '', autoFixable: false },
      action: 'failed',
      message,
    };
  }
}

async function setFrontmatterField(
  schema: LoadedSchema,
  result: FileAuditResult,
  field: string,
  value: unknown
): Promise<FixResult> {
  return updateFrontmatterValue(schema, result, (frontmatter) => {
    if (!(field in frontmatter)) return false;
    frontmatter[field] = value;
    return true;
  });
}

async function clearFrontmatterField(
  schema: LoadedSchema,
  result: FileAuditResult,
  field: string
): Promise<FixResult> {
  return updateFrontmatterValue(schema, result, (frontmatter) => {
    if (!(field in frontmatter)) return false;
    delete frontmatter[field];
    return true;
  });
}

function formatMarkdownLinkValue(label: string, path: string): string {
  return `"[${label}](${path})"`;
}

function getShortestLinkTarget(candidatePath: string, targetIndex?: NoteTargetIndex): string {
  const basenameTarget = basename(candidatePath, '.md');
  // `targetToPaths` is keyed by the lowercased target (case-insensitive
  // resolution); look up accordingly so a unique basename still shortens.
  const matches = targetIndex?.targetToPaths.get(basenameTarget.toLowerCase()) ?? [];
  if (matches.length === 1) {
    return basenameTarget;
  }
  return candidatePath.replace(/\.md$/, '');
}

function formatRelationTarget(
  candidatePath: string,
  linkFormat: 'wikilink' | 'markdown',
  targetIndex?: NoteTargetIndex
): string {
  if (linkFormat === 'wikilink') {
    const target = getShortestLinkTarget(candidatePath, targetIndex);
    return formatValue(target, 'wikilink');
  }

  const label = basename(candidatePath, '.md');
  return formatMarkdownLinkValue(label, candidatePath);
}

async function handleSelfReferenceFix(
  context: FixContext,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  if (!issue.field) {
    console.log(chalk.dim('    (Cannot fix - no field specified)'));
    return 'skipped';
  }

  const { schema, noteTargetIndex } = context;
  const parsed = await parseNote(result.path);
  const typePath = resolveTypePathFromFrontmatter(schema, parsed.frontmatter);
  const fields = typePath ? getFieldsForType(schema, typePath) : {};
  const field = fields[issue.field];
  const linkFormat = schema.config.linkFormat ?? 'wikilink';
  const isRequired = field?.required === true;

  const options: string[] = [];
  const labelToTarget = new Map<string, string>();

  if (!isRequired) {
    options.push('[clear field]');
  }

  if (field?.source && noteTargetIndex) {
    const validTargets = collectTargetsBySource(schema, field.source, noteTargetIndex);
    const noteName = basename(result.path, '.md');
    const notePathKey = result.relativePath.replace(/\.md$/, '');
    const filteredTargets = validTargets.filter(
      (target) => target !== noteName && target !== notePathKey
    );

    if (filteredTargets.length > 0) {
      for (const target of filteredTargets.slice(0, 20)) {
        const label = linkFormat === 'markdown'
          ? formatMarkdownLinkValue(basename(target), `${target}.md`)
          : formatValue(target, linkFormat);
        options.push(label);
        labelToTarget.set(label, target);
      }
      if (filteredTargets.length > 20) {
        options.push(`... (${filteredTargets.length - 20} more)`);
      }
    }
  }

  options.push('[skip]', '[quit]');

  const selected = await promptSelection(
    `    Action for self-reference in ${issue.field}:`,
    options
  );

  if (selected === null || selected === '[quit]') {
    return 'quit';
  }

  if (selected === '[skip]' || selected.startsWith('... (')) {
    console.log(chalk.dim('    → Skipped'));
    return 'skipped';
  }

  if (selected === '[clear field]') {
    const fixResult = await clearFrontmatterField(schema, result, issue.field);
    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Cleared ${issue.field}`));
      return 'fixed';
    }
    console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
    return 'failed';
  }

  const target = labelToTarget.get(selected) ?? selected;
  const formatted = linkFormat === 'markdown'
    ? formatMarkdownLinkValue(basename(target), `${target}.md`)
    : formatValue(target.replace(/^"|"$/g, ''), linkFormat);
  const fixResult = await setFrontmatterField(schema, result, issue.field, formatted);
  if (fixResult.action === 'fixed') {
    console.log(chalk.green(`    ✓ Updated ${issue.field}: ${formatted}`));
    return 'fixed';
  }
  console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
  return 'failed';
}

async function handleAmbiguousLinkTargetFix(
  context: FixContext,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  if (!issue.field || !issue.candidates || issue.candidates.length === 0) {
    console.log(chalk.dim('    (Cannot fix - no candidates)'));
    return 'skipped';
  }

  const { schema, noteTargetIndex } = context;
  const linkFormat = schema.config.linkFormat ?? 'wikilink';

  const parsed = await parseNote(result.path);
  const typePath = resolveTypePathFromFrontmatter(schema, parsed.frontmatter);
  const fields = typePath ? getFieldsForType(schema, typePath) : {};
  const field = fields[issue.field];
  const isRequired = field?.required === true;

  const labelToCandidate = new Map<string, string>();
  const candidateOptions = issue.candidates.map((candidate) => {
    const label = `${basename(candidate, '.md')} (${candidate})`;
    labelToCandidate.set(label, candidate);
    return label;
  });

  const options = [
    ...candidateOptions,
    ...(isRequired ? [] : ['[clear field]']),
    '[skip]',
    '[quit]',
  ];

  const selected = await promptSelection(
    `    Select target for ${issue.field}:`,
    options
  );

  if (selected === null || selected === '[quit]') {
    return 'quit';
  }

  if (selected === '[skip]') {
    console.log(chalk.dim('    → Skipped'));
    return 'skipped';
  }

  if (selected === '[clear field]') {
    const fixResult = await clearFrontmatterField(schema, result, issue.field);
    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Cleared ${issue.field}`));
      return 'fixed';
    }
    console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
    return 'failed';
  }

  const candidatePath = labelToCandidate.get(selected) ?? selected;
  const formatted = formatRelationTarget(candidatePath, linkFormat, noteTargetIndex);
  const fixResult = await setFrontmatterField(schema, result, issue.field, formatted);
  if (fixResult.action === 'fixed') {
    console.log(chalk.green(`    ✓ Updated ${issue.field}: ${formatted}`));
    return 'fixed';
  }
  console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
  return 'failed';
}

async function handleInvalidListElementFix(
  context: FixContext,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  if (!issue.field) {
    console.log(chalk.dim('    (Cannot fix - no field specified)'));
    return 'skipped';
  }

  const { schema } = context;
  const fieldName = issue.field;
  const listIndex = issue.listIndex;

  if (listIndex === undefined) {
    console.log(chalk.dim('    (Cannot fix - no list index)'));
    return 'skipped';
  }

  const parsed = await parseNote(result.path);
  const typePath = resolveTypePathFromFrontmatter(schema, parsed.frontmatter);
  const fields = typePath ? getFieldsForType(schema, typePath) : {};
  const field = fields[fieldName];
  const isRequired = field?.required === true;

  const current = parsed.frontmatter[fieldName];
  if (!Array.isArray(current)) {
    console.log(chalk.dim('    (Cannot fix - value is not a list)'));
    return 'skipped';
  }
  if (listIndex < 0 || listIndex >= current.length) {
    console.log(chalk.dim('    (Cannot fix - index out of range)'));
    return 'skipped';
  }

  const element = current[listIndex];
  const reason = typeof issue.meta?.['reason'] === 'string' ? issue.meta['reason'] : undefined;
  const canRemove = !isRequired || current.length > 1;
  const canCoerce = typeof element === 'number' || typeof element === 'boolean';
  const canFlatten = Array.isArray(element) && current.length === 1 && element.every((entry) => typeof entry === 'string');

  const options: string[] = [];
  if (canFlatten) options.push('[flatten list]');
  if (canCoerce) options.push('[coerce element]');
  if (canRemove) options.push('[remove element]');
  options.push('[edit element]', '[skip]', '[quit]');

  const selected = await promptSelection(
    `    Fix list value for ${fieldName}:`,
    options
  );

  if (selected === null || selected === '[quit]') {
    return 'quit';
  }

  if (selected === '[skip]') {
    console.log(chalk.dim('    → Skipped'));
    return 'skipped';
  }

  if (selected === '[flatten list]' && canFlatten) {
    const fixResult = await updateFrontmatterValue(schema, result, (frontmatter) => {
      const list = frontmatter[fieldName];
      if (!Array.isArray(list) || list.length !== 1) return false;
      const nested = list[0];
      if (!Array.isArray(nested) || !nested.every((entry) => typeof entry === 'string')) return false;
      frontmatter[fieldName] = nested;
      return true;
    });

    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Flattened ${fieldName}`));
      return 'fixed';
    }
    console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
    return 'failed';
  }

  if (selected === '[coerce element]' && canCoerce) {
    const fixResult = await updateFrontmatterValue(schema, result, (frontmatter) => {
      const list = frontmatter[fieldName];
      if (!Array.isArray(list)) return false;
      if (listIndex < 0 || listIndex >= list.length) return false;
      list[listIndex] = String(list[listIndex]);
      frontmatter[fieldName] = list;
      return true;
    });

    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Coerced ${fieldName}[${listIndex}] to string`));
      return 'fixed';
    }
    console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
    return 'failed';
  }

  if (selected === '[remove element]' && canRemove) {
    const fixResult = await updateFrontmatterValue(schema, result, (frontmatter) => {
      const list = frontmatter[fieldName];
      if (!Array.isArray(list)) return false;
      if (listIndex < 0 || listIndex >= list.length) return false;
      list.splice(listIndex, 1);
      frontmatter[fieldName] = list;
      return true;
    });

    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Removed invalid element from ${fieldName}`));
      return 'fixed';
    }
    console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
    return 'failed';
  }

  if (selected === '[edit element]') {
    const value = await promptInput(`    Enter value for ${fieldName}[${listIndex}]:`);
    if (value === null) return 'quit';
    if (!value) {
      console.log(chalk.dim('    → Skipped'));
      return 'skipped';
    }

    const fixResult = await updateFrontmatterValue(schema, result, (frontmatter) => {
      const list = frontmatter[fieldName];
      if (!Array.isArray(list)) return false;
      if (listIndex < 0 || listIndex >= list.length) return false;
      list[listIndex] = value;
      frontmatter[fieldName] = list;
      return true;
    });

    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Updated ${fieldName}[${listIndex}]`));
      return 'fixed';
    }
    console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
    return 'failed';
  }

  if (reason) {
    console.log(chalk.dim(`    (Cannot fix ${reason} - skipping)`));
  }
  console.log(chalk.dim('    → Skipped'));
  return 'skipped';
}

// ============================================================================
// Phase 2: Hygiene Issue Handlers
// ============================================================================

/**
 * Handle trailing whitespace fix.
 */
async function handleTrailingWhitespaceFix(
  context: FixContext,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  if (!issue.field) return 'skipped';

  const { schema } = context;

  const confirm = await promptConfirm(
    `    → Trim whitespace from '${issue.field}'?`
  );
  if (confirm === null) return 'quit';
  if (!confirm) {
    console.log(chalk.dim('    → Skipped'));
    return 'skipped';
  }

  const fixResult = await applyFix(schema, result.path, issue);
  if (fixResult.action === 'fixed') {
    console.log(chalk.green(`    ✓ Trimmed whitespace from ${issue.field}`));
    return 'fixed';
  } else if (fixResult.action === 'skipped') {
    console.log(chalk.dim('    → Skipped'));
    return 'skipped';
  } else {
    console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
    return 'failed';
  }
}

/**
 * Handle an unlinked-mention fix interactively.
 *
 * Exact/alias mentions (autoFixable) offer to convert the plain-text mention to
 * a wikilink. Ambiguous mentions (multiple candidate entities) prompt the human
 * to pick one candidate (or skip), then rewrite using the SAME mention-rewrite
 * as the exact/alias auto-fix (#622). Fuzzy mentions remain flag-only: we
 * surface the suggestion and skip (never auto-resolve fuzziness).
 *
 * This handler runs ONLY in interactive `--fix` (a TTY). `--auto` and non-TTY
 * paths never reach here for non-autoFixable issues, so ambiguous mentions are
 * never auto-resolved.
 */
async function handleUnlinkedMentionFix(
  schema: LoadedSchema,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  if (!issue.autoFixable) {
    // Ambiguous mentions: interactive pick-a-candidate (#622).
    if (
      issue.meta?.['tier'] === 'ambiguous' &&
      issue.candidates &&
      issue.candidates.length > 0
    ) {
      return handleAmbiguousMentionFix(schema, result, issue);
    }
    // Fuzzy — review only.
    if (issue.suggestion) {
      console.log(chalk.dim(`    ${issue.suggestion}`));
    }
    console.log(chalk.dim('    (Review item — not auto-linked)'));
    return 'skipped';
  }

  const replacement = (issue.meta?.['replacement'] as string | undefined) ?? '';
  const confirm = await promptConfirm(
    `    → Link '${String(issue.value)}' to ${replacement}?`
  );
  if (confirm === null) return 'quit';
  if (!confirm) {
    console.log(chalk.dim('    → Skipped'));
    return 'skipped';
  }

  const fixResult = await applyFix(schema, result.path, issue);
  if (fixResult.action === 'fixed') {
    console.log(chalk.green(`    ✓ Linked '${String(issue.value)}' → ${replacement}`));
    return 'fixed';
  } else if (fixResult.action === 'skipped') {
    console.log(chalk.dim(`    → Skipped: ${fixResult.message}`));
    return 'skipped';
  } else {
    console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
    return 'failed';
  }
}

/**
 * Interactive resolution of an *ambiguous* unlinked mention (#622): the surface
 * matches multiple distinct entities, so it is never auto-resolved. In a TTY,
 * offer the candidate entities (plus skip/quit) and, on selection, rewrite the
 * plain-text mention to `[[Chosen]]` (or `[[Chosen|surface]]` when the surface
 * differs from the chosen note name).
 *
 * The rewrite REUSES the exact/alias auto-fix path: it synthesizes a
 * `replacement` + `surface` on the issue meta and dispatches to
 * {@link applyUnlinkedMentionFix} via {@link applyFix}, so the masking and
 * word-boundary guarantees are identical and idempotent. Never invoked outside
 * interactive `--fix` (so `--auto`/non-TTY never auto-resolve ambiguity).
 */
async function handleAmbiguousMentionFix(
  schema: LoadedSchema,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  const candidates = issue.candidates ?? [];
  const surface =
    (issue.meta?.['surface'] as string | undefined) ??
    (typeof issue.value === 'string' ? issue.value : undefined);
  if (candidates.length === 0 || !surface) {
    console.log(chalk.dim('    (Cannot resolve — no candidates)'));
    return 'skipped';
  }

  const options = [...candidates, '[skip]', '[quit]'];
  const selected = await promptSelection(
    `    Resolve ambiguous mention '${surface}' to:`,
    options
  );

  if (selected === null || selected === '[quit]') {
    return 'quit';
  }
  if (selected === '[skip]') {
    console.log(chalk.dim('    → Skipped'));
    return 'skipped';
  }

  const canonical = selected;
  // Mirror the exact-tier replacement logic: keep the author's surface via the
  // display form when it differs from the chosen canonical note name.
  const replacement =
    surface !== canonical ? `[[${canonical}|${surface}]]` : `[[${canonical}]]`;

  // Synthesize an auto-fixable issue that the shared mention-rewrite understands.
  const fixIssue: AuditIssue = {
    ...issue,
    autoFixable: true,
    targetName: canonical,
    meta: { ...(issue.meta ?? {}), surface, replacement },
  };

  const fixResult = await applyFix(schema, result.path, fixIssue);
  if (fixResult.action === 'fixed') {
    console.log(chalk.green(`    ✓ Linked '${surface}' → ${replacement}`));
    return 'fixed';
  } else if (fixResult.action === 'skipped') {
    console.log(chalk.dim(`    → Skipped: ${fixResult.message}`));
    return 'skipped';
  } else {
    console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
    return 'failed';
  }
}

/**
 * Handle a missing body section interactively (#510): confirm, then append the
 * canonical heading scaffold.
 */
async function handleBodySectionFix(
  schema: LoadedSchema,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  const title = (issue.meta?.['title'] as string | undefined) ?? '';
  return confirmAndApplyFix(
    schema,
    result,
    issue,
    `    → Add body section "${title}"?`,
    `Added body section: ${title}`
  );
}

/**
 * Handle boolean coercion fix.
 */
async function handleBooleanCoercionFix(
  schema: LoadedSchema,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  if (!issue.field) return 'skipped';

  return confirmAndApplyFix(
    schema,
    result,
    issue,
    `    → Convert '${issue.value}' to boolean in '${issue.field}'?`,
    `Converted ${issue.field} to boolean`
  );
}

async function handleWrongScalarTypeFix(
  schema: LoadedSchema,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  if (!issue.field) return 'skipped';

  // Per-element numeric date quoting (#673): a valid numeric element of a
  // multiple date field just needs quoting in place. Handle it before the
  // whole-field paths below (which would otherwise try to collapse the array).
  // Index-safe + idempotent: only quote an element that is still a number, and
  // store the JS string so yaml force-quotes it (round-trip stable, #700).
  if (issue.listIndex !== undefined && issue.meta?.['action'] === 'quote-element') {
    const listIndex = issue.listIndex;
    const quoted =
      typeof issue.meta['quoted'] === 'string' ? issue.meta['quoted'] : undefined;
    const confirm = await promptConfirm(`    → Quote ${issue.field}[${listIndex}] as a string?`);
    if (confirm === null) return 'quit';
    if (!confirm) {
      console.log(chalk.dim('    → Skipped'));
      return 'skipped';
    }
    const fixResult = await updateFrontmatterValue(schema, result, (frontmatter) => {
      const current = frontmatter[issue.field!];
      if (!Array.isArray(current)) return false;
      if (listIndex < 0 || listIndex >= current.length) return false;
      if (typeof current[listIndex] !== 'number') return false;
      current[listIndex] = quoted ?? String(current[listIndex]);
      frontmatter[issue.field!] = current;
      return true;
    });
    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Quoted ${issue.field}[${listIndex}]`));
      return 'fixed';
    }
    if (fixResult.action === 'skipped') {
      console.log(chalk.dim(`    → ${fixResult.message}`));
      return 'skipped';
    }
    console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
    return 'failed';
  }

  const parsed = await parseNote(result.path);
  const currentValue = parsed.frontmatter[issue.field];
  const typePath = resolveTypePathFromFrontmatter(schema, parsed.frontmatter);
  const fields = typePath ? getFieldsForType(schema, typePath) : {};
  const field = fields[issue.field];
  const expectsList = field?.prompt === 'list' || field?.multiple === true;
  const expectedScalar = field ? getExpectedScalarType(field) : (issue.expected as 'string' | 'number' | 'boolean' | undefined) ?? 'string';

  if (expectsList) {
    const wrapped = getScalarToList(currentValue);
    if (!wrapped.ok) {
      console.log(chalk.dim('    (Cannot wrap into list - skipping)'));
      return 'skipped';
    }

    const confirm = await promptConfirm(`    → Wrap ${issue.field} into a list?`);
    if (confirm === null) return 'quit';
    if (!confirm) {
      console.log(chalk.dim('    → Skipped'));
      return 'skipped';
    }

    const fixResult = await setFrontmatterField(schema, result, issue.field, wrapped.value);
    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Wrapped ${issue.field} into list`));
      return 'fixed';
    }
    console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
    return 'failed';
  }

  if (Array.isArray(currentValue)) {
    if (currentValue.length === 1) {
      const coerced = getScalarFromList(currentValue, expectedScalar);
      if (coerced.ok) {
        const confirm = await promptConfirm(`    → Use ${JSON.stringify(coerced.value)} for ${issue.field}?`);
        if (confirm === null) return 'quit';
        if (!confirm) {
          console.log(chalk.dim('    → Skipped'));
          return 'skipped';
        }
        const fixResult = await setFrontmatterField(schema, result, issue.field, coerced.value);
        if (fixResult.action === 'fixed') {
          console.log(chalk.green(`    ✓ Updated ${issue.field}: ${JSON.stringify(coerced.value)}`));
          return 'fixed';
        }
        console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
        return 'failed';
      }
    }

    const options = currentValue.map((item) => JSON.stringify(item));
    const selected = await promptSelection(
      `    Select value for ${issue.field}:`,
      [...options, '[skip]', '[quit]']
    );
    if (selected === null || selected === '[quit]') return 'quit';
    if (selected === '[skip]') {
      console.log(chalk.dim('    → Skipped'));
      return 'skipped';
    }

    const index = options.indexOf(selected);
    const chosen = currentValue[index];
    const coerced = getScalarCoercion(chosen, expectedScalar);
    if (!coerced.ok) {
      console.log(chalk.yellow('    ⚠ Selected value cannot be coerced.'));
      return 'skipped';
    }
    const fixResult = await setFrontmatterField(schema, result, issue.field, coerced.value);
    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Updated ${issue.field}: ${JSON.stringify(coerced.value)}`));
      return 'fixed';
    }
    console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
    return 'failed';
  }

  const coercion = getScalarCoercion(currentValue, expectedScalar);
  if (coercion.ok && coercion.kind !== 'identity') {
    const confirm = await promptConfirm(`    → Coerce ${issue.field} to ${expectedScalar} (${JSON.stringify(coercion.value)})?`);
    if (confirm === null) return 'quit';
    if (confirm) {
      const fixResult = await setFrontmatterField(schema, result, issue.field, coercion.value);
      if (fixResult.action === 'fixed') {
        console.log(chalk.green(`    ✓ Updated ${issue.field}: ${JSON.stringify(coercion.value)}`));
        return 'fixed';
      }
      console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
      return 'failed';
    }
  }

  const value = await promptInput(`    Enter ${expectedScalar} for ${issue.field}:`);
  if (value === null) return 'quit';
  if (!value.trim()) {
    console.log(chalk.dim('    → Skipped'));
    return 'skipped';
  }

  if (expectedScalar === 'number') {
    const resultValue = coerceNumberFromString(value);
    if (!resultValue.ok) {
      console.log(chalk.yellow('    ⚠ Invalid number format.'));
      return 'skipped';
    }
    const fixResult = await setFrontmatterField(schema, result, issue.field, resultValue.value);
    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Updated ${issue.field}: ${resultValue.value}`));
      return 'fixed';
    }
    console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
    return 'failed';
  }

  if (expectedScalar === 'boolean') {
    const resultValue = coerceBooleanFromString(value);
    if (!resultValue.ok) {
      console.log(chalk.yellow('    ⚠ Invalid boolean. Use true/false.'));
      return 'skipped';
    }
    const fixResult = await setFrontmatterField(schema, result, issue.field, resultValue.value);
    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Updated ${issue.field}: ${resultValue.value}`));
      return 'fixed';
    }
    console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
    return 'failed';
  }

  const fixResult = await setFrontmatterField(schema, result, issue.field, value);
  if (fixResult.action === 'fixed') {
    console.log(chalk.green(`    ✓ Updated ${issue.field}: ${value}`));
    return 'fixed';
  }
  console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
  return 'failed';
}

async function handleInvalidDateFormatFix(
  schema: LoadedSchema,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  if (!issue.field || typeof issue.value !== 'string') return 'skipped';

  const suggestion = suggestIsoDate(issue.value);
  if (suggestion) {
    console.log(chalk.dim(`    Suggested: ${suggestion}`));
  }

  const value = await promptInput(`    Enter YYYY-MM-DD for ${issue.field}:`, suggestion ?? undefined);
  if (value === null) return 'quit';
  if (!value.trim()) {
    console.log(chalk.dim('    → Skipped'));
    return 'skipped';
  }

  const trimmed = value.trim();
  let normalizedValue: string | null = null;

  if (isCanonicalIsoDate(trimmed)) {
    normalizedValue = trimmed;
  } else {
    const normalization = getUnambiguousDateNormalization(trimmed);
    normalizedValue = normalization ? normalization.normalized : null;
  }

  if (!normalizedValue) {
    console.log(chalk.yellow('    ⚠ Invalid date format. Use YYYY-MM-DD.'));
    return 'skipped';
  }

  const fixResult = await setFrontmatterField(schema, result, issue.field, normalizedValue);
  if (fixResult.action === 'fixed') {
    console.log(chalk.green(`    ✓ Updated ${issue.field}: ${normalizedValue}`));
    return 'fixed';
  }
  console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
  return 'failed';
}


/**
 * Handle enum casing fix.
 */
async function handleEnumCasingFix(
  schema: LoadedSchema,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  if (!issue.field || !issue.canonicalValue) return 'skipped';

  return confirmAndApplyFix(
    schema,
    result,
    issue,
    `    → Change '${issue.value}' to '${issue.canonicalValue}'?`,
    `Fixed casing: ${issue.value} → ${issue.canonicalValue}`
  );
}

/**
 * Handle duplicate list values fix.
 */
async function handleDuplicateListFix(
  schema: LoadedSchema,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  if (!issue.field) return 'skipped';

  return confirmAndApplyFix(
    schema,
    result,
    issue,
    `    → Remove duplicate values from '${issue.field}'?`,
    `Deduplicated ${issue.field}`
  );
}

/**
 * Interactive handler for `illegal-aliases` (#617): offer to clean the alias
 * list by dropping empty/whitespace entries and de-duplicating (first wins),
 * reusing the same apply path as the auto-fix. Non-string aliases are flagged as
 * non-auto-fixable by the detector, so such issues never reach a fix dispatch.
 */
async function handleIllegalAliasesFix(
  schema: LoadedSchema,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  if (!issue.field) return 'skipped';

  // A non-string alias entry makes the issue flag-only (we can't infer the
  // intended text). Surface the suggestion path and skip rather than prompting a
  // fix that would fail.
  if (!issue.autoFixable) {
    console.log(chalk.dim('    (Manual fix required - skipping)'));
    return 'skipped';
  }

  return confirmAndApplyFix(
    schema,
    result,
    issue,
    `    → Clean aliases in '${issue.field}' (drop empty entries + dedupe)?`,
    `Cleaned aliases in ${issue.field}`
  );
}

/**
 * Handle key casing and singular/plural mismatch fix.
 */
async function handleKeyCasingFix(
  schema: LoadedSchema,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  if (!issue.field || !issue.canonicalKey) return 'skipped';

  const current = await parseNote(result.path);
  if (!(issue.field in current.frontmatter)) {
    console.log(chalk.dim(`    (Key '${issue.field}' no longer present - skipping)`));
    return 'skipped';
  }

  // Check if there's a conflict
  if (issue.hasConflict && issue.conflictValue !== undefined && !isEffectivelyEmpty(issue.conflictValue)) {
    // Both keys have values - need user decision
    console.log(chalk.dim(`    Current '${issue.field}': ${JSON.stringify(issue.value)}`));
    console.log(chalk.dim(`    Existing '${issue.canonicalKey}': ${JSON.stringify(issue.conflictValue)}`));
    
    const options = [
      `[keep '${issue.canonicalKey}' value, delete '${issue.field}']`,
      `[use '${issue.field}' value, overwrite '${issue.canonicalKey}']`,
      '[skip]',
      '[quit]'
    ];
    
    const selected = await promptSelection(
      `    Both '${issue.field}' and '${issue.canonicalKey}' exist. How to merge?`,
      options
    );
    
    if (selected === null || selected === '[quit]') return 'quit';
    if (selected === '[skip]') {
      console.log(chalk.dim('    → Skipped'));
      return 'skipped';
    }
    
    // Manual merge handling
    try {
      const parsed = await parseNote(result.path);
      const frontmatter = { ...parsed.frontmatter };
      
      if (selected.includes('keep')) {
        // Delete the non-canonical key, keep existing value
        delete frontmatter[issue.field];
      } else {
        // Use the non-canonical value, delete old key
        frontmatter[issue.canonicalKey] = frontmatter[issue.field];
        delete frontmatter[issue.field];
      }
      
      const typePath = resolveTypeFromFrontmatter(schema, frontmatter);
      const typeDef = typePath ? getType(schema, typePath) : undefined;
      const order = typeDef?.fieldOrder;
      
      if (!isDryRunEnabled()) {
        await writeNote(result.path, frontmatter, parsed.body, order);
      }
      console.log(chalk.green(`    ✓ Merged ${issue.field} → ${issue.canonicalKey}`));
      return 'fixed';
    } catch (err) {
      console.log(chalk.red(`    ✗ Failed: ${err instanceof Error ? err.message : String(err)}`));
      return 'failed';
    }
  }

  // Simple case - no conflict or one value is empty
  const confirm = await promptConfirm(
    `    → Rename '${issue.field}' to '${issue.canonicalKey}'?`
  );
  if (confirm === null) return 'quit';
  if (!confirm) {
    console.log(chalk.dim('    → Skipped'));
    return 'skipped';
  }

  const fixResult = await applyFix(schema, result.path, issue);
  if (fixResult.action === 'fixed') {
    console.log(chalk.green(`    ✓ Renamed ${issue.field} → ${issue.canonicalKey}`));
    return 'fixed';
  } else {
    console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
    return 'failed';
  }
}
