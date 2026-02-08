import { existsSync } from 'fs';
import { join } from 'path';
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
import type { NoteCreationResult, WritePlanArgs, FileExistsStrategy, OwnershipMode, CreationMode } from './types.js';
import { buildNotePath } from './paths.js';
import { throwJsonError } from './errors.js';
import { handleInstanceScaffolding } from './scaffolding.js';
import type { LoadedSchema } from '../../types/schema.js';

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
  const filePath = buildNotePath(outputDir, args.content.itemName, args.mode);

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
