import { existsSync } from 'fs';
import { join, relative } from 'path';
import {
  writeNote,
} from '../../lib/frontmatter.js';
import {
  ensureIdInFieldOrder,
  generateUniqueNoteId,
  registerIssuedNoteId,
} from '../../lib/note-id.js';
import { cleanRelationLink, ensureOwnedOutputDir } from '../../lib/vault.js';
import { getOutputDir } from '../../lib/schema.js';
import { normalizeDateFields } from '../../lib/validation.js';
import { ExitCodes, jsonError } from '../../lib/output.js';
import { printWarning } from '../../lib/prompt.js';
import type { NoteCreationResult, WritePlanArgs, FileExistsStrategy, OwnershipMode } from './types.js';
import { buildNotePath } from './paths.js';
import { throwJsonError } from './errors.js';
import { handleInstanceScaffolding } from './scaffolding.js';
import type { LoadedSchema } from '../../types/schema.js';

const PORTABLE_PATH_WARNING_LENGTH = 200;
const PORTABLE_PATH_MAX_LENGTH = 260;

async function resolveOutputDir(
  schema: LoadedSchema,
  vaultDir: string,
  typeName: string,
  ownership: OwnershipMode
): Promise<string> {
  if (ownership.kind === 'owned') {
    return ensureOwnedOutputDir(ownership.owner.ownerPath, ownership.fieldName);
  }

  return join(vaultDir, getOutputDir(schema, typeName));
}

export async function writeNotePlan(
  args: WritePlanArgs,
  fileExistsStrategy: FileExistsStrategy,
  skipInstances: boolean
): Promise<NoteCreationResult> {
  const outputDir = await resolveOutputDir(args.schema, args.vaultDir, args.typeDef.name, args.ownership);
  const pathResult = buildNotePath(outputDir, args.content.itemName, args.mode, args.content.nameTransformed);
  const filePath = pathResult.path;
  const relativePath = relative(args.vaultDir, filePath);
  const pathLengthWarning = getPathLengthWarning(relativePath);

  if (relativePath.length > PORTABLE_PATH_MAX_LENGTH) {
    const message = `Note path is ${relativePath.length} characters, exceeding the portable limit of ${PORTABLE_PATH_MAX_LENGTH}: ${relativePath}`;
    if (args.mode === 'json') {
      throwJsonError(jsonError(message), ExitCodes.VALIDATION_ERROR);
    }
    throw new Error(message);
  }

  if (args.mode !== 'json') {
    if (pathResult.nameTransformed) {
      printWarning(
        `Warning: Note name was changed for the filename: "${pathResult.nameTransformed.original}" -> "${pathResult.nameTransformed.filename}"`
      );
    }
    if (pathLengthWarning) {
      printWarning(
        `Warning: Note path is ${pathLengthWarning.length} characters; paths over ${pathLengthWarning.threshold} may be less portable: ${pathLengthWarning.path}`
      );
    }
  }

  if (existsSync(filePath)) {
    await fileExistsStrategy.onExists(filePath, args.vaultDir);
  }

  // Normalize date fields to canonical YYYY-MM-DD before writing, using the
  // same logic as the audit/validation and edit layers. This keeps freshly
  // created notes passing `bwrb audit` regardless of the accepted input format
  // (e.g. unambiguous MM/DD/YYYY) while preserving valid partial dates per the
  // field's granularity. Applies to all create paths (json/interactive),
  // covering user-supplied values, schema/template defaults, and interpolated
  // date expressions (today(), @today, {date}).
  args.content.frontmatter = normalizeDateFields(
    args.schema,
    args.typePath,
    args.content.frontmatter
  );

  const noteId = await generateUniqueNoteId(args.vaultDir, args.schema);
  args.content.frontmatter.id = noteId;
  if (args.ownership.kind === 'owned') {
    args.content.frontmatter.owner = cleanRelationLink(args.ownership.owner.ownerName, args.schema.config.linkFormat);
  }
  const orderedFields = ensureIdInFieldOrder(args.content.orderedFields);

  await writeNote(filePath, args.content.frontmatter, args.content.body, orderedFields);
  await registerIssuedNoteId(
    args.vaultDir,
    noteId,
    filePath,
    args.schema.config.identityStore
  );

  let scaffoldResult = null;
  if (args.template) {
    scaffoldResult = await handleInstanceScaffolding(
      args.schema,
      args.vaultDir,
      filePath,
      args.typeDef.name,
      args.template,
      args.content.frontmatter,
      skipInstances,
      args.mode === 'json'
    );
  }

  const result: NoteCreationResult = { path: filePath };
  if (pathResult.nameTransformed) {
    result.nameTransformed = pathResult.nameTransformed;
  }
  if (pathLengthWarning) {
    result.pathLengthWarning = pathLengthWarning;
  }
  if (args.mode === 'json' && scaffoldResult) {
    result.instances = {
      created: scaffoldResult.created,
      skipped: scaffoldResult.skipped,
      errors: scaffoldResult.errors.map(e => ({
        type: e.subtype,
        filename: e.filename,
        message: e.message,
      })),
    };
  }

  return result;
}

function getPathLengthWarning(relativePath: string): NoteCreationResult['pathLengthWarning'] | undefined {
  if (relativePath.length <= PORTABLE_PATH_WARNING_LENGTH) {
    return undefined;
  }

  return {
    path: relativePath,
    length: relativePath.length,
    threshold: PORTABLE_PATH_WARNING_LENGTH,
    max: PORTABLE_PATH_MAX_LENGTH,
  };
}
