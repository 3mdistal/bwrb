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
import { ensureOwnedOutputDir, formatValue } from '../../lib/vault.js';
import { getTypeDefByPath } from '../../lib/schema.js';
import { ExitCodes, jsonError } from '../../lib/output.js';
import { printWarning } from '../../lib/prompt.js';
import type { NoteCreationResult, WritePlanArgs, FileExistsStrategy, OwnershipMode, CreationMode } from './types.js';
import { buildNotePath } from './paths.js';
import { throwJsonError } from './errors.js';
import { handleInstanceScaffolding } from './scaffolding.js';
import type { LoadedSchema } from '../../types/schema.js';

const PORTABLE_PATH_WARNING_LENGTH = 200;
const PORTABLE_PATH_MAX_LENGTH = 260;

function getOutputDirForType(schema: LoadedSchema, typePath: string): string | undefined {
  const typeDef = getTypeDefByPath(schema, typePath);
  return typeDef?.outputDir;
}

async function resolveOutputDir(
  schema: LoadedSchema,
  vaultDir: string,
  typePath: string,
  ownership: OwnershipMode,
  mode: CreationMode
): Promise<string> {
  if (ownership.kind === 'owned') {
    return ensureOwnedOutputDir(ownership.owner.ownerPath, ownership.fieldName);
  }

  const outputDir = getOutputDirForType(schema, typePath);
  if (!outputDir) {
    if (mode === 'json') {
      throwJsonError(jsonError(`No output_dir defined for type: ${typePath}`), ExitCodes.SCHEMA_ERROR);
    }
    throw new Error(`No output_dir defined for type: ${typePath}`);
  }

  return join(vaultDir, outputDir);
}

export async function writeNotePlan(
  args: WritePlanArgs,
  fileExistsStrategy: FileExistsStrategy,
  skipInstances: boolean
): Promise<NoteCreationResult> {
  const outputDir = await resolveOutputDir(args.schema, args.vaultDir, args.typePath, args.ownership, args.mode);
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

  const noteId = await generateUniqueNoteId(args.vaultDir);
  args.content.frontmatter.id = noteId;
  if (args.ownership.kind === 'owned') {
    args.content.frontmatter.owner = formatValue(args.ownership.owner.ownerName, args.schema.config.linkFormat);
  }
  const orderedFields = ensureIdInFieldOrder(args.content.orderedFields);

  await writeNote(filePath, args.content.frontmatter, args.content.body, orderedFields);
  await registerIssuedNoteId(args.vaultDir, noteId, filePath);

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
