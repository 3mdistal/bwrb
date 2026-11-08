import { dirname } from 'path';
import { createScaffoldedInstances, type ScaffoldResult } from '../../lib/template.js';
import { printError, printInfo, printSuccess, printWarning } from '../../lib/prompt.js';
import type { LoadedSchema, Template } from '../../types/schema.js';
import { vaultRelativePath } from '../../lib/vault-relative-path.js';

export async function handleInstanceScaffolding(
  schema: LoadedSchema,
  vaultDir: string,
  parentFilePath: string,
  parentTypeName: string,
  template: Template,
  frontmatter: Record<string, unknown>,
  skipInstances: boolean,
  isJsonMode: boolean
): Promise<ScaffoldResult | null> {
  if (skipInstances) {
    return null;
  }

  if (!template.instances || template.instances.length === 0) {
    return null;
  }

  const instanceDir = dirname(parentFilePath);

  const result = await createScaffoldedInstances(
    schema,
    vaultDir,
    parentTypeName,
    instanceDir,
    template.instances,
    frontmatter
  );

  if (!isJsonMode && (result.created.length > 0 || result.skipped.length > 0 || result.errors.length > 0)) {
    printInstanceScaffoldOutput(vaultDir, result);
  }

  return result;
}

function printInstanceScaffoldOutput(vaultDir: string, result: ScaffoldResult): void {
  if (result.created.length > 0) {
    printInfo('\nInstances created:');
    for (const path of result.created) {
      printSuccess(`  ✓ ${vaultRelativePath(vaultDir, path)}`);
    }
  }

  if (result.skipped.length > 0) {
    printInfo('\nInstances skipped (already exist):');
    for (const path of result.skipped) {
      printWarning(`  - ${vaultRelativePath(vaultDir, path)}`);
    }
  }

  if (result.errors.length > 0) {
    printError('\nInstance errors:');
    for (const err of result.errors) {
      printError(`  ✗ ${err.subtype}${err.filename ? ` (${err.filename})` : ''}: ${err.message}`);
    }
  }

  if (result.created.length > 0) {
    printInfo(`\n✓ Created ${result.created.length + 1} files (1 parent + ${result.created.length} instances)`);
  }
}
