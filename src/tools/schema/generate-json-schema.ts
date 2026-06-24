import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildJsonSchema,
  DOCS_SCHEMA_ID,
  ROOT_SCHEMA_ID,
  serializeJsonSchema,
} from '../../lib/schema-json-schema.js';

/**
 * Generates the published JSON Schema files FROM the Zod source of truth
 * (`src/types/schema.ts`). See `src/lib/schema-json-schema.ts` for the rationale.
 *
 *   pnpm schema:gen     # write the files
 *   pnpm schema:check   # fail if a committed file is stale (CI guard)
 *
 * Two files are produced from the same Zod schema, differing only by `$id`:
 *   - schema.schema.json              (shipped in the npm package; local-reference)
 *   - docs-site/public/schema.json    (served at https://bwrb.dev/schema.json, the
 *                                       `$schema` URL `bwrb init` writes)
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');

interface Target {
  path: string;
  content: string;
}

function targets(): Target[] {
  return [
    {
      path: resolve(repoRoot, 'schema.schema.json'),
      content: serializeJsonSchema(buildJsonSchema(ROOT_SCHEMA_ID)),
    },
    {
      path: resolve(repoRoot, 'docs-site/public/schema.json'),
      content: serializeJsonSchema(buildJsonSchema(DOCS_SCHEMA_ID)),
    },
  ];
}

async function write(): Promise<void> {
  for (const target of targets()) {
    await writeFile(target.path, target.content, 'utf-8');
    console.log(`wrote ${target.path}`);
  }
}

async function check(): Promise<void> {
  const stale: string[] = [];
  for (const target of targets()) {
    let existing: string | null = null;
    try {
      existing = await readFile(target.path, 'utf-8');
    } catch {
      existing = null;
    }
    if (existing !== target.content) {
      stale.push(target.path);
    }
  }

  if (stale.length > 0) {
    console.error(
      'The published JSON Schema is out of date with the Zod source ' +
        '(src/types/schema.ts). Run `pnpm schema:gen` and commit the result.\n' +
        'Stale files:\n' +
        stale.map((p) => `  - ${p}`).join('\n')
    );
    process.exit(1);
  }

  console.log('JSON Schema is up to date with the Zod source.');
}

const mode = process.argv[2] ?? 'write';
const run = mode === '--check' || mode === 'check' ? check : write;
run().catch((err) => {
  console.error(err);
  process.exit(1);
});
