import {
  generateBodyWithContent,
  generateBodySections,
  mergeBodySectionContent,
  parseBodyInput,
} from '../../lib/frontmatter.js';
import {
  getFrontmatterOrder,
  getTypeDefByPath,
} from '../../lib/schema.js';
import {
  applyDefaults,
  validateContextFields,
  validateFrontmatter,
} from '../../lib/validation.js';
import {
  getFilenamePattern,
  processTemplateBody,
  resolveFilenamePattern,
  validateConstraints,
} from '../../lib/template.js';
import { evaluateTemplateDefault } from '../../lib/date-expression.js';
import { validateParentNoCycle } from '../../lib/hierarchy.js';
import { ExitCodes, jsonError } from '../../lib/output.js';
import { relative } from 'path';
import type { LoadedSchema, ResolvedType, Template } from '../../types/schema.js';
import type { JsonNoteInputResult, NoteCreationResult, PlannedNoteContent } from './types.js';
import { throwJsonError } from './errors.js';
import { resolveJsonOwnership } from './ownership.js';
import { writeNotePlan } from './write-plan.js';

export async function createNoteFromJson(
  schema: LoadedSchema,
  vaultDir: string,
  typePath: string,
  jsonInput: string,
  template?: Template | null,
  ownershipOptions?: { owner?: string | undefined; standalone?: boolean | undefined; noInstances?: boolean | undefined }
): Promise<NoteCreationResult> {
  const typeDef = getTypeDefByPath(schema, typePath);
  if (!typeDef) {
    throwJsonError(jsonError(`Unknown type: ${typePath}`), ExitCodes.VALIDATION_ERROR);
  }

  const ownership = await resolveJsonOwnership(schema, vaultDir, typePath, typeDef, ownershipOptions);
  const resolvedTemplate = template ?? null;
  const content = await buildJsonNoteContent(schema, vaultDir, typePath, typeDef, jsonInput, resolvedTemplate);

  return writeNotePlan(
    {
      schema,
      vaultDir,
      typePath,
      typeDef,
      ownership,
      mode: 'json',
      content,
      template: resolvedTemplate,
    },
    {
      onExists: (filePath, baseDir) => {
        throwJsonError(jsonError(`File already exists: ${relative(baseDir, filePath)}`), ExitCodes.IO_ERROR);
      },
    },
    ownershipOptions?.noInstances ?? false
  );
}

async function buildJsonNoteContent(
  schema: LoadedSchema,
  vaultDir: string,
  typePath: string,
  typeDef: ResolvedType,
  jsonInput: string,
  template?: Template | null
): Promise<PlannedNoteContent> {
  const { frontmatter, bodyInput } = parseJsonNoteInput(jsonInput);
  const mergedInput = mergeJsonTemplateDefaults(schema, frontmatter, template);
  await validateJsonFrontmatter(schema, vaultDir, typePath, typeDef, mergedInput, template);
  const resolvedFrontmatter = applyDefaults(schema, typePath, mergedInput);

  const itemName = resolveJsonItemName(schema, typeDef, resolvedFrontmatter, template);
  const body = generateBodyForJson(typeDef, resolvedFrontmatter, template, bodyInput, schema.config.dateFormat);
  const orderedFields = resolveOrderedFields(typeDef, resolvedFrontmatter);

  return {
    frontmatter: resolvedFrontmatter,
    body,
    orderedFields,
    itemName,
  };
}

function parseJsonNoteInput(jsonInput: string): JsonNoteInputResult {
  let inputData: Record<string, unknown>;
  try {
    inputData = JSON.parse(jsonInput) as Record<string, unknown>;
  } catch (e) {
    const error = `Invalid JSON: ${(e as Error).message}`;
    throwJsonError(jsonError(error), ExitCodes.VALIDATION_ERROR);
  }

  const { _body: rawBodyInput, ...frontmatterInput } = inputData;
  if ('id' in frontmatterInput) {
    throwJsonError(
      jsonError("Frontmatter field 'id' is reserved and cannot be set in --json mode"),
      ExitCodes.VALIDATION_ERROR
    );
  }

  let bodyInput: Record<string, unknown> | undefined;
  if (rawBodyInput !== undefined && rawBodyInput !== null) {
    if (typeof rawBodyInput !== 'object' || Array.isArray(rawBodyInput)) {
      throwJsonError(jsonError('_body must be an object with section names as keys'), ExitCodes.VALIDATION_ERROR);
    }
    bodyInput = rawBodyInput as Record<string, unknown>;
  }

  if (bodyInput === undefined) {
    return { frontmatter: frontmatterInput };
  }

  return { frontmatter: frontmatterInput, bodyInput };
}

function mergeJsonTemplateDefaults(
  schema: LoadedSchema,
  frontmatterInput: Record<string, unknown>,
  template?: Template | null
): Record<string, unknown> {
  if (!template?.defaults) {
    return { ...frontmatterInput };
  }

  const evaluatedDefaults: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(template.defaults)) {
    evaluatedDefaults[key] = evaluateTemplateDefault(value, schema.config.dateFormat);
  }

  return { ...evaluatedDefaults, ...frontmatterInput };
}

async function validateJsonFrontmatter(
  schema: LoadedSchema,
  vaultDir: string,
  typePath: string,
  typeDef: ResolvedType,
  mergedInput: Record<string, unknown>,
  template?: Template | null
): Promise<void> {
  const validation = validateFrontmatter(schema, typePath, mergedInput);
  if (!validation.valid) {
    throwJsonError({
      success: false,
      error: 'Validation failed',
      errors: validation.errors.map(e => ({
        field: e.field,
        message: e.message,
        ...(e.value !== undefined && { value: e.value }),
        ...(e.expected !== undefined && { expected: e.expected }),
        ...(e.suggestion !== undefined && { suggestion: e.suggestion }),
      })),
    }, ExitCodes.VALIDATION_ERROR);
  }

  const contextValidation = await validateContextFields(schema, vaultDir, typePath, mergedInput);
  if (!contextValidation.valid) {
    throwJsonError({
      success: false,
      error: 'Context field validation failed',
      errors: contextValidation.errors.map(e => ({
        type: e.type,
        field: e.field,
        message: e.message,
        ...(e.value !== undefined && { value: e.value }),
        ...(e.expected !== undefined && { expected: e.expected }),
      })),
    }, ExitCodes.VALIDATION_ERROR);
  }

  if (template?.constraints) {
    const constraintResult = validateConstraints(mergedInput, template.constraints);
    if (!constraintResult.valid) {
      throwJsonError({
        success: false,
        error: 'Template constraint validation failed',
        errors: constraintResult.errors.map(e => ({
          field: e.field,
          message: e.message,
          constraint: e.constraint,
        })),
      }, ExitCodes.VALIDATION_ERROR);
    }
  }

  if (typeDef.recursive && mergedInput.parent) {
    const cycleError = await validateParentNoCycle(
      schema,
      vaultDir,
      mergedInput.name as string,
      mergedInput.parent as string
    );
    if (cycleError) {
      throwJsonError({
        success: false,
        error: cycleError.message,
        errors: [{
          field: cycleError.field,
          message: cycleError.message,
        }],
      }, ExitCodes.VALIDATION_ERROR);
    }
  }
}

function resolveJsonItemName(
  schema: LoadedSchema,
  typeDef: ResolvedType,
  frontmatter: Record<string, unknown>,
  template?: Template | null
): string {
  const filenamePattern = getFilenamePattern(template ?? null, typeDef);

  if (filenamePattern) {
    const patternResult = resolveFilenamePattern(filenamePattern, frontmatter, schema.config.dateFormat);

    if (patternResult.resolved && patternResult.filename) {
      return patternResult.filename;
    }

    const nameField = frontmatter.name;
    if (!nameField || typeof nameField !== 'string') {
      const missingInfo = patternResult.missingFields.length > 0
        ? ` Pattern references missing fields: ${patternResult.missingFields.join(', ')}.`
        : '';
      throwJsonError(
        jsonError(`Filename pattern could not be resolved.${missingInfo} Provide a 'name' field as fallback.`),
        ExitCodes.VALIDATION_ERROR
      );
    }
    return nameField;
  }

  const nameField = frontmatter.name;
  if (!nameField || typeof nameField !== 'string') {
    throwJsonError(jsonError("Missing or invalid 'name' field"), ExitCodes.VALIDATION_ERROR);
  }

  return nameField;
}

function resolveOrderedFields(typeDef: ResolvedType, frontmatter: Record<string, unknown>): string[] {
  const fieldOrder = getFrontmatterOrder(typeDef);
  return fieldOrder.length > 0 ? fieldOrder : Object.keys(frontmatter);
}

function generateBodyForJson(
  typeDef: ResolvedType,
  frontmatter: Record<string, unknown>,
  template?: Template | null,
  bodyInput?: Record<string, unknown>,
  dateFormat?: string
): string {
  const sections = typeDef.bodySections ?? [];

  let sectionContent: Map<string, string[]> | undefined;
  if (bodyInput && Object.keys(bodyInput).length > 0) {
    sectionContent = parseBodyInput(bodyInput, sections);
  }

  if (template?.body && sectionContent && sectionContent.size > 0) {
    let body = processTemplateBody(template.body, frontmatter, dateFormat);
    body = mergeBodySectionContent(body, sections, sectionContent);
    return body;
  }
  if (template?.body) {
    return processTemplateBody(template.body, frontmatter, dateFormat);
  }
  if (sectionContent && sectionContent.size > 0) {
    return generateBodyWithContent(sections, sectionContent);
  }
  if (sections.length === 0) {
    return '';
  }
  return generateBodySections(sections);
}
