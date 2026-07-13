import { getRootTypeNames, getType } from '../../lib/schema.js';
import { promptSelection } from '../../lib/prompt.js';
import type { LoadedSchema } from '../../types/schema.js';

export async function resolveTypePath(
  schema: LoadedSchema,
  initialPath?: string
): Promise<string | undefined> {
  let typePath = initialPath;

  if (!typePath) {
    const families = getRootTypeNames(schema);
    const selected = await promptSelection('What would you like to create?', families);
    if (!selected) return undefined;
    typePath = selected;
  }

  let typeDef = getType(schema, typePath);
  let currentTypeName = typePath;

  while (typeDef && typeDef.children.length > 0) {
    const subtypes = typeDef.children;
    const discLabel = 'type';
    const selected = await promptSelection(
      `Select ${currentTypeName} subtype (${discLabel}):`,
      subtypes
    );
    if (!selected) return undefined;

    currentTypeName = selected;
    typeDef = getType(schema, currentTypeName);
  }

  return currentTypeName;
}
