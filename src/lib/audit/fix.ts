/**
 * Audit fix operations.
 * 
 * This module handles applying fixes to audit issues.
 */

import chalk from 'chalk';
import { readFile, writeFile } from 'fs/promises';
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
import { parseNote, writeNote } from '../frontmatter.js';
import { levenshteinDistance } from '../discovery.js';
import { promptSelection, promptConfirm, promptInput } from '../prompt.js';
import type { LoadedSchema, Field } from '../../types/schema.js';
import { normalizeToIsoDate } from '../validation.js';
import {
  findAllMarkdownFiles,
  findWikilinksToFile,
  executeBulkMove,
} from '../bulk/move.js';
import { formatValue } from '../vault.js';
import { buildNoteTargetIndex, type NoteTargetIndex } from '../discovery.js';

// Alias for backward compatibility
const resolveTypePathFromFrontmatter = resolveTypeFromFrontmatter;
const getTypeDefByPath = getType;
import {
  type AuditIssue,
  type FileAuditResult,
  type FixResult,
  type FixSummary,
  type FixContext,
  toWikilink,
  toMarkdownLink,
} from './types.js';
import {
  readStructuralFrontmatterFromRaw,
  movePrimaryBlockToTop,
  replacePrimaryYaml,
  getAllPairsForKey,
  getLastPairForKey,
  getStringSequenceItem,
} from './structural.js';
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

const dryRunStorage = new AsyncLocalStorage<boolean>();

function isDryRunEnabled(): boolean {
  return dryRunStorage.getStore() ?? false;
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

type RawLine = {
  text: string;
  eol: string;
};

function splitLinesPreserveEol(input: string): RawLine[] {
  const lines: RawLine[] = [];
  let start = 0;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch !== '\n' && ch !== '\r') continue;

    const eolStart = i;
    let eol = ch;
    if (ch === '\r' && input[i + 1] === '\n') {
      eol = '\r\n';
      i++;
    }

    lines.push({
      text: input.slice(start, eolStart),
      eol,
    });

    start = i + 1;
  }

  lines.push({
    text: input.slice(start),
    eol: '',
  });

  return lines;
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
        if (issue.field && issue.canonicalValue) {
          frontmatter[issue.field] = issue.canonicalValue;
        } else {
          return { file: filePath, issue, action: 'failed', message: 'No canonical value provided' };
        }
        break;
      }
      case 'duplicate-list-values': {
        if (issue.field && Array.isArray(frontmatter[issue.field])) {
          // Case-insensitive deduplication preserving first occurrence
          const seen = new Set<string>();
          const deduped: unknown[] = [];
          for (const item of frontmatter[issue.field] as unknown[]) {
            const key = String(item).toLowerCase();
            if (!seen.has(key)) {
              seen.add(key);
              deduped.push(item);
            }
          }
          frontmatter[issue.field] = deduped;
        } else {
          return { file: filePath, issue, action: 'failed', message: 'Cannot dedupe non-array value' };
        }
        break;
      }
      case 'frontmatter-key-casing':
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

  for (const result of results) {
    const fixableIssues = result.issues.filter(i => i.autoFixable);
    const nonFixableIssues = result.issues.filter(i => !i.autoFixable);


    const coercedIssues = new Set<AuditIssue>();
    for (const issue of fixableIssues) {
      if (issue.code !== 'wrong-scalar-type' || !issue.field || typeof issue.value !== 'string') {
        continue;
      }

      if (isDryRunEnabled()) {
        console.log(chalk.cyan(`  ${result.relativePath}`));
        console.log(chalk.yellow(`    ⚠ Would coerce ${issue.field} to ${issue.expected}`));
        skipped++;
        coercedIssues.add(issue);
        continue;
      }

      const fixResult = await applyFix(schema, result.path, issue);
      if (fixResult.action === 'fixed') {
        console.log(chalk.cyan(`  ${result.relativePath}`));
        console.log(chalk.green(`    ✓ Coerced ${issue.field} to ${issue.expected}`));
        fixed++;
        coercedIssues.add(issue);
      } else if (fixResult.action === 'skipped') {
        console.log(chalk.cyan(`  ${result.relativePath}`));
        console.log(chalk.yellow(`    ⚠ ${fixResult.message}`));
        skipped++;
        coercedIssues.add(issue);
      } else {
        console.log(chalk.cyan(`  ${result.relativePath}`));
        console.log(chalk.red(`    ✗ Failed to coerce ${issue.field}: ${fixResult.message}`));
        failed++;
        coercedIssues.add(issue);
      }
    }

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
        const allFiles = await findAllMarkdownFiles(vaultDir);
        const refs = await findWikilinksToFile(vaultDir, result.path, allFiles);
        
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
          allVaultFiles: allFiles,
        });
        
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
        const allFiles = await findAllMarkdownFiles(vaultDir);
        const refs = await findWikilinksToFile(vaultDir, result.path, allFiles);
        
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
          allVaultFiles: allFiles,
        });
        
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
       } else if (issue.code === 'wrong-scalar-type' && issue.field) {
         const fixResult = await applyFix(schema, result.path, issue);
         if (fixResult.action === 'fixed') {
           console.log(chalk.cyan(`  ${result.relativePath}`));
           console.log(chalk.green(`    ✓ Coerced ${issue.field} to ${issue.expected}`));
           fixed++;
         } else if (fixResult.action === 'skipped') {
           console.log(chalk.cyan(`  ${result.relativePath}`));
           console.log(chalk.yellow(`    ⚠ ${fixResult.message}`));
           skipped++;
         } else {
           console.log(chalk.cyan(`  ${result.relativePath}`));
           console.log(chalk.red(`    ✗ Failed to coerce ${issue.field}: ${fixResult.message}`));
           failed++;
         }
       } else if (issue.code === 'unknown-enum-casing' && issue.field && issue.canonicalValue) {

        // Auto-fix enum casing
        const fixResult = await applyFix(schema, result.path, issue);
        if (fixResult.action === 'fixed') {
          console.log(chalk.cyan(`  ${result.relativePath}`));
          console.log(chalk.green(`    ✓ Fixed ${issue.field} casing: ${issue.value} → ${issue.canonicalValue}`));
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
  const context: FixContext = { schema, vaultDir, dryRun };
  
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
      return handleOrphanFileFix(schema, result, issue);
    case 'missing-required':
      return handleMissingRequiredFix(schema, result, issue);
    case 'invalid-option':
      return handleInvalidOptionFix(schema, result, issue);
    case 'invalid-type':
      return handleInvalidTypeFix(schema, result, issue);
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
    case 'frontmatter-key-casing':
    case 'singular-plural-mismatch':
      return handleKeyCasingFix(schema, result, issue);
    default:
      // Truly non-fixable issues
      if (issue.suggestion) {
        console.log(chalk.dim(`    ${issue.suggestion}`));
      }
      console.log(chalk.dim('    (Manual fix required - skipping)'));
      return 'skipped';
  }
}

async function handleOrphanFileFix(
  schema: LoadedSchema,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  let typePath: string | undefined;

  if (issue.inferredType) {
    // We know the expected type from the directory
    const confirm = await promptConfirm(
      `    → Add type fields for '${issue.inferredType}'?`
    );
    if (confirm === null) {
      return 'quit';
    }
    if (confirm) {
      typePath = issue.inferredType;
    }
  } else {
    // Need to prompt user to select type from available types
    const availableTypes = getConcreteTypeNames(schema);
    if (availableTypes.length > 0) {
      const typeOptions = [...availableTypes, '[skip]', '[quit]'];
      const selectedType = await promptSelection(
        '    Select type:',
        typeOptions
      );

      if (selectedType === null || selectedType === '[quit]') {
        return 'quit';
      } else if (selectedType === '[skip]') {
        console.log(chalk.dim('    → Skipped'));
        return 'skipped';
      }

      typePath = selectedType;
    } else {
      console.log(chalk.dim('    (No types defined - skipping)'));
      return 'skipped';
    }
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
    return Array.from(targetIndex.targetToPaths.keys()).filter((key) => !key.includes('/'));
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

  const confirm = await promptConfirm(
    `    → Convert to ${issue.expectedFormat} format?`
  );
  if (confirm === null) {
    return 'quit';
  }
  if (!confirm) {
    console.log(chalk.dim('    → Skipped'));
    return 'skipped';
  }

  const fixResult = await applyFix(schema, result.path, issue);
  if (fixResult.action === 'fixed') {
    console.log(chalk.green(`    ✓ Converted ${issue.field} to ${issue.expectedFormat}`));
    return 'fixed';
  } else {
    console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
    return 'failed';
  }
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
  const allFiles = await findAllMarkdownFiles(vaultDir);
  const refs = await findWikilinksToFile(vaultDir, result.path, allFiles);
  
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
      allVaultFiles: allFiles,
    });
    
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
  const allFiles = await findAllMarkdownFiles(vaultDir);
  const refs = await findWikilinksToFile(vaultDir, result.path, allFiles);
  
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
      allVaultFiles: allFiles,
    });
    
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
  issue: AuditIssue
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
  
  const options = [...availableTypes, '[skip]', '[quit]'];
  const selected = await promptSelection(
    '    Select valid type:',
    options
  );

  if (selected === null || selected === '[quit]') {
    return 'quit';
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

  const confirm = await promptConfirm('    → Move frontmatter to the top of the file?');
  if (confirm === null) return 'quit';
  if (!confirm) {
    console.log(chalk.dim('    → Skipped'));
    return 'skipped';
  }

  const fixResult = await applyFix(schema, result.path, issue);
  if (fixResult.action === 'fixed') {
    console.log(chalk.green('    ✓ Moved frontmatter to top'));
    return 'fixed';
  }
  if (fixResult.action === 'skipped') {
    console.log(chalk.yellow(`    ⚠ ${fixResult.message}`));
    return 'skipped';
  }
  console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
  return 'failed';
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
  if (fixResult.action === 'fixed') {
    console.log(chalk.green(`    ✓ Resolved duplicate key '${key}' (${selected})`));
    return 'fixed';
  }
  if (fixResult.action === 'skipped') {
    console.log(chalk.yellow(`    ⚠ ${fixResult.message}`));
    return 'skipped';
  }
  console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
  return 'failed';
}

async function handleMalformedWikilinkFix(
  schema: LoadedSchema,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  const loc = issue.listIndex !== undefined
    ? `${issue.field}[${issue.listIndex}]`
    : issue.field;

  const confirm = await promptConfirm(
    `    → Fix malformed wikilink${loc ? ` in '${loc}'` : ''}?`
  );
  if (confirm === null) return 'quit';
  if (!confirm) {
    console.log(chalk.dim('    → Skipped'));
    return 'skipped';
  }

  const fixResult = await applyFix(schema, result.path, issue);
  if (fixResult.action === 'fixed') {
    console.log(chalk.green('    ✓ Fixed malformed wikilink'));
    return 'fixed';
  }
  if (fixResult.action === 'skipped') {
    console.log(chalk.yellow(`    ⚠ ${fixResult.message}`));
    return 'skipped';
  }
  console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
  return 'failed';
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

async function handleSelfReferenceFix(
  context: FixContext,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  if (!issue.field) {
    console.log(chalk.dim('    (Cannot fix - no field specified)'));
    return 'skipped';
  }

  const { schema, vaultDir } = context;
  const parsed = await parseNote(result.path);
  const typePath = resolveTypePathFromFrontmatter(schema, parsed.frontmatter);
  const fields = typePath ? getFieldsForType(schema, typePath) : {};
  const field = fields[issue.field];

  const options = ['[clear field]'];

  if (field?.source) {
    const targetIndex = await buildNoteTargetIndex(schema, vaultDir);
    const validTargets = collectTargetsBySource(schema, field.source, targetIndex);
    const noteName = basename(result.path, '.md');
    const notePathKey = result.relativePath.replace(/\.md$/, '');
    const filteredTargets = validTargets.filter(
      (target) => target !== noteName && target !== notePathKey
    );

    if (filteredTargets.length > 0) {
      options.push(...filteredTargets.slice(0, 20).map((target) => `[[${target}]]`));
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
    const fixResult = await applyFix(schema, result.path, issue, '');
    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Cleared ${issue.field}`));
      return 'fixed';
    }
    console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
    return 'failed';
  }

  const fixResult = await applyFix(schema, result.path, issue, selected);
  if (fixResult.action === 'fixed') {
    console.log(chalk.green(`    ✓ Updated ${issue.field}: ${selected}`));
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

  const { schema } = context;
  const linkFormat = schema.config.linkFormat ?? 'wikilink';

  const candidateOptions = issue.candidates.map((candidate) => {
    const target = candidate.replace(/\.md$/, '');
    return formatValue(target, linkFormat);
  });

  const options = [...candidateOptions, '[clear field]', '[skip]', '[quit]'];

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
    const fixResult = await applyFix(schema, result.path, issue, '');
    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Cleared ${issue.field}`));
      return 'fixed';
    }
    console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
    return 'failed';
  }

  const fixResult = await applyFix(schema, result.path, issue, selected);
  if (fixResult.action === 'fixed') {
    console.log(chalk.green(`    ✓ Updated ${issue.field}: ${selected}`));
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

  const options: string[] = [];

  if (listIndex === undefined) {
    options.push('[wrap into list]', '[clear field]');
  } else {
    options.push('[remove element]', '[edit element]', '[clear field]');
  }

  options.push('[skip]', '[quit]');

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

  if (selected === '[clear field]') {
    const fixResult = await updateFrontmatterValue(schema, result, (frontmatter) => {
      if (!(fieldName in frontmatter)) return false;
      delete frontmatter[fieldName];
      return true;
    });

    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Cleared ${fieldName}`));
      return 'fixed';
    }

    console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
    return 'failed';
  }

  if (selected === '[wrap into list]') {
    const fixResult = await updateFrontmatterValue(schema, result, (frontmatter) => {
      const current = frontmatter[fieldName];
      if (current === undefined || current === null) return false;
      const wrapped = typeof current === 'string' ? [current] : [String(current)];
      frontmatter[fieldName] = wrapped;
      return true;
    });

    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Wrapped ${fieldName} into list`));
      return 'fixed';
    }

    console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
    return 'failed';
  }

  if (selected === '[remove element]' && listIndex !== undefined) {
    const fixResult = await updateFrontmatterValue(schema, result, (frontmatter) => {
      const current = frontmatter[fieldName];
      if (!Array.isArray(current)) return false;
      if (listIndex < 0 || listIndex >= current.length) return false;
      current.splice(listIndex, 1);
      frontmatter[fieldName] = current;
      return true;
    });

    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Removed invalid element from ${fieldName}`));
      return 'fixed';
    }

    console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
    return 'failed';
  }

  if (selected === '[edit element]' && listIndex !== undefined) {
    const value = await promptInput(`    Enter value for ${fieldName}[${listIndex}]:`);
    if (value === null) return 'quit';
    if (!value) {
      console.log(chalk.dim('    → Skipped'));
      return 'skipped';
    }

    const fixResult = await updateFrontmatterValue(schema, result, (frontmatter) => {
      const current = frontmatter[fieldName];
      if (!Array.isArray(current)) return false;
      if (listIndex < 0 || listIndex >= current.length) return false;
      current[listIndex] = value;
      frontmatter[fieldName] = current;
      return true;
    });

    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Updated ${fieldName}[${listIndex}]`));
      return 'fixed';
    }

    console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
    return 'failed';
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
 * Handle boolean coercion fix.
 */
async function handleBooleanCoercionFix(
  schema: LoadedSchema,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  if (!issue.field) return 'skipped';

  const confirm = await promptConfirm(
    `    → Convert '${issue.value}' to boolean in '${issue.field}'?`
  );
  if (confirm === null) return 'quit';
  if (!confirm) {
    console.log(chalk.dim('    → Skipped'));
    return 'skipped';
  }

  const fixResult = await applyFix(schema, result.path, issue);
  if (fixResult.action === 'fixed') {
    console.log(chalk.green(`    ✓ Converted ${issue.field} to boolean`));
    return 'fixed';
  } else {
    console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
    return 'failed';
  }
}

async function handleWrongScalarTypeFix(
  schema: LoadedSchema,
  result: FileAuditResult,
  issue: AuditIssue
): Promise<'fixed' | 'skipped' | 'failed' | 'quit'> {
  if (!issue.field || typeof issue.value !== 'string') return 'skipped';

  const canAutoCoerce = issue.expected === 'number'
    ? coerceNumberFromString(issue.value).ok
    : issue.expected === 'boolean'
      ? coerceBooleanFromString(issue.value).ok
      : false;

  if (canAutoCoerce) {
    const fixResult = await applyFix(schema, result.path, issue);
    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Coerced ${issue.field} to ${issue.expected}`));
      return 'fixed';
    }
    console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
    return 'failed';
  }

  const value = await promptInput(`    Enter ${issue.expected ?? 'value'} for ${issue.field}:`);
  if (value === null) return 'quit';
  if (!value.trim()) {
    console.log(chalk.dim('    → Skipped'));
    return 'skipped';
  }

  if (issue.expected === 'number') {
    const resultValue = coerceNumberFromString(value);
    if (!resultValue.ok) {
      console.log(chalk.yellow('    ⚠ Invalid number format.'));
      return 'skipped';
    }
    const fixResult = await applyFix(schema, result.path, issue, resultValue.value);
    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Updated ${issue.field}: ${resultValue.value}`));
      return 'fixed';
    }
    console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
    return 'failed';
  }

  if (issue.expected === 'boolean') {
    const resultValue = coerceBooleanFromString(value);
    if (!resultValue.ok) {
      console.log(chalk.yellow('    ⚠ Invalid boolean. Use true/false.'));
      return 'skipped';
    }
    const fixResult = await applyFix(schema, result.path, issue, resultValue.value);
    if (fixResult.action === 'fixed') {
      console.log(chalk.green(`    ✓ Updated ${issue.field}: ${resultValue.value}`));
      return 'fixed';
    }
    console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
    return 'failed';
  }

  console.log(chalk.dim('    (Unsupported coercion - skipping)'));
  return 'skipped';
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

  const normalized = normalizeToIsoDate(value);
  if (!normalized.valid) {
    console.log(chalk.yellow(`    ⚠ ${normalized.error}`));
    return 'skipped';
  }

  const fixResult = await applyFix(schema, result.path, issue, normalized.value);
  if (fixResult.action === 'fixed') {
    console.log(chalk.green(`    ✓ Updated ${issue.field}: ${normalized.value}`));
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

  const confirm = await promptConfirm(
    `    → Change '${issue.value}' to '${issue.canonicalValue}'?`
  );
  if (confirm === null) return 'quit';
  if (!confirm) {
    console.log(chalk.dim('    → Skipped'));
    return 'skipped';
  }

  const fixResult = await applyFix(schema, result.path, issue);
  if (fixResult.action === 'fixed') {
    console.log(chalk.green(`    ✓ Fixed casing: ${issue.value} → ${issue.canonicalValue}`));
    return 'fixed';
  } else {
    console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
    return 'failed';
  }
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

  const confirm = await promptConfirm(
    `    → Remove duplicate values from '${issue.field}'?`
  );
  if (confirm === null) return 'quit';
  if (!confirm) {
    console.log(chalk.dim('    → Skipped'));
    return 'skipped';
  }

  const fixResult = await applyFix(schema, result.path, issue);
  if (fixResult.action === 'fixed') {
    console.log(chalk.green(`    ✓ Deduplicated ${issue.field}`));
    return 'fixed';
  } else {
    console.log(chalk.red(`    ✗ Failed: ${fixResult.message}`));
    return 'failed';
  }
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
