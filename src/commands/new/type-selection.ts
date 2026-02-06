import {
  getTypeFamilies,
  getTypeDefByPath,
  hasSubtypes,
  getSubtypeKeys,
  discriminatorName,
} from '../../lib/schema.js';
import { promptSelection } from '../../lib/prompt.js';
import type { LoadedSchema } from '../../types/schema.js';

export async function resolveTypePath(
  schema: LoadedSchema,
  initialPath?: string
): Promise<string | undefined> {
  let typePath = initialPath;

  if (!typePath) {
    const families = getTypeFamilies(schema);
    const selected = await promptSelection('What would you like to create?', families);
    if (!selected) return undefined;
    typePath = selected;
  }

  let typeDef = getTypeDefByPath(schema, typePath);
  let currentTypeName = typePath;

  while (typeDef && hasSubtypes(typeDef)) {
    const subtypes = getSubtypeKeys(typeDef);
    const discLabel = discriminatorName(currentTypeName);
    const selected = await promptSelection(
      `Select ${currentTypeName} subtype (${discLabel}):`,
      subtypes
    );
    if (!selected) return undefined;

    currentTypeName = selected;
    typeDef = getTypeDefByPath(schema, currentTypeName);
  }

  return currentTypeName;
}
