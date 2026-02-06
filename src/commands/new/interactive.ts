import { relative } from 'path';
import {
  generateBodyWithContent,
  mergeBodySectionContent,
} from '../../lib/frontmatter.js';
import {
  getFieldsForType,
  getFrontmatterOrder,
} from '../../lib/schema.js';
import {
  getFilenamePattern,
  processTemplateBody,
  resolveFilenamePattern,
  type InheritedTemplateResolution,
  validateConstraints,
} from '../../lib/template.js';
import {
  printError,
  printInfo,
  printSuccess,
  printWarning,
  promptConfirm,
  promptRequired,
} from '../../lib/prompt.js';
import { UserCancelledError } from '../../lib/errors.js';
import type { LoadedSchema, ResolvedType } from '../../types/schema.js';
import type { PlannedNoteContent } from './types.js';
import { promptBodySections, promptField } from './prompting.js';
import { resolveInteractiveOwnership } from './ownership.js';
import { writeNotePlan } from './write-plan.js';

export async function createNoteInteractive(
  schema: LoadedSchema,
  vaultDir: string,
  typePath: string,
  typeDef: ResolvedType,
  templateResolution: InheritedTemplateResolution,
  options?: { owner?: string | undefined; standalone?: boolean | undefined; noInstances?: boolean | undefined }
): Promise<string> {
  const segments = typePath.split('/');
  const displayTypeName = segments[0] ?? typePath;
  const typeName = typeDef.name;

  printInfo(`\n=== New ${displayTypeName} ===`);

  const template = templateResolution.template;
  if (template) {
    const inheritedSuffix = template.inheritedFrom
      ? ` (inherited from ${template.inheritedFrom})`
      : '';
    printInfo(`Using template: ${template.name}${template.description ? ` - ${template.description}` : ''}${inheritedSuffix}`);
  }

  const ownership = await resolveInteractiveOwnership(schema, vaultDir, typeName, options?.owner, options?.standalone);
  if (ownership.kind === 'owned') {
    printInfo(`Creating ${typeName} owned by ${ownership.owner.ownerName}`);
  }

  const content = await buildInteractiveNoteContent(schema, vaultDir, typePath, typeDef, templateResolution);
  const result = await writeNotePlan(
    {
      schema,
      vaultDir,
      typePath,
      typeDef,
      ownership,
      mode: 'interactive',
      content,
      template,
    },
    {
      onExists: async (filePath: string) => {
        printWarning(`\nWarning: File already exists: ${filePath}`);
        const overwrite = await promptConfirm('Overwrite?');
        if (overwrite === null) {
          throw new UserCancelledError();
        }
        if (overwrite === false) {
          throw new Error('Aborted.');
        }
      },
    },
    options?.noInstances ?? false
  );

  if (ownership.kind === 'owned') {
    printSuccess(`\n✓ Created: ${relative(vaultDir, result.path)}`);
    printInfo(`  Owned by: ${ownership.owner.ownerName}`);
  } else {
    printSuccess(`\n✓ Created: ${result.path}`);
  }

  return result.path;
}

export async function buildNoteContent(
  schema: LoadedSchema,
  vaultDir: string,
  typePath: string,
  typeDef: ResolvedType,
  templateResolution: InheritedTemplateResolution
): Promise<{ frontmatter: Record<string, unknown>; body: string; orderedFields: string[] }> {
  const frontmatter: Record<string, unknown> = {};
  const fields = getFieldsForType(schema, typePath);
  const fieldOrder = getFrontmatterOrder(typeDef);
  const orderedFields = fieldOrder.length > 0 ? fieldOrder : Object.keys(fields);

  frontmatter.type = typeDef.name;

  const template = templateResolution.template;
  const mergedDefaults = templateResolution.mergedDefaults;
  const promptFields = new Set(templateResolution.mergedPromptFields);

  for (const fieldName of orderedFields) {
    const field = fields[fieldName];
    if (!field) continue;

    const mergedDefault = mergedDefaults[fieldName];
    const hasDefault = mergedDefault !== undefined;
    const shouldPrompt = !hasDefault || promptFields.has(fieldName);

    if (hasDefault && !shouldPrompt) {
      frontmatter[fieldName] = mergedDefault;
    } else {
      const value = await promptField(schema, vaultDir, fieldName, field);
      if (value !== undefined && value !== '') {
        frontmatter[fieldName] = value;
      }
    }
  }

  const mergedConstraints = templateResolution.mergedConstraints;
  if (Object.keys(mergedConstraints).length > 0) {
    const constraintResult = validateConstraints(frontmatter, mergedConstraints);
    if (!constraintResult.valid) {
      printError('\nTemplate constraint validation failed:');
      for (const error of constraintResult.errors) {
        printError(`  - ${error.field}: ${error.message}`);
      }
      throw new Error('Template constraints not satisfied');
    }
  }

  let body = '';
  const bodySections = typeDef.bodySections;
  const promptableSections = bodySections?.filter(s => s.prompt === 'list') ?? [];

  if (template?.body) {
    body = processTemplateBody(template.body, frontmatter, schema.config.dateFormat);

    if (promptableSections.length > 0) {
      const sectionContent = await promptBodySections(promptableSections, body);
      if (sectionContent.size > 0) {
        body = mergeBodySectionContent(body, promptableSections, sectionContent);
      }
    }
  } else if (bodySections && bodySections.length > 0) {
    const sectionContent = await promptBodySections(promptableSections, undefined);
    body = generateBodyWithContent(bodySections, sectionContent);
  }

  return { frontmatter, body, orderedFields };
}

export async function buildInteractiveNoteContent(
  schema: LoadedSchema,
  vaultDir: string,
  typePath: string,
  typeDef: ResolvedType,
  templateResolution: InheritedTemplateResolution
): Promise<PlannedNoteContent> {
  const template = templateResolution.template;
  const filenamePattern = getFilenamePattern(template ?? null, typeDef);

  if (filenamePattern) {
    const content = await buildNoteContent(schema, vaultDir, typePath, typeDef, templateResolution);
    const patternResult = resolveFilenamePattern(filenamePattern, content.frontmatter, schema.config.dateFormat);

    if (patternResult.resolved && patternResult.filename) {
      return {
        ...content,
        itemName: patternResult.filename,
      };
    }

    if (patternResult.missingFields.length > 0) {
      printWarning(`Filename pattern references missing fields: ${patternResult.missingFields.join(', ')}`);
    }

    const prompted = await promptRequired('Name');
    if (prompted === null) {
      throw new UserCancelledError();
    }

    return {
      ...content,
      itemName: prompted,
    };
  }

  const prompted = await promptRequired('Name');
  if (prompted === null) {
    throw new UserCancelledError();
  }

  const content = await buildNoteContent(schema, vaultDir, typePath, typeDef, templateResolution);
  return {
    ...content,
    itemName: prompted,
  };
}
