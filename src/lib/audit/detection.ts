/**
 * Audit detection logic.
 * 
 * This module handles issue detection for vault files.
 * File discovery functions are imported from the shared discovery module.
 */

import { dirname, basename } from 'path';
import { minimatch } from 'minimatch';
import {
  getType,
  getFieldsForType,
  resolveTypeFromFrontmatter,
  getOutputDir,
  getTypeFamilies,
  getDescendants,
  resolveDateGranularity,
  getRecurrenceForType,
} from '../schema.js';
import { readStructuralFrontmatter } from './structural.js';
import {
  splitLinesPreserveEol,
  parseSimpleYamlKeyValueLine,
  isBlockScalarHeader,
} from './raw.js';
import { isEmptyRequiredValue } from './emptiness.js';
import {
  getExpectedScalarType,
  getScalarCoercion,
  getScalarFromList,
  getScalarToList,
  getUnambiguousDateNormalization,
  getValueShape,
  isAcceptableDate,
} from './fix-policy.js';
import { extractYamlNodeValue, isEffectivelyEmpty } from './value-utils.js';
import { isMap } from 'yaml';
import type { Pair, Scalar, YAMLMap } from 'yaml';
import { isDeepStrictEqual } from 'node:util';
import { suggestOptionValue, suggestFieldName } from '../validation.js';
import { searchContent } from '../content-search.js';
import { applyWhereExpressions } from '../where-targeting.js';
import { type LoadedSchema, type Field, getOptionValues } from '../../types/schema.js';
import {
  type AuditIssue,
  type FileAuditResult,
  type ManagedFile,
  type AuditRunOptions,
  type IssueCode,
  ALLOWED_NATIVE_FIELDS,
} from './types.js';
import { isBwrbBuiltinFrontmatterField } from '../frontmatter/systemFields.js';
import {
  extractLinkTarget,
  extractWikilinkTarget,
  isMarkdownLink,
  isWikilink,
} from '../links.js';
import {
  needsSuccessor,
  validateRecurrenceRule,
  CHAIN_NEXT_FIELD,
} from '../recurrence.js';
import {
  findDefaultTemplateWithInheritance,
  findAllTemplates,
} from '../template.js';

// Import file discovery functions from shared module
import {
  discoverManagedFiles,
  buildVaultNoteIndex,
  findSimilarFiles,
} from '../discovery.js';

// Import ownership tracking
import {
  buildOwnershipIndex,
  isNoteOwned,
  canReference,
  extractWikilinkReferences,
  type OwnershipIndex,
} from '../ownership.js';

// Import unlinked-mention detection (ingest safety net, #600)
import {
  buildEntityMentionIndex,
  detectUnlinkedMentions,
  type EntityMentionIndex,
} from './unlinked-mention.js';
// Import frequent-unlinked-term detection (ingest safety net, #601)
import { FrequentTermAccumulator } from './frequent-unlinked-term.js';
// Import body-section validation (#510)
import { detectMissingBodySections } from './body-sections.js';
// Import body-link validation (#652)
import { detectBodyLinks } from './body-links.js';
import { parseNote } from '../frontmatter.js';

/**
 * Synthetic vault-relative path used to group vault-global (aggregate) findings
 * such as `frequent-unlinked-term`, which belong to no single note. Rendered as
 * a normal result header by the text/JSON output.
 */
const VAULT_GLOBAL_RESULT_PATH = '(vault-wide)';

// ============================================================================
// Main Audit Runner
// ============================================================================

/**
 * Run audit on all managed files.
 */
export async function runAudit(
  schema: LoadedSchema,
  vaultDir: string,
  options: AuditRunOptions
): Promise<FileAuditResult[]> {
  // Discover all managed files
  const files = await discoverManagedFiles(schema, vaultDir, options.typePath);

  // Apply path filter (glob pattern or substring match)
  let filteredFiles = files;
  if (options.pathFilter) {
    const pattern = options.pathFilter;
    // If pattern contains glob characters, use minimatch; otherwise do substring match
    const isGlob = /[*?[\]]/.test(pattern);
    if (isGlob) {
      filteredFiles = files.filter(f => minimatch(f.relativePath, pattern, { matchBase: true }));
    } else {
      // Substring match for simple patterns
      filteredFiles = files.filter(f => f.relativePath.includes(pattern));
    }
  }

  // Apply where expressions (frontmatter filtering)
  if (options.whereExpressions && options.whereExpressions.length > 0) {
    const filesWithFrontmatter = await Promise.all(
      filteredFiles.map(async (f) => {
        try {
          const { frontmatter } = await readStructuralFrontmatter(f.path);
          return { path: f.path, frontmatter, _managedFile: f };
        } catch {
          return { path: f.path, frontmatter: {}, _managedFile: f };
        }
      })
    );
    
    const filtered = await applyWhereExpressions(filesWithFrontmatter, {
      schema,
      ...(options.typePath ? { typePath: options.typePath } : {}),
      whereExpressions: options.whereExpressions,
      vaultDir,
    });

    if (!filtered.ok) {
      throw new Error(filtered.error);
    }
    
    // Map back to ManagedFile
    const filteredPaths = new Set(filtered.files.map(f => f.path));
    filteredFiles = filteredFiles.filter(f => filteredPaths.has(f.path));
  }

  // Apply text filter (content search)
  if (options.textQuery) {
    const searchResult = await searchContent({
      pattern: options.textQuery,
      vaultDir,
      schema,
      ...(options.typePath && { typePath: options.typePath }),
      contextLines: 0,
      caseSensitive: false,
      regex: false,
      limit: 10000,
    });
    
    if (searchResult.success && searchResult.results) {
      const matchingPaths = new Set(searchResult.results.map(r => r.file.path));
      filteredFiles = filteredFiles.filter(f => matchingPaths.has(f.path));
    } else if (!searchResult.success) {
      // Content search failed (e.g. ripgrep not installed) — filter to empty set
      // rather than silently skipping the --body filter
      filteredFiles = [];
    }
  }

  // Build a unified note index for relation/type/path lookups.
  const noteIndex = await buildVaultNoteIndex(schema, vaultDir);

  // Build ownership index for ownership violation checking
  const ownershipIndex = await buildOwnershipIndex(schema, vaultDir);

  // Build parent map for cycle detection on recursive types
  const parentMap = await buildParentMap(schema, filteredFiles, noteIndex);

  // Build the entity-mention index once for the whole run (#600). The full
  // vault snapshot (not just the filtered set) is the source of known names so
  // that, e.g., auditing one daily note still detects mentions of every entity.
  const entityMentionIndex = buildEntityMentionIndex(noteIndex.snapshot, schema);

  // Audit each file
  const results: FileAuditResult[] = [];

  for (const file of filteredFiles) {
    const issues = await auditFile(schema, vaultDir, file, options, noteIndex, ownershipIndex, parentMap, entityMentionIndex);

    // Apply issue filters
    let filteredIssues = issues;
    if (options.onlyIssue) {
      filteredIssues = issues.filter(i => i.code === options.onlyIssue);
    }
    if (options.ignoreIssue) {
      filteredIssues = filteredIssues.filter(i => i.code !== options.ignoreIssue);
    }

    if (filteredIssues.length > 0) {
      results.push({
        path: file.path,
        relativePath: file.relativePath,
        issues: filteredIssues,
      });
    }
  }

  // Vault-global post-pass: frequent-unlinked-term (#601). This is an advisory,
  // never-auto-fixable heuristic that aggregates Capitalized-phrase mentions
  // across every scanned body and surfaces terms that appear frequently but
  // have no note yet. Aggregation cannot happen per file (the threshold is
  // vault-wide), so it runs here after the per-file loop. Skipped entirely when
  // the caller filtered this issue out, to avoid the extra body reads.
  const wantFrequentTerm =
    options.ignoreIssue !== 'frequent-unlinked-term' &&
    (options.onlyIssue === undefined || options.onlyIssue === 'frequent-unlinked-term');

  if (wantFrequentTerm && entityMentionIndex) {
    const accumulator = new FrequentTermAccumulator(entityMentionIndex);
    for (const file of filteredFiles) {
      try {
        const { body } = await parseNote(file.path);
        if (body && body.trim().length > 0) {
          accumulator.addBody(body, file.relativePath);
        }
      } catch {
        // Skip files whose body can't be parsed.
      }
    }
    const aggregateIssues = accumulator.finish();
    if (aggregateIssues.length > 0) {
      results.push({
        path: VAULT_GLOBAL_RESULT_PATH,
        relativePath: VAULT_GLOBAL_RESULT_PATH,
        issues: aggregateIssues,
      });
    }
  }

  return results;
}

// ============================================================================
// Issue Detection
// ============================================================================

/**
 * Audit a single file for issues.
 */
export async function auditFile(
  schema: LoadedSchema,
  vaultDir: string,
  file: ManagedFile,
  options: AuditRunOptions,
  noteIndex?: import('../discovery.js').VaultNoteIndex,
  ownershipIndex?: OwnershipIndex,
  parentMap?: Map<string, string>,
  entityMentionIndex?: EntityMentionIndex,
): Promise<AuditIssue[]> {
  const issues: AuditIssue[] = [];

  const structural = await readStructuralFrontmatter(file.path);

  // Treat YAML parse errors as fatal unless they are only duplicate-key errors
  // (duplicate-key errors are handled as Phase 4 structural issues).
  const fatalYamlErrors = structural.yamlErrors.filter(
    (e) => !e.startsWith('Map keys must be unique')
  );

  if (structural.yaml !== null && (structural.doc === null || fatalYamlErrors.length > 0)) {
    issues.push({
      severity: 'error',
      code: 'orphan-file',
      message: fatalYamlErrors.length > 0
        ? `Failed to parse frontmatter: ${fatalYamlErrors[0]}`
        : 'Failed to parse frontmatter',
      autoFixable: false,
    });
    return issues;
  }

  const frontmatter: Record<string, unknown> = structural.frontmatter;

  const getDeleteRecommendationMeta = (
    reason: 'missing-type' | 'invalid-type'
  ): Record<string, unknown> => ({
    recommendation: {
      action: 'delete-note',
      reason,
      interactiveOnly: true,
      source: 'audit-fix',
    },
  });

  // Phase 4: Structural integrity issues
  issues.push(...collectStructuralIssues(structural, frontmatter));

  // Raw-level hygiene: detect trailing whitespace before YAML parsing
  issues.push(...detectTrailingWhitespaceInRawFrontmatter(structural));

  // Check for type field
  const typeValue = frontmatter['type'];
  if (!typeValue) {
    issues.push({
      severity: 'error',
      code: 'orphan-file',
      message: "No 'type' field (in managed directory). Type-dependent checks skipped.",
      autoFixable: Boolean(file.expectedType),
      meta: getDeleteRecommendationMeta('missing-type'),
      ...(file.expectedType && { inferredType: file.expectedType }),
    });
    return issues;
  }

  // Resolve full type path from frontmatter
  const resolvedTypePath = resolveTypeFromFrontmatter(schema, frontmatter);
  if (!resolvedTypePath) {
    const knownTypes = getTypeFamilies(schema);
    const suggestion = suggestFieldName(String(typeValue), knownTypes);
    issues.push({
      severity: 'error',
      code: 'invalid-type',
      message: `Invalid type: '${typeValue}'. Type-dependent checks skipped.`,
      field: 'type',
      value: typeValue,
      ...(suggestion && { suggestion: `Did you mean '${suggestion}'?` }),
      autoFixable: false,
      meta: getDeleteRecommendationMeta('invalid-type'),
    });
    return issues;
  }

  // Verify type definition exists
  const typeDef = getType(schema, resolvedTypePath);
  if (!typeDef) {
    issues.push({
      severity: 'error',
      code: 'invalid-type',
      message: `Invalid type path: '${resolvedTypePath}'. Type-dependent checks skipped.`,
      field: 'type',
      value: typeValue,
      autoFixable: false,
      meta: getDeleteRecommendationMeta('invalid-type'),
    });
    return issues;
  }

  // Check wrong directory
  const expectedOutputDir = getOutputDir(schema, resolvedTypePath);
  if (expectedOutputDir) {
    const expectedPath = expectedOutputDir;
    const actualDir = dirname(file.relativePath);
    // Normalize for comparison
    const normalizedExpected = expectedPath.replace(/\/$/, '');
    const normalizedActual = actualDir.replace(/\/$/, '');
    
    // Segment-aware check: actualDir must be exactly expectedDir or a subdirectory
    const isCorrectLocation =
      normalizedActual === normalizedExpected ||
      normalizedActual.startsWith(normalizedExpected + '/');
    if (!isCorrectLocation) {
      issues.push({
        severity: 'error',
        code: 'wrong-directory',
        message: `Wrong directory: type is '${resolvedTypePath}', expected in ${expectedOutputDir}`,
        expected: expectedOutputDir,
        currentDirectory: actualDir,
        expectedDirectory: expectedOutputDir,
        autoFixable: true, // Can be auto-fixed with --fix
      });
    }
  }

  // Get field definitions for this type
  const fields = getFieldsForType(schema, resolvedTypePath);
  const fieldNames = new Set(Object.keys(fields));

  // Combine allowed fields from different sources
  const allowedFields = new Set([
    ...ALLOWED_NATIVE_FIELDS,
    ...(options.allowedFields ?? []),
    ...(schema.raw.audit?.allowed_extra_fields ?? []),
  ]);

  // Check required fields
  // Build a case-insensitive lookup of existing frontmatter keys
  const frontmatterKeysLower = new Set(
    Object.keys(frontmatter).map(k => k.toLowerCase())
  );
  
  for (const [fieldName, field] of Object.entries(fields)) {
    const value = frontmatter[fieldName];
    const hasKey = Object.prototype.hasOwnProperty.call(frontmatter, fieldName);
    const isEmptyValue = isEmptyRequiredValue(value);

    if (field.required && (!hasKey || isEmptyValue)) {
      // Check if a case-variant of this field exists in frontmatter
      // If so, it will be caught by frontmatter-key-casing, not missing-required
      const hasCaseVariant = frontmatterKeysLower.has(fieldName.toLowerCase()) &&
        !Object.prototype.hasOwnProperty.call(frontmatter, fieldName);
      
      if (hasCaseVariant) {
        // Skip - this will be handled by frontmatter-key-casing detection
        continue;
      }
      
      const hasDefault = field.default !== undefined;

      if (!hasKey) {
        issues.push({
          severity: 'error',
          code: 'missing-required',
          message: `Missing required field: ${fieldName}`,
          field: fieldName,
          autoFixable: hasDefault,
        });
      } else if (isEmptyValue) {
        issues.push({
          severity: 'error',
          code: 'empty-string-required',
          message: `Required field '${fieldName}' is empty`,
          field: fieldName,
          value,
          autoFixable: hasDefault,
        });
      }
    }
  }

  // Check enum values and format violations
  for (const [fieldName, value] of Object.entries(frontmatter)) {
    const field = fields[fieldName];
    if (!field) continue;

    const expectsList = field.prompt === 'list' || field.multiple === true;
    const expectedScalarType = getExpectedScalarType(field);
    const valueShape = getValueShape(value);

    if (expectsList) {
      if (value !== null && value !== undefined && !Array.isArray(value)) {
        const wrapped = getScalarToList(value);
        issues.push({
          severity: 'error',
          code: 'wrong-scalar-type',
          message: `Expected list for ${fieldName}`,
          field: fieldName,
          value,
          expected: 'list',
          autoFixable: wrapped.ok,
        });
      }
    } else {
      if (Array.isArray(value)) {
        const listCoercion = getScalarFromList(value, expectedScalarType);
        issues.push({
          severity: 'error',
          code: 'wrong-scalar-type',
          message: `List value for ${fieldName} should be a ${expectedScalarType}`,
          field: fieldName,
          value,
          expected: expectedScalarType,
          autoFixable: listCoercion.ok,
        });
      } else if (expectedScalarType === 'number' && typeof value === 'string') {
        const numberCoercion = getScalarCoercion(value, 'number');
        issues.push({
          severity: 'error',
          code: 'wrong-scalar-type',
          message: numberCoercion.ok
            ? `String value for ${fieldName} should be a number`
            : `Invalid number for ${fieldName}: '${value}'`,
          field: fieldName,
          value,
          expected: 'number',
          autoFixable: numberCoercion.ok,
        });
      } else if (expectedScalarType === 'boolean' && typeof value === 'string') {
        const booleanCoercion = getScalarCoercion(value, 'boolean');
        issues.push({
          severity: 'error',
          code: 'wrong-scalar-type',
          message: booleanCoercion.ok
            ? `String value for ${fieldName} should be a boolean`
            : `Invalid boolean for ${fieldName}: '${value}'`,
          field: fieldName,
          value,
          expected: 'boolean',
          autoFixable: booleanCoercion.ok,
        });
      } else if (
        expectedScalarType === 'string' &&
        (valueShape === 'number' || valueShape === 'boolean') &&
        // Date fields handle numeric values themselves (a bare year like 2026
        // is a partial date, not just a mis-typed string) — see date block below.
        field.prompt !== 'date'
      ) {
        issues.push({
          severity: 'error',
          code: 'wrong-scalar-type',
          message: `Non-string value for ${fieldName} should be a string`,
          field: fieldName,
          value,
          expected: 'string',
          autoFixable: true,
        });
      } else if (expectedScalarType !== 'string' && value !== null && value !== undefined && valueShape !== expectedScalarType) {
        issues.push({
          severity: 'error',
          code: 'wrong-scalar-type',
          message: `Invalid type for ${fieldName}: expected ${expectedScalarType}`,
          field: fieldName,
          value,
          expected: expectedScalarType,
          autoFixable: false,
        });
      }
    }

    if (field.prompt === 'date') {
      const granularity = resolveDateGranularity(field, schema.config);

      // Validate a single date element. `listIndex` is supplied for elements of
      // a list/multiple date field so the reported issue identifies the element.
      const checkDateElement = (element: unknown, listIndex?: number) => {
        if (typeof element !== 'string' && typeof element !== 'number') return;

        // An empty/blank string is "unset", not an invalid date. This mirrors the
        // write path (validateFrontmatter treats `''` as no value) and how other
        // optional fields behave (e.g. empty selects are skipped). A *required*
        // empty date is reported once as `empty-string-required`; an empty list
        // element is reported once as `invalid-list-element`. Skipping here keeps
        // write and audit in agreement and avoids double-reporting (#614).
        if (typeof element === 'string' && element.trim().length === 0) return;

        // A bare year (e.g. 2026) is parsed as a number by YAML; treat it as a
        // partial date string for validation.
        const dateStr = String(element);
        if (!isAcceptableDate(dateStr, granularity)) {
          const normalization = getUnambiguousDateNormalization(dateStr);
          const expected =
            granularity === 'day'
              ? 'YYYY-MM-DD'
              : granularity === 'month'
                ? 'YYYY-MM-DD or YYYY-MM'
                : 'YYYY-MM-DD, YYYY-MM, or YYYY';
          issues.push({
            severity: 'error',
            code: 'invalid-date-format',
            message:
              listIndex === undefined
                ? `Invalid date for ${fieldName}: must be ${expected}`
                : `Invalid date for ${fieldName} at index ${listIndex} ('${dateStr}'): must be ${expected}`,
            field: fieldName,
            value: element,
            expected,
            ...(listIndex !== undefined && { listIndex }),
            // The date auto-fixer overwrites the whole field, so it can only
            // safely normalize scalar dates. List elements are reported but not
            // auto-fixed (the offending value is surfaced for a manual fix).
            ...(listIndex === undefined &&
              normalization && { suggestion: `Suggested: ${normalization.normalized}` }),
            ...(listIndex === undefined &&
              normalization && {
                meta: { normalized: normalization.normalized, normalizationKind: normalization.kind },
              }),
            autoFixable: listIndex === undefined && Boolean(normalization),
          });
        } else if (typeof element === 'number') {
          // A valid date stored as a YAML number — should be quoted as a string.
          // This is true for both scalar dates and list elements: the date check
          // owns every numeric element of a date field (just as create/edit
          // validates numeric elements as dates), so `checkListElementIntegrity`
          // skips numeric date elements and we report exactly one issue per bad
          // element (#641). For scalar dates the field-level auto-fixer can quote
          // the value; a list element is surfaced for a manual fix.
          issues.push({
            severity: 'error',
            code: 'wrong-scalar-type',
            message: `Non-string value for ${fieldName} should be a string`,
            field: fieldName,
            value: element,
            expected: 'string',
            ...(listIndex !== undefined && { listIndex }),
            autoFixable: listIndex === undefined,
          });
        }
      };

      if (Array.isArray(value)) {
        // List/multiple date field: validate every element as a date, reusing
        // the same granularity-aware checker as scalar dates. Structural issues
        // (null/empty/nested) are reported separately by checkListElementIntegrity.
        value.forEach((element, index) => checkDateElement(element, index));
      } else {
        checkDateElement(value);
      }
    }

    // Check select field options
    if (field.options && field.options.length > 0) {
      const validOptions = getOptionValues(field.options);
      if (Array.isArray(value)) {
        value.forEach((item, index) => {
          if (typeof item !== 'string') return;
          if (item.trim().length === 0) return;
          if (!validOptions.includes(item)) {
            const suggestion = suggestOptionValue(item, validOptions);
            issues.push({
              severity: 'error',
              code: 'invalid-option',
              message: `Invalid ${fieldName} value: '${item}'`,
              field: fieldName,
              value: item,
              expected: validOptions,
              listIndex: index,
              ...(suggestion && { suggestion: `Did you mean '${suggestion}'?` }),
              autoFixable: false,
            });
          }
        });
      } else {
        if (typeof value === 'string' && value.trim().length === 0) {
          continue;
        }
        const strValue = String(value);
        if (!validOptions.includes(strValue)) {
          const suggestion = suggestOptionValue(strValue, validOptions);
          issues.push({
            severity: 'error',
            code: 'invalid-option',
            message: `Invalid ${fieldName} value: '${value}'`,
            field: fieldName,
            value,
            expected: validOptions,
            ...(suggestion && { suggestion: `Did you mean '${suggestion}'?` }),
            autoFixable: false,
          });
        }
      }
    }

    if (field.prompt === 'relation') {
      const relationIssues = checkRelationFieldIssues(
        schema,
        fieldName,
        value,
        field,
        noteIndex?.noteTargetIndex,
        noteIndex?.noteTypeMap,
        file
      );
      issues.push(...relationIssues);

      // Only check format violations for relation fields if we did not already detect
      // a higher-signal relation integrity issue. This prevents format-violation from
      // masking issues like self-reference / ambiguous-link-target.
      const hasRelationIntegrityIssue = relationIssues.some((i) =>
        i.code === 'self-reference' || i.code === 'ambiguous-link-target'
      );

      if (!hasRelationIntegrityIssue && value) {
        // In practice, YAML parsers may interpret bare wikilinks like `parent: [[Foo]]`
        // as a YAML array ("flow sequence") rather than a string. That is a YAML concern,
        // not a user-facing "format violation".
        if (!Array.isArray(value)) {
          const formatIssue = checkFormatViolation(fieldName, value, schema.config.linkFormat);
          if (formatIssue) {
            issues.push(formatIssue);
          }
        }
      }
    }
  }

  // Recurrence backstop + config validation (#107). Skipped when the caller
  // filtered these issue codes out.
  const wantMissingSuccessor =
    options.ignoreIssue !== 'missing-successor' &&
    (options.onlyIssue === undefined || options.onlyIssue === 'missing-successor');
  const wantInvalidRecurrence =
    options.ignoreIssue !== 'invalid-recurrence' &&
    (options.onlyIssue === undefined || options.onlyIssue === 'invalid-recurrence');

  if (wantInvalidRecurrence || wantMissingSuccessor) {
    issues.push(
      ...(await checkRecurrenceIssues(
        schema,
        vaultDir,
        resolvedTypePath,
        frontmatter,
        wantInvalidRecurrence,
        wantMissingSuccessor
      ))
    );
  }

  // Check unknown fields
  for (const fieldName of Object.keys(frontmatter)) {
    // Skip discriminator fields (type, <type>-type, etc.)
    if (fieldName === 'type' || fieldName.endsWith('-type')) continue;
    
    // Skip allowed native fields and user-allowed fields
    if (allowedFields.has(fieldName) || isBwrbBuiltinFrontmatterField(fieldName)) continue;

    if (!fieldNames.has(fieldName)) {
      const suggestion = suggestFieldName(fieldName, Array.from(fieldNames));
      issues.push({
        severity: options.strict ? 'error' : 'warning',
        code: 'unknown-field',
        message: `Unknown field: ${fieldName}`,
        field: fieldName,
        value: frontmatter[fieldName],
        ...(suggestion && { suggestion: `Did you mean '${suggestion}'?` }),
        autoFixable: false,
      });
    }
  }

  // Note: Body stale-reference detection is deferred to v2.0
  // Per product scope, v1.0 only validates frontmatter relation fields

  // Body checks share a single body read. `parseNote` is only invoked when at
  // least one body check is going to run, and at most once per file.
  const wantsUnlinkedMention =
    Boolean(entityMentionIndex?.surfacePattern) &&
    options.ignoreIssue !== 'unlinked-mention' &&
    (options.onlyIssue === undefined || options.onlyIssue === 'unlinked-mention');

  // Body-section validation (#510): the type declares heading sections in
  // `body_sections`; flag any that are missing from the note body. Distinct
  // from unlinked-mention/relation checks (those validate links; this validates
  // heading structure). Skipped when filtered out or when the type has none.
  const wantsBodySections =
    typeDef.bodySections.length > 0 &&
    options.ignoreIssue !== 'missing-body-section' &&
    (options.onlyIssue === undefined || options.onlyIssue === 'missing-body-section');

  // Body-link validation (#652): broken/malformed body wikilinks + broken
  // relative file/image links. Distinct from unlinked-mention (plain-text
  // mentions) and frontmatter relation checks. Runs whenever any of its codes is
  // in scope.
  //
  // The gate intentionally depends on `--only` (onlyIssue) but NOT on `--ignore`
  // (ignoreIssue): the three body-link codes share one detection pass, so
  // ignoring a single code must not skip the whole block — otherwise the other
  // two codes would be silently dropped. Per-code `--ignore` filtering happens on
  // the produced issues below (`issue.code !== options.ignoreIssue`).
  const bodyLinkCodes: IssueCode[] = [
    'broken-body-wikilink',
    'malformed-body-wikilink',
    'broken-body-file-link',
  ];
  const wantsBodyLinks =
    options.onlyIssue === undefined || bodyLinkCodes.includes(options.onlyIssue);

  if (wantsUnlinkedMention || wantsBodySections || wantsBodyLinks) {
    try {
      const { body } = await parseNote(file.path);
      const hasBody = Boolean(body && body.trim().length > 0);

      if (wantsUnlinkedMention && hasBody && entityMentionIndex) {
        issues.push(
          ...detectUnlinkedMentions(body, file.relativePath, entityMentionIndex, {
            ...(options.mentionFuzzyThreshold !== undefined
              ? { fuzzyThreshold: options.mentionFuzzyThreshold }
              : {}),
            ...(options.mentionFuzzyEnabled !== undefined
              ? { fuzzyEnabled: options.mentionFuzzyEnabled }
              : {}),
          })
        );
      }

      // A note with an empty body is still missing every declared section, so
      // body-section validation runs even when the body is blank.
      if (wantsBodySections) {
        issues.push(...detectMissingBodySections(body ?? '', typeDef.bodySections));
      }

      // Body-link validation only matters when there is a body to scan.
      if (wantsBodyLinks && hasBody) {
        const bodyLinkIssues = detectBodyLinks(
          body,
          file.relativePath,
          vaultDir,
          noteIndex?.noteTargetIndex
        ).filter(
          (issue) =>
            (options.onlyIssue === undefined || issue.code === options.onlyIssue) &&
            issue.code !== options.ignoreIssue
        );
        issues.push(...bodyLinkIssues);
      }
    } catch {
      // If the body can't be parsed, skip body-level detections for this file.
    }
  }

  // Check for ownership violations
  if (ownershipIndex && noteIndex?.notePathMap) {
    const ownershipIssues = await checkOwnershipViolations(
      file,
      frontmatter,
      fields,
      ownershipIndex,
      noteIndex.notePathMap
    );
    issues.push(...ownershipIssues);
  }

  // Check for list element integrity issues
  issues.push(...checkListElementIntegrity(frontmatter, fields));

  // Check for parent cycles in recursive types
  if (parentMap && typeDef.recursive) {
    const cycleIssue = checkParentCycle(file, parentMap);
    if (cycleIssue) {
      issues.push(cycleIssue);
    }
  }

  // ============================================================================
  // Phase 2: Low-risk hygiene issue detection
  // ============================================================================

  // Check for hygiene issues in all frontmatter values
  const hygieneIssues = checkHygieneIssues(frontmatter, fields, fieldNames);
  issues.push(...hygieneIssues);

  return issues;
}

type ResolvedRelationTarget = {
  rawTarget: string;
  candidates: string[];
  resolvedPath?: string | undefined;
};

function resolveRelationTarget(
  noteTargetIndex: import('../discovery.js').NoteTargetIndex | undefined,
  rawTarget: string
): ResolvedRelationTarget {
  if (!noteTargetIndex) {
    return { rawTarget, candidates: [], resolvedPath: undefined };
  }

  // Case-insensitive lookup, consistent with `open`/navigation resolution
  // (`resolveNoteQuery`). `targetToPaths` is keyed by the lowercased target name,
  // with a real note name still winning over an alias of the same string. A
  // unique match resolves (no stale); multiple matches stay ambiguous and are
  // never auto-resolved; zero matches surface as a stale reference.
  const candidates = noteTargetIndex.targetToPaths.get(rawTarget.toLowerCase()) ?? [];
  if (candidates.length === 1) {
    return { rawTarget, candidates, resolvedPath: candidates[0] };
  }

  return { rawTarget, candidates, resolvedPath: undefined };
}

function filterCandidatesBySource(
  schema: LoadedSchema,
  source: string | string[] | undefined,
  candidates: string[],
  noteTargetIndex: import('../discovery.js').NoteTargetIndex | undefined
): string[] {
  if (!source || !noteTargetIndex) return candidates;

  const sources = Array.isArray(source) ? source : [source];
  if (sources.includes('any')) return candidates;

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

  if (validTypes.size === 0) return candidates;

  return candidates.filter((relativePath) => {
    const pathKey = relativePath.replace(/\.md$/, '');
    const resolvedType = noteTargetIndex.pathNoExtToType.get(pathKey);
    return resolvedType ? validTypes.has(resolvedType) : false;
  });
}

function toArrayValue(value: unknown): unknown[] {
  const values: unknown[] = [];
  const visit = (item: unknown) => {
    if (Array.isArray(item)) {
      for (const entry of item) {
        visit(entry);
      }
      return;
    }
    values.push(item);
  };
  visit(value);
  return values;
}

function normalizeWikilinkFlowSequence(value: unknown): string | null {
  // YAML parses `[[Foo]]` as a flow sequence containing another flow sequence.
  // When we reach the relation checker, we may see either:
  // - the outer array: [ [ 'Foo' ] ] (frontmatter field value)
  // - the inner array: [ 'Foo' ] (a single element of that outer array)
  // Treat both as an Obsidian wikilink.
  if (Array.isArray(value) && value.length === 1) {
    if (typeof value[0] === 'string') {
      return `[[${value[0]}]]`;
    }

    if (Array.isArray(value[0]) && value[0].length === 1 && typeof value[0][0] === 'string') {
      return `[[${value[0][0]}]]`;
    }
  }

  return null;
}

function checkRelationFieldIssues(
  schema: LoadedSchema,
  fieldName: string,
  value: unknown,
  field: Field,
  noteTargetIndex: import('../discovery.js').NoteTargetIndex | undefined,
  noteTypeMap: Map<string, string> | undefined,
  file: ManagedFile
): AuditIssue[] {
  const issues: AuditIssue[] = [];

  if (!value) return issues;

  const rawValues = toArrayValue(value).filter(v => v !== null && v !== undefined);
  if (rawValues.length === 0) return issues;

  const noteName = basename(file.path, '.md');
  const notePathKey = file.relativePath.replace(/\.md$/, '');

  for (let index = 0; index < rawValues.length; index++) {
    const rawValue = rawValues[index];
    const rawString = typeof rawValue === 'string' ? rawValue : normalizeWikilinkFlowSequence(rawValue);
    if (!rawString) continue;

    const rawTarget = extractLinkTarget(rawString) ?? rawString.trim();
    if (!rawTarget) continue;

    const resolvedTarget = resolveRelationTarget(noteTargetIndex, rawTarget);

    if (resolvedTarget.candidates.length === 0 && noteTargetIndex) {
      if (field.prompt === 'relation') {
        const allTargets = new Set(noteTargetIndex.targetToPaths.keys());
        const allPaths = Array.from(noteTargetIndex.targetToPaths.values()).flat();
        for (const path of allPaths) {
          allTargets.add(path.replace(/\.md$/, ''));
        }
        const staleIssue = checkStaleReference(fieldName, rawString, allTargets, false);
        if (staleIssue) {
          issues.push(staleIssue);
        }
      }
      continue;
    }

    const filteredCandidates = filterCandidatesBySource(
      schema,
      field.source,
      resolvedTarget.candidates,
      noteTargetIndex
    );

    const selfMatchCandidates = filteredCandidates.filter((candidate) => {
      const candidateKey = candidate.replace(/\.md$/, '');
      return candidateKey === notePathKey || candidateKey === noteName;
    });

    if (selfMatchCandidates.length === 1 && filteredCandidates.length === 1) {
      issues.push({
        severity: 'error',
        code: 'self-reference',
        message: `Self-reference detected: ${fieldName} points to itself`,
        field: fieldName,
        value: rawString,
        listIndex: Array.isArray(value) ? index : undefined,
        autoFixable: false,
      });
      continue;
    }

    if (filteredCandidates.length > 1) {
      const candidateMeta = filteredCandidates.map((candidate) => ({
        basename: candidate.replace(/.*\//, '').replace(/\.md$/, ''),
        path: candidate,
      }));
      issues.push({
        severity: 'warning',
        code: 'ambiguous-link-target',
        message: `Ambiguous link target for ${fieldName}: '${rawTarget}' matches multiple files`,
        field: fieldName,
        value: rawString,
        candidates: filteredCandidates,
        meta: {
          originalToken: rawString,
          candidates: candidateMeta,
          chosen: null,
        },
        listIndex: Array.isArray(value) ? index : undefined,
        autoFixable: false,
      });
      continue;
    }

    const resolvedPath =
      filteredCandidates.length === 1 ? filteredCandidates[0] : resolvedTarget.resolvedPath;


    if (resolvedPath && noteTypeMap && field.source) {
      const pathKey = resolvedPath.replace(/\.md$/, '');
      const resolvedType = noteTypeMap.get(pathKey) ?? noteTypeMap.get(rawTarget);
      if (resolvedType) {
        const sourceIssues = checkContextFieldSource(schema, fieldName, rawString, field.source, noteTypeMap);
        issues.push(...sourceIssues);
      }
    }

  }

  return issues;
}

/**
 * Recurrence detection (#107):
 * - `invalid-recurrence`: the type's recurrence rule is broken at the config
 *   level (malformed trigger, non-date offset base, or a template that doesn't
 *   exist). A deterministic config error — config gets the same safety net as
 *   data. Reported once per recurring note (so it surfaces during normal audits).
 * - `missing-successor`: the note satisfies the trigger but its chain field
 *   (`next`) is empty — a successor was never spawned (e.g. completed outside
 *   bwrb). Auto-fixable: --fix spawns the missing successor (same engine as the
 *   fast path). Suppressed when the rule is invalid (fixing it would fail).
 */
async function checkRecurrenceIssues(
  schema: LoadedSchema,
  vaultDir: string,
  typePath: string,
  frontmatter: Record<string, unknown>,
  wantInvalidRecurrence: boolean,
  wantMissingSuccessor: boolean
): Promise<AuditIssue[]> {
  const issues: AuditIssue[] = [];

  const resolved = getRecurrenceForType(schema, typePath);
  if (!resolved) return issues;

  // Static rule validation (trigger parses; offsets are field-offsets with a
  // date base; offset target fields exist).
  const ruleIssues = validateRecurrenceRule(schema, typePath);

  // Template existence (needs vault I/O). The successor template defaults to the
  // type's own default template; a named template can target any type.
  if (resolved.recurrence.template) {
    const all = await findAllTemplates(vaultDir);
    const named = resolved.recurrence.template;
    const match = all.find((t) => t.name === named);
    if (!match) {
      ruleIssues.push({
        message: `Recurrence trait '${resolved.trait}' on type '${typePath}' references template '${named}', which does not exist in the vault.`,
      });
    } else if (!getType(schema, match.templateFor)) {
      ruleIssues.push({
        message: `Recurrence template '${named}' targets unknown type '${match.templateFor}'.`,
      });
    }
  } else {
    // Default path: the type must have a (possibly inherited) default template
    // to spawn from.
    const def = await findDefaultTemplateWithInheritance(vaultDir, typePath, schema);
    if (!def) {
      ruleIssues.push({
        message: `Recurrence trait '${resolved.trait}' on type '${typePath}' spawns from the type's default template, but no default template was found for '${typePath}'.`,
      });
    }
  }

  const ruleInvalid = ruleIssues.length > 0;

  if (wantInvalidRecurrence && ruleInvalid) {
    for (const ruleIssue of ruleIssues) {
      issues.push({
        severity: 'error',
        code: 'invalid-recurrence',
        message: ruleIssue.message,
        autoFixable: false,
      });
    }
  }

  // Missing-successor backstop: only meaningful when the rule is valid (a fix
  // would otherwise fail). Predicate: trigger satisfied AND `next` empty.
  if (wantMissingSuccessor && !ruleInvalid && needsSuccessor(schema, typePath, frontmatter)) {
    issues.push({
      severity: 'warning',
      code: 'missing-successor',
      message: `Recurring note satisfies its trigger but has no successor ('${CHAIN_NEXT_FIELD}' is empty). Run with --fix to spawn it.`,
      field: CHAIN_NEXT_FIELD,
      autoFixable: true,
    });
  }

  return issues;
}

function checkListElementIntegrity(
  frontmatter: Record<string, unknown>,
  fields: Record<string, Field>
): AuditIssue[] {
  const issues: AuditIssue[] = [];

  for (const [fieldName, field] of Object.entries(fields)) {
    if (!field || (field.prompt !== 'list' && !field.multiple)) continue;

    // Alias-role fields are owned exclusively by the `illegal-aliases`
    // detection+fix (checkIllegalAliases / fixIllegalAliases), which validates
    // the whole field as a unit and safely drops blanks + dedupes in one pass.
    // We must NOT also run the generic `invalid-list-element` blank-remover on
    // them: that remover deletes blank entries by original index applied
    // sequentially to a shrinking array, so with 2+ leading blanks a stale
    // index destroys a distinct alias when both fire in the same auto-fix pass
    // (data loss, #617). This mirrors the `duplicate-list-values` suppression
    // for alias fields in checkHygieneIssues — alias-field list cleanup has a
    // single owner.
    if (field.alias === true) continue;

    const value = frontmatter[fieldName];
    if (value === null || value === undefined) continue;

    if (!Array.isArray(value)) continue;

    const nonEmptyCount = value.filter((item) => {
      if (item === null || item === undefined) return false;
      if (typeof item === 'string' && item.trim().length === 0) return false;
      return true;
    }).length;

    value.forEach((item, index) => {
      if (item === null || item === undefined) {
        const canRemove = !field.required || nonEmptyCount > 0;
        issues.push({
          severity: 'warning',
          code: 'invalid-list-element',
          message: `Invalid list element in '${fieldName}' at index ${index}`,
          field: fieldName,
          value: item,
          listIndex: index,
          autoFixable: canRemove,
          meta: {
            reason: 'null',
            action: 'remove',
          },
        });
        return;
      }

      if (typeof item === 'string' && item.trim().length === 0) {
        const canRemove = !field.required || nonEmptyCount > 0;
        issues.push({
          severity: 'warning',
          code: 'invalid-list-element',
          message: `Invalid list element in '${fieldName}' at index ${index}`,
          field: fieldName,
          value: item,
          listIndex: index,
          autoFixable: canRemove,
          meta: {
            reason: 'empty-string',
            action: 'remove',
          },
        });
        return;
      }

      if (Array.isArray(item)) {
        const canFlatten = value.length === 1 && item.every((entry) => typeof entry === 'string');
        issues.push({
          severity: 'warning',
          code: 'invalid-list-element',
          message: `Invalid list element in '${fieldName}' at index ${index}`,
          field: fieldName,
          value: item,
          listIndex: index,
          autoFixable: canFlatten,
          meta: {
            reason: 'nested-list',
            action: canFlatten ? 'flatten' : 'manual',
          },
        });
        return;
      }

      if (typeof item !== 'string') {
        // Numeric elements of a date field are owned by the date check
        // (checkDateElement): a number in a date field is a date candidate, not a
        // structural wrong-type. It is reported once there — as invalid-date-format
        // when it isn't a valid date, or wrong-scalar-type ("quote it") when it is.
        // Skipping here keeps each bad element single-reported and aligns date
        // lists with scalar dates and the create/edit path (#641).
        if (field.prompt === 'date' && typeof item === 'number') {
          return;
        }

        const canCoerce = typeof item === 'number' || typeof item === 'boolean';
        issues.push({
          severity: 'warning',
          code: 'invalid-list-element',
          message: `Invalid list element in '${fieldName}' at index ${index}`,
          field: fieldName,
          value: item,
          listIndex: index,
          autoFixable: canCoerce,
          meta: {
            reason: 'wrong-type',
            action: canCoerce ? 'coerce' : 'manual',
            expectedType: 'string',
          },
        });
      }
    });
  }

  return issues;
}
function repairNearWikilink(trimmed: string): string | null {
  if (trimmed.startsWith('[[') && trimmed.endsWith(']') && !trimmed.endsWith(']]')) {
    return `${trimmed}]`;
  }

  if (trimmed.startsWith('[') && !trimmed.startsWith('[[') && trimmed.endsWith(']]')) {
    return `[${trimmed}`;
  }

  return null;
}

function collectStructuralIssues(
  structural: Awaited<ReturnType<typeof readStructuralFrontmatter>>,
  frontmatter: Record<string, unknown>
): AuditIssue[] {
  const issues: AuditIssue[] = [];

  // frontmatter-not-at-top
  if (structural.primaryBlock && !structural.atTop) {
    const autoFixable =
      structural.frontmatterBlocks.length === 1 &&
      !structural.unterminated &&
      structural.yamlErrors.length === 0;

    issues.push({
      severity: 'error',
      code: 'frontmatter-not-at-top',
      message: autoFixable
        ? 'Frontmatter is not at the top of the file'
        : 'Frontmatter is not at the top of the file (ambiguous; not auto-fixable)',
      autoFixable,
    });
  }

  // duplicate-frontmatter-keys
  if (structural.doc && isMap(structural.doc.contents)) {
    const map = structural.doc.contents as YAMLMap;
    const groups = new Map<string, Pair[]>();

    for (const pair of map.items as Pair[]) {
      const key = String((pair.key as Scalar)?.value ?? '');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(pair);
    }

    for (const [key, pairs] of groups.entries()) {
      if (!key || pairs.length < 2) continue;

      const values = pairs.map((p) => extractYamlNodeValue((p as { value?: unknown }).value));
      const nonEmptyValues = values.filter((v: unknown) => !isEffectivelyEmpty(v));

      let autoFixable = false;
      if (nonEmptyValues.length === 0) {
        autoFixable = true;
      } else {
        const uniqueNonEmpty: unknown[] = [];
        for (const v of nonEmptyValues) {
          if (!uniqueNonEmpty.some((u) => isDeepStrictEqual(u, v))) {
            uniqueNonEmpty.push(v);
          }
        }
        // Auto-merge when all non-empty values are effectively the same.
        autoFixable = uniqueNonEmpty.length === 1;
      }

      issues.push({
        severity: 'error',
        code: 'duplicate-frontmatter-keys',
        message: `Duplicate frontmatter key: ${key}`,
        field: key,
        autoFixable,
        duplicateKey: key,
        duplicateCount: pairs.length,
      });
    }
  }

  // malformed-wikilink (frontmatter-only)
  for (const [key, value] of Object.entries(frontmatter)) {
    if (typeof value === 'string') {
      const inner = value.trim();
      const repaired = repairNearWikilink(inner);
      if (repaired) {
        const leading = value.match(/^\s*/)?.[0] ?? '';
        const trailing = value.match(/\s*$/)?.[0] ?? '';
        const fixedValue = `${leading}${repaired}${trailing}`;
        issues.push({
          severity: 'error',
          code: 'malformed-wikilink',
          message: `Malformed wikilink in frontmatter: ${key}`,
          field: key,
          value,
          fixedValue,
          autoFixable: true,
        });
      }
      continue;
    }

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (typeof item !== 'string') continue;
        const inner = item.trim();
        const repaired = repairNearWikilink(inner);
        if (!repaired) continue;

        const leading = item.match(/^\s*/)?.[0] ?? '';
        const trailing = item.match(/\s*$/)?.[0] ?? '';
        const fixedValue = `${leading}${repaired}${trailing}`;
        issues.push({
          severity: 'error',
          code: 'malformed-wikilink',
          message: `Malformed wikilink in frontmatter list: ${key}[${i}]`,
          field: key,
          value: item,
          fixedValue,
          listIndex: i,
          autoFixable: true,
        });
      }
    }
  }

  return issues;
}

/**
 * Check if a field value violates its expected format.
 * 
 * For wikilinks: After YAML parsing, the value should be [[Target]]
 * For markdown: After YAML parsing, the value should be [Target](Target.md)
 */
function checkFormatViolation(
  fieldName: string,
  value: unknown,
  expectedFormat: 'wikilink' | 'markdown'
): AuditIssue | null {
  const strValue = String(value);
  if (!strValue) return null;

  switch (expectedFormat) {
    case 'wikilink':
      // Wikilink values should be [[Target]] after YAML parsing
      if (!isWikilink(strValue)) {
        return {
          severity: 'error',
          code: 'format-violation',
          message: `Format violation: '${fieldName}' should be a wikilink, got plain text or markdown`,
          field: fieldName,
          value: strValue,
          expected: 'wikilink (e.g., [[value]])',
          expectedFormat: 'wikilink',
          autoFixable: true,
        };
      }
      break;
    case 'markdown':
      // Markdown links should be [Target](Target.md) after YAML parsing
      if (!isMarkdownLink(strValue)) {
        return {
          severity: 'error',
          code: 'format-violation',
          message: `Format violation: '${fieldName}' should be a markdown link, got plain text or wikilink`,
          field: fieldName,
          value: strValue,
          expected: 'markdown link (e.g., [value](value.md))',
          expectedFormat: 'markdown',
          autoFixable: true,
        };
      }
      break;
  }

  return null;
}

/**
 * Check if a wikilink reference points to a non-existent file.
 */
function checkStaleReference(
  fieldName: string,
  value: unknown,
  allFiles: Set<string>,
  inBody: boolean,
  lineNumber?: number
): AuditIssue | null {
  const strValue = String(value);
  const target = extractWikilinkTarget(strValue);
  
  if (!target) return null;
  
  // Check if target exists (by basename or full path)
  if (allFiles.has(target) || allFiles.has(basename(target))) {
    return null;
  }

  // Find similar files for suggestions
  const similarFiles = findSimilarFiles(target, allFiles);

  const issue: AuditIssue = {
    severity: 'warning',
    code: 'stale-reference',
    message: inBody
      ? `Stale reference on line ${lineNumber}: '[[${target}]]' not found`
      : `Stale reference: ${fieldName} '[[${target}]]' not found`,
    value: strValue,
    targetName: target,
    autoFixable: false,
    inBody,
  };
  
  if (!inBody && fieldName) {
    issue.field = fieldName;
  }
  if (similarFiles.length > 0) {
    issue.similarFiles = similarFiles;
  }
  if (lineNumber !== undefined) {
    issue.lineNumber = lineNumber;
  }
  
  return issue;
}

// ============================================================================
// Context Field Source Validation
// ============================================================================

/**
 * Check if a context field value matches its source type constraint.
 * 
 * The source property can specify:
 * - A type name (e.g., "milestone") - only that exact type is valid
 * - A parent type name (e.g., "objective") - that type and all descendants are valid
 * - "any" - any note is valid (no type checking)
 * - A dynamic_source name (legacy) - skip validation (handled by separate migration)
 * 
 * Handles both single values and arrays (for multiple: true fields).
 */
function checkContextFieldSource(
  schema: LoadedSchema,
  fieldName: string,
  value: unknown,
  source: string | string[],
  noteTypeMap: Map<string, string>
): AuditIssue[] {
  const issues: AuditIssue[] = [];
  
  // Normalize source to array
  const sources = Array.isArray(source) ? source : [source];
  
  // Handle "any" source - no type restriction
  if (sources.includes('any')) return issues;
  
  // Get all valid types (each source type + all their descendants)
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
  
  if (validTypes.size === 0) {
    // No valid source types found - schema validation should catch this
    return issues;
  }
  
  // Handle array values (multiple: true fields)
  const values = Array.isArray(value) ? value : [value];
  
  for (const v of values) {
    const issue = checkSingleContextValue(
      fieldName, v, sources, validTypes, noteTypeMap
    );
    if (issue) {
      issues.push(issue);
    }
  }
  
  return issues;
}

/**
 * Check a single context field value against the source type constraint.
 */
function checkSingleContextValue(
  fieldName: string,
  value: unknown,
  sources: string[],
  validTypes: Set<string>,
  noteTypeMap: Map<string, string>
): AuditIssue | null {
  const strValue = String(value);
  const target = extractWikilinkTarget(strValue);
  
  if (!target) return null;
  
  // Look up the referenced note's type
  const actualType = noteTypeMap.get(target);
  if (!actualType) {
    // Note doesn't exist or has no type - stale reference check handles this
    return null;
  }
  
  // Check if actual type is in the set of valid types
  if (validTypes.has(actualType)) {
    return null; // Valid
  }
  
  // Type mismatch!
  const validTypesArray = Array.from(validTypes);
  const suggestion = suggestOptionValue(actualType, validTypesArray);
  
  const sourceDisplay = sources.length === 1 ? sources[0] : sources.join(' or ');
  return {
    severity: 'error',
    code: 'invalid-source-type',
    message: `Type mismatch: '${fieldName}' expects ${sourceDisplay}${validTypesArray.length > sources.length ? ' (or descendant)' : ''}, but '${target}' is ${actualType}`,
    field: fieldName,
    value: strValue,
    expectedType: sources[0],
    actualType: actualType,
    expected: validTypesArray.length > 1 ? validTypesArray : sources[0],
    ...(suggestion && { suggestion: `Did you mean to link to a ${suggestion}?` }),
    autoFixable: false,
  };
}

// ============================================================================
// Ownership Violation Detection
// ============================================================================

/**
 * Check for ownership violations in frontmatter references.
 * 
 * Detects:
 * - owned-note-referenced: A note references an owned note via a schema field
 * - owned-wrong-location: An owned note is not in the expected location
 */
async function checkOwnershipViolations(
  file: ManagedFile,
  frontmatter: Record<string, unknown>,
  fields: Record<string, Field>,
  ownershipIndex: OwnershipIndex,
  notePathMap: Map<string, string>
): Promise<AuditIssue[]> {
  const issues: AuditIssue[] = [];
  
  // Check if this file is owned and in the wrong location
  const ownedInfo = isNoteOwned(ownershipIndex, file.relativePath);
  if (ownedInfo && file.ownership) {
    // Note is owned - verify it's in the correct location
    // The expected location is based on ownership relationship
    const ownerDir = dirname(ownedInfo.ownerPath);
    const expectedDir = `${ownerDir}/${ownedInfo.fieldName}`;
    const actualDir = dirname(file.relativePath);
    
    // Normalize paths for comparison
    const normalizedExpected = expectedDir.replace(/\/$/, '');
    const normalizedActual = actualDir.replace(/\/$/, '');
    
    if (normalizedActual !== normalizedExpected) {
      issues.push({
        severity: 'error',
        code: 'owned-wrong-location',
        message: `Owned note in wrong location: expected in ${expectedDir}`,
        expected: expectedDir,
        currentDirectory: actualDir,
        expectedDirectory: expectedDir,
        autoFixable: true, // Can be auto-fixed with --fix
        ownerPath: ownedInfo.ownerPath,
        ownedNotePath: file.relativePath,
      });
    }
  }
  
  // Check each relation field to see if it references an owned note
  for (const [fieldName, field] of Object.entries(fields)) {
    // Skip non-relation fields and owned fields (owner is allowed to reference its owned notes)
    if (field.prompt !== 'relation') {
      continue;
    }
    
    // If this field is marked as owned, the current note IS the owner - skip
    if (field.owned) {
      continue;
    }
    
    const value = frontmatter[fieldName];
    if (!value) continue;
    
    // Extract wikilink references from the field value
    const references = extractWikilinkReferences(value);
    
    for (const refName of references) {
      // Look up the referenced note's path using the path map
      const refPath = notePathMap.get(refName);
      
      if (!refPath) {
        // Note not found - stale reference check handles this
        continue;
      }
      
      // Check if referenced note is owned
      const validation = canReference(ownershipIndex, file.relativePath, refPath);
      
      if (!validation.valid) {
        for (const error of validation.errors) {
          issues.push({
            severity: 'error',
            code: 'owned-note-referenced',
            message: `Cannot reference owned note '${refName}' - it is owned by '${error.details?.existingOwnerPath}'`,
            field: fieldName,
            value: value,
            autoFixable: false,
            ownerPath: error.details?.existingOwnerPath,
            ownedNotePath: refPath,
          });
        }
      }
    }
  }
  
  return issues;
}

// ============================================================================
// Parent Cycle Detection
// ============================================================================

/**
 * Build a map from note names to their parent note names for recursive types.
 * Used to detect cycles in parent references (e.g., A -> B -> A).
 */
async function buildParentMap(
  schema: LoadedSchema,
  files: ManagedFile[],
  noteIndex: import('../discovery.js').VaultNoteIndex | undefined
): Promise<Map<string, string>> {
  const parentMap = new Map<string, string>();
  const noteTargetIndex = noteIndex?.noteTargetIndex;
  const snapshotByRelativePath = new Map(
    (noteIndex?.snapshot.notes ?? []).map((note) => [note.relativePath, note] as const)
  );
  
  for (const file of files) {
    try {
      const snapshotNote = snapshotByRelativePath.get(file.relativePath);
      const frontmatter = snapshotNote?.frontmatter;
      if (!frontmatter) continue;

      const typePath = snapshotNote.resolvedType ?? resolveTypeFromFrontmatter(schema, frontmatter);
      if (!typePath) continue;
      
      const typeDef = getType(schema, typePath);
      if (!typeDef?.recursive) continue;
      
      // Get the parent field value
      const parentValue = frontmatter['parent'];
      if (!parentValue) continue;
      
      const parentString = typeof parentValue === 'string' ? parentValue : normalizeWikilinkFlowSequence(parentValue);
      if (!parentString) continue;

      const parentTarget = extractLinkTarget(parentString);
      if (!parentTarget) continue;

      const resolvedTarget = resolveRelationTarget(noteTargetIndex, parentTarget);
      if (resolvedTarget.candidates.length !== 1 || !resolvedTarget.resolvedPath) continue;

      // Only consider parent chains within the same recursive type.
      if (noteTargetIndex) {
        const parentKey = resolvedTarget.resolvedPath.replace(/\.md$/, '');
        const parentType = noteTargetIndex.pathNoExtToType.get(parentKey);
        if (parentType !== typePath) continue;
      }

      const childKey = file.relativePath.replace(/\.md$/, '');
      const parentKey = resolvedTarget.resolvedPath.replace(/\.md$/, '');
      parentMap.set(childKey, parentKey);
    } catch {
      // Skip files that can't be parsed
    }
  }
  
  return parentMap;
}

/**
 * Check if a note is part of a parent cycle.
 * Returns an AuditIssue if a cycle is detected, null otherwise.
 */
function checkParentCycle(
  file: ManagedFile,
  parentMap: Map<string, string>
): AuditIssue | null {
  const startKey = file.relativePath.replace(/\.md$/, '');
  const visited = new Set<string>();
  const pathKeys: string[] = [startKey];
  const pathDisplay: string[] = [basename(startKey)];

  visited.add(startKey);

  let current = parentMap.get(startKey);
  
  while (current) {
    if (visited.has(current)) {
      // Found a cycle that includes the original note
      return {
        severity: 'error',
        code: 'parent-cycle',
        message: `Parent cycle detected: ${pathDisplay.join(' → ')} → ${basename(current)}`,
        field: 'parent',
        autoFixable: false,
        cyclePath: [...pathDisplay, basename(current)],
      };
    }
    
    visited.add(current);
    pathKeys.push(current);
    pathDisplay.push(basename(current));
    current = parentMap.get(current);
  }
  
  return null;
}

// ============================================================================
// Phase 2: Hygiene Issue Detection
// ============================================================================


function detectTrailingWhitespaceInRawFrontmatter(
  structural: Awaited<ReturnType<typeof readStructuralFrontmatter>>
): AuditIssue[] {
  if (!structural.primaryBlock || structural.yaml === null) return [];

  const { yamlStart, yamlEnd } = structural.primaryBlock;
  const allLines = splitLinesPreserveEol(structural.raw);

  const frontmatterLines = allLines.filter(
    (line) => line.startOffset >= yamlStart && line.startOffset < yamlEnd
  );

  const issues: AuditIssue[] = [];

  let inBlockScalar = false;
  let blockScalarIndent = 0;

  for (let i = 0; i < frontmatterLines.length; i++) {
    const line = frontmatterLines[i]!;
    const text = line.text;

    const parsed = parseSimpleYamlKeyValueLine(text);

    if (inBlockScalar) {
      if (parsed && parsed.indent <= blockScalarIndent) {
        // Block scalars end when a new key appears at the same or lower indentation.
        inBlockScalar = false;
        i--; // re-process this line outside the block context
      }
      continue;
    }

    if (!parsed) continue;

    const { indent, key, rest } = parsed;

    // Skip discriminator fields.
    if (key === 'type' || key.endsWith('-type')) continue;

    const restTrimStart = rest.replace(/^[ \t]*/, '');

    // Nested structures (`key:` with no inline value) are not single-line scalars.
    if (restTrimStart === '' || restTrimStart.startsWith('#')) continue;

    // Block scalars are not single-line scalars; skip their content entirely.
    if (isBlockScalarHeader(restTrimStart)) {
      inBlockScalar = true;
      blockScalarIndent = indent;
      continue;
    }

    // Detect trailing spaces/tabs at end-of-line.
    if (/[ \t]+$/.test(text)) {
      const trimmed = text.replace(/[ \t]+$/, '');
      const trimmedCount = text.length - trimmed.length;
      issues.push({
        severity: 'warning',
        code: 'trailing-whitespace',
        message: `Trailing whitespace in '${key}'`,
        field: key,
        value: restTrimStart,
        autoFixable: true,
        lineNumber: line.lineNumber,
        meta: {
          line: line.lineNumber,
          before: text,
          after: trimmed,
          trimmedCount,
        },
      });
    }
  }

  return issues;
}

/**
 * Check for low-risk hygiene issues that can be auto-fixed.
 * 
 * Detects:
 * - trailing-whitespace: String values with trailing whitespace
 * - frontmatter-key-casing: Keys that don't match schema casing
 * - unknown-enum-casing: Select field values with wrong case
 * - duplicate-list-values: Arrays with duplicate values (case-sensitive)
 * - invalid-boolean-coercion: "true"/"false" strings for boolean fields
 * - singular-plural-mismatch: Keys like 'tag' when schema has 'tags'
 */
function checkHygieneIssues(
  frontmatter: Record<string, unknown>,
  fields: Record<string, Field>,
  schemaFieldNames: Set<string>
): AuditIssue[] {
  const issues: AuditIssue[] = [];
  
  // Build case-insensitive map of schema field names for key casing checks
  const schemaKeyMap = new Map<string, string[]>();
  for (const key of schemaFieldNames) {
    const lower = key.toLowerCase();
    const existing = schemaKeyMap.get(lower);
    if (existing) {
      existing.push(key);
    } else {
      schemaKeyMap.set(lower, [key]);
    }
  }
  
  for (const [fieldName, value] of Object.entries(frontmatter)) {
    // Skip type discriminators
    if (fieldName === 'type' || fieldName.endsWith('-type')) continue;
    
    const field = fields[fieldName];
    
    // NOTE: trailing-whitespace detection is handled on raw frontmatter earlier
    // (before YAML parsing), because YAML parsers normalize trailing whitespace.
    
    // Check for invalid boolean coercion ("true"/"false" strings)
    if (field?.prompt === 'boolean') {
      const boolIssue = checkInvalidBooleanCoercion(fieldName, value);
      if (boolIssue) {
        issues.push(boolIssue);
      }
    }
    
    // Check enum casing for select fields
    if (field?.options && field.options.length > 0) {
      const enumIssue = checkUnknownEnumCasing(fieldName, value, getOptionValues(field.options));
      if (enumIssue) {
        issues.push(enumIssue);
      }
    }
    
    // Alias-role fields are validated as a unit by checkIllegalAliases below
    // (empty/whitespace, duplicate, AND non-string entries → one
    // `illegal-aliases` error). Duplicate aliases must surface at error severity
    // to match the write path, so we do NOT also run the generic
    // `duplicate-list-values` warning check on them — that would both
    // double-report and contradict the write path's hard rejection (#617).
    const isAliasField = field?.alias === true && Array.isArray(value);

    // Check for duplicate list values (case-sensitive). Non-alias lists only.
    if (Array.isArray(value) && !isAliasField) {
      const dupIssue = checkDuplicateListValues(fieldName, value);
      if (dupIssue) {
        issues.push(dupIssue);
      }
    }

    // Alias-role fields: enforce the Obsidian aliases format (array of
    // non-empty, unique strings) as a single `illegal-aliases` error, matching
    // what the write path (new/edit) rejects. Empty/whitespace entries and
    // duplicates are safely auto-fixable (drop blanks; dedupe preserving the
    // first occurrence); a non-string entry makes the issue flag-only (#266, #617).
    if (isAliasField) {
      const aliasIssue = checkIllegalAliases(fieldName, value as unknown[]);
      if (aliasIssue) {
        issues.push(aliasIssue);
      }
    }

    // Check for key casing mismatch (only for known fields with wrong case)
    const keyCasingIssue = checkFrontmatterKeyCasing(
      fieldName, value, frontmatter, schemaKeyMap
    );
    if (keyCasingIssue) {
      issues.push(keyCasingIssue);
    }
    
    // Check for singular/plural mismatch
    const pluralIssue = checkSingularPluralMismatch(
      fieldName, value, frontmatter, schemaFieldNames
    );
    if (pluralIssue) {
      issues.push(pluralIssue);
    }
  }
  
  return issues;
}

// NOTE: checkTrailingWhitespace is not used because YAML parsers strip
// trailing whitespace during parsing. Keeping for future raw string detection.
// function checkTrailingWhitespace(
//   fieldName: string,
//   value: unknown
// ): AuditIssue | null {
//   if (typeof value !== 'string') return null;
//   if (value !== value.trimEnd()) {
//     return {
//       severity: 'warning',
//       code: 'trailing-whitespace',
//       message: `Trailing whitespace in '${fieldName}'`,
//       field: fieldName,
//       value: value,
//       autoFixable: true,
//     };
//   }
//   return null;
// }

/**
 * Check for "true"/"false" strings that should be boolean.
 */
function checkInvalidBooleanCoercion(
  fieldName: string,
  value: unknown
): AuditIssue | null {
  if (typeof value !== 'string') return null;

  const lower = value.trim().toLowerCase();
  if (lower === 'true' || lower === 'false') {
    const coercedTo = lower === 'true';
    return {
      severity: 'warning',
      code: 'invalid-boolean-coercion',
      message: `String '${value}' should be boolean in '${fieldName}'`,
      field: fieldName,
      value: value,
      expected: coercedTo ? 'true (boolean)' : 'false (boolean)',
      autoFixable: true,
      meta: {
        value,
        coercedTo,
        before: value,
        after: coercedTo,
      },
    };
  }
  
  return null;
}

/**
 * Check for enum values with wrong casing.
 * Only applies to select fields (fields with options).
 */
function checkUnknownEnumCasing(
  fieldName: string,
  value: unknown,
  options: string[]
): AuditIssue | null {
  if (typeof value !== 'string') return null;
  const strValue = value;

  // If exact match exists, no issue
  if (options.includes(strValue)) return null;

  // Check for case-insensitive match
  const lowerValue = strValue.toLowerCase();
  const matchingOptions = options.filter(opt => opt.toLowerCase() === lowerValue);

  if (matchingOptions.length === 1) {
    const matchingOption = matchingOptions[0]!;
    return {
      severity: 'warning',
      code: 'unknown-enum-casing',
      message: `Wrong case for '${fieldName}': '${strValue}' should be '${matchingOption}'`,
      field: fieldName,
      value: strValue,
      expected: matchingOption,
      canonicalValue: matchingOption,
      autoFixable: true,
      meta: {
        value: strValue,
        suggested: matchingOption,
        matchedBy: 'case-insensitive',
        before: strValue,
        after: matchingOption,
      },
    };
  }

  if (matchingOptions.length > 1) {
    return {
      severity: 'warning',
      code: 'unknown-enum-casing',
      message: `Ambiguous case for '${fieldName}': '${strValue}' matches multiple options`,
      field: fieldName,
      value: strValue,
      autoFixable: false,
      meta: {
        value: strValue,
        candidates: matchingOptions,
      },
    };
  }
  
  return null;
}

/**
 * Check for duplicate values in arrays (case-sensitive).
 */
function checkDuplicateListValues(
  fieldName: string,
  value: unknown[]
): AuditIssue | null {
  if (!value.every(item => typeof item === 'string')) return null;

  const seen = new Set<string>();
  const duplicates: string[] = [];
  const deduped: string[] = [];

  for (const item of value as string[]) {
    if (seen.has(item)) {
      duplicates.push(item);
    } else {
      seen.add(item);
      deduped.push(item);
    }
  }

  if (duplicates.length > 0) {
    return {
      severity: 'warning',
      code: 'duplicate-list-values',
      message: `Duplicate values in '${fieldName}': ${duplicates.join(', ')}`,
      field: fieldName,
      value: value,
      autoFixable: true,
      meta: {
        duplicates,
        removedCount: duplicates.length,
        before: value,
        after: deduped,
      },
    };
  }
  
  return null;
}

/**
 * Validate an alias-role field as a unit (the Obsidian `aliases` format: an
 * array of non-empty, UNIQUE strings). This mirrors the write path's
 * `validateAliasValue` (new/edit), which rejects empty/whitespace entries,
 * non-string entries, and duplicates as a hard error — so audit reports the same
 * conditions at `error` severity, keeping the two paths in agreement (#617).
 *
 * Auto-fixability (the safe, idempotent subset):
 * - empty/whitespace entries → dropped
 * - exact duplicates → de-duplicated, preserving the first occurrence
 * Both are non-destructive of meaningful data and converge on re-run, so a note
 * with only these problems is auto-fixable via the existing dedupe-style meta
 * pattern. The fixed list (`meta.after`) is computed here so the fixer is a pure
 * apply.
 *
 * A NON-STRING entry (number/boolean/object) is NOT safely auto-fixable — we
 * can't know the intended alias text — so its presence makes the whole issue
 * flag-only, surfaced for a manual fix.
 *
 * Scalar (non-array) alias values are handled separately as `wrong-scalar-type`
 * (this check only runs for array values).
 */
function checkIllegalAliases(
  fieldName: string,
  value: unknown[]
): AuditIssue | null {
  let hasEmpty = false;
  let hasDuplicate = false;
  let hasNonString = false;

  const seen = new Set<string>();
  const cleaned: string[] = [];

  for (const item of value) {
    if (typeof item !== 'string') {
      hasNonString = true;
      continue;
    }
    if (item.trim() === '') {
      hasEmpty = true;
      continue;
    }
    if (seen.has(item)) {
      hasDuplicate = true;
      continue;
    }
    seen.add(item);
    cleaned.push(item);
  }

  if (!hasEmpty && !hasDuplicate && !hasNonString) return null;

  // The empty/whitespace + dedupe fix is only safe when every offending entry is
  // either blank or a duplicate; a non-string entry blocks the auto-fix.
  const autoFixable = !hasNonString;

  const problems: string[] = [];
  if (hasEmpty) problems.push('empty/whitespace');
  if (hasDuplicate) problems.push('duplicate');
  if (hasNonString) problems.push('non-string');

  return {
    severity: 'error',
    code: 'illegal-aliases',
    message: `Invalid aliases in '${fieldName}': entries must be non-empty, unique strings (found ${problems.join(', ')})`,
    field: fieldName,
    value,
    autoFixable,
    meta: {
      problems,
      before: value,
      // Only meaningful when autoFixable; the fixer drops blanks and dedupes.
      after: cleaned,
    },
  };
}

/**
 * Check for frontmatter keys with wrong casing.
 * Only flags if the key doesn't exist in schema but a case-variant does.
 */
function checkFrontmatterKeyCasing(
  fieldName: string,
  value: unknown,
  frontmatter: Record<string, unknown>,
  schemaKeyMap: Map<string, string[]>
): AuditIssue | null {
  if (schemaKeyMap.has(fieldName.toLowerCase()) && schemaKeyMap.get(fieldName.toLowerCase())?.includes(fieldName)) {
    return null;
  }

  const lowerFieldName = fieldName.toLowerCase();
  const candidates = schemaKeyMap.get(lowerFieldName);

  if (!candidates || candidates.length === 0) {
    return null;
  }

  if (candidates.length > 1) {
    return {
      severity: 'warning',
      code: 'frontmatter-key-casing',
      message: `Key '${fieldName}' matches multiple schema keys`,
      field: fieldName,
      value: value,
      autoFixable: false,
      meta: {
        fromKey: fieldName,
        candidates: [...candidates],
      },
    };
  }

  const canonicalKey = candidates[0]!;

  // Only flag if:
  // 1. Current key doesn't match schema exactly
  // 2. But a case-insensitive match exists
  if (canonicalKey && canonicalKey !== fieldName) {
    // Check if canonical key already exists in frontmatter
    const existingValue = frontmatter[canonicalKey];
    const hasConflict =
      canonicalKey in frontmatter &&
      !isEffectivelyEmpty(existingValue) &&
      !isEffectivelyEmpty(value);
    return {
      severity: 'warning',
      code: 'frontmatter-key-casing',
      message: hasConflict
        ? `Key '${fieldName}' should be '${canonicalKey}' (both exist, needs merge)`
        : `Key '${fieldName}' should be '${canonicalKey}'`,
      field: fieldName,
      value: value,
      canonicalKey: canonicalKey,
      autoFixable: !hasConflict,
      hasConflict: hasConflict,
      ...(hasConflict && { conflictValue: existingValue }),
      meta: {
        fromKey: fieldName,
        toKey: canonicalKey,
        ...(hasConflict
          ? { conflictValue: existingValue }
          : { before: fieldName, after: canonicalKey }),
      },
    };
  }
  
  return null;
}

/**
 * Check for singular/plural key mismatches.
 * E.g., 'tag' when schema has 'tags', or 'categories' when schema has 'category'.
 */
function checkSingularPluralMismatch(
  fieldName: string,
  value: unknown,
  frontmatter: Record<string, unknown>,
  schemaFieldNames: Set<string>
): AuditIssue | null {
  // Skip if field already exists in schema
  if (schemaFieldNames.has(fieldName)) return null;
  
  // Check singular → plural (add 's')
  const pluralForm = fieldName + 's';
  if (schemaFieldNames.has(pluralForm)) {
    const existingValue = frontmatter[pluralForm];
    const hasConflict =
      pluralForm in frontmatter &&
      !isEffectivelyEmpty(existingValue) &&
      !isEffectivelyEmpty(value);
    return {
      severity: 'warning',
      code: 'singular-plural-mismatch',
      message: hasConflict
        ? `Key '${fieldName}' should be '${pluralForm}' (both exist, needs merge)`
        : `Key '${fieldName}' should be '${pluralForm}'`,
      field: fieldName,
      value: value,
      canonicalKey: pluralForm,
      autoFixable: !hasConflict,
      hasConflict: hasConflict,
      ...(hasConflict && { conflictValue: existingValue }),
    };
  }
  
  // Check plural → singular (remove 's')
  if (fieldName.endsWith('s') && fieldName.length > 1) {
    const singularForm = fieldName.slice(0, -1);
    if (schemaFieldNames.has(singularForm)) {
      const existingValue = frontmatter[singularForm];
      const hasConflict =
        singularForm in frontmatter &&
        !isEffectivelyEmpty(existingValue) &&
        !isEffectivelyEmpty(value);
      return {
        severity: 'warning',
        code: 'singular-plural-mismatch',
        message: hasConflict
          ? `Key '${fieldName}' should be '${singularForm}' (both exist, needs merge)`
          : `Key '${fieldName}' should be '${singularForm}'`,
        field: fieldName,
        value: value,
        canonicalKey: singularForm,
        autoFixable: !hasConflict,
        hasConflict: hasConflict,
        ...(hasConflict && { conflictValue: existingValue }),
      };
    }
  }
  
  return null;
}

// ============================================================================
// Exports
// ============================================================================

// Re-export discovery functions for backward compatibility with existing imports
export { discoverManagedFiles } from '../discovery.js';

export { type ManagedFile, type AuditRunOptions };
