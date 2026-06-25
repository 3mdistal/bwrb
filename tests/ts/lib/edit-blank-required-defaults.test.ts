import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';

import { loadSchema } from '../../../src/lib/schema.js';
import { editNoteFromJson } from '../../../src/lib/edit.js';
import { parseNote } from '../../../src/lib/frontmatter.js';
import { runAudit } from '../../../src/lib/audit/detection.js';
import type { Schema } from '../../../src/types/schema.js';

/**
 * Regression coverage for the #707 write↔audit parity break on the `edit` path.
 *
 * The trim-everywhere change made `validateFrontmatter` treat a whitespace-only
 * value for a REQUIRED field that HAS a default as "unset → satisfied by the
 * default" (VALID). That is only correct if the default is actually MATERIALIZED
 * on write. `editNoteFromJson` previously wrote the merged frontmatter WITHOUT
 * `applyDefaults`, so `edit --json '{"status":"   "}'` SUCCEEDED while persisting
 * a blank required value — which `audit` then flagged as `empty-string-required`.
 * Write said OK, audit said broken: parity violated. The fix applies defaults on
 * the edit write path, mirroring `new`.
 */

// `status` is a REQUIRED select WITH a default; `priority` is an OPTIONAL select
// WITH a default; `owner` is a REQUIRED text field with NO default.
const SCHEMA: Schema = {
  version: 2,
  types: {
    task: {
      output_dir: 'tasks',
      fields: {
        name: { prompt: 'text', required: true },
        status: { prompt: 'select', options: ['todo', 'doing', 'done'], required: true, default: 'todo' },
        priority: { prompt: 'select', options: ['low', 'high'], default: 'low' },
      },
    },
    record: {
      output_dir: 'records',
      fields: {
        name: { prompt: 'text', required: true },
        owner: { prompt: 'text', required: true },
      },
    },
  },
};

async function setupVault(): Promise<string> {
  const vaultDir = await mkdtemp(join(tmpdir(), 'edit-blank-required-'));
  await mkdir(join(vaultDir, '.bwrb'), { recursive: true });
  await writeFile(join(vaultDir, '.bwrb', 'schema.json'), JSON.stringify(SCHEMA, null, 2));
  await mkdir(join(vaultDir, 'tasks'), { recursive: true });
  await mkdir(join(vaultDir, 'records'), { recursive: true });
  return vaultDir;
}

async function readFrontmatter(filePath: string): Promise<Record<string, unknown>> {
  const { frontmatter } = await parseNote(filePath);
  return frontmatter;
}

function auditIssues(
  results: Awaited<ReturnType<typeof runAudit>>,
  fileName: string
): string[] {
  const result = results.find((r) => r.relativePath.endsWith(fileName));
  return (result?.issues ?? []).map((i) => i.code);
}

describe('edit --json: blank required-with-default parity (#707)', () => {
  let vaultDir: string;
  beforeEach(async () => {
    vaultDir = await setupVault();
  });
  afterEach(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  it('blanking a required-with-default field persists the default; audit stays clean', async () => {
    const taskPath = join(vaultDir, 'tasks', 'Build.md');
    await writeFile(
      taskPath,
      `---
type: task
name: Build
status: doing
priority: high
---

# Build
`
    );

    const schema = await loadSchema(vaultDir);
    await editNoteFromJson(schema, vaultDir, taskPath, JSON.stringify({ status: '   ' }), {
      jsonMode: false,
    });

    // The default was MATERIALIZED, not a blank value left on disk.
    const fm = await readFrontmatter(taskPath);
    expect(fm['status']).toBe('todo');
    // Untouched real value is preserved (applyDefaults only fills blanks).
    expect(fm['priority']).toBe('high');

    // Parity: audit finds no empty-string-required for the blanked field.
    const results = await runAudit(schema, vaultDir, { strict: false, vaultDir, schema });
    expect(auditIssues(results, 'Build.md')).not.toContain('empty-string-required');
  });

  it('blanking a required field WITHOUT a default is rejected at write', async () => {
    const recordPath = join(vaultDir, 'records', 'Doc.md');
    await writeFile(
      recordPath,
      `---
type: record
name: Doc
owner: Alice
---

# Doc
`
    );

    const schema = await loadSchema(vaultDir);
    await expect(
      editNoteFromJson(schema, vaultDir, recordPath, JSON.stringify({ owner: '   ' }), {
        jsonMode: false,
      })
    ).rejects.toThrow(/owner/);

    // Nothing persisted: the original value is untouched.
    const fm = await readFrontmatter(recordPath);
    expect(fm['owner']).toBe('Alice');
  });

  it('explicit null removal of a defaulted field stays removed (default NOT re-applied)', async () => {
    // Regression: a blanket applyDefaults over the merged frontmatter would write
    // `status`'s default back in immediately after `mergeFrontmatter` deleted it,
    // silently undoing the documented `{"field": null}` removal. The surgical fix
    // scopes defaults to blank-STRING patch keys only, so null is left removed.
    const taskPath = join(vaultDir, 'tasks', 'Drop.md');
    await writeFile(
      taskPath,
      `---
type: task
name: Drop
status: doing
priority: high
---

# Drop
`
    );

    const schema = await loadSchema(vaultDir);
    await editNoteFromJson(schema, vaultDir, taskPath, JSON.stringify({ status: null }), {
      jsonMode: false,
    });

    // The field is GONE, not re-defaulted to 'todo'.
    const fm = await readFrontmatter(taskPath);
    expect('status' in fm).toBe(false);
    // Untouched field is preserved.
    expect(fm['priority']).toBe('high');
  });

  it('editing one field does NOT materialize an unrelated untouched defaulted field', async () => {
    // `priority` is OPTIONAL with a default but is absent from the note and is NOT
    // referenced by the patch. A blanket applyDefaults would fill it in; the
    // surgical, patch-scoped fix must leave it absent.
    const taskPath = join(vaultDir, 'tasks', 'Touch.md');
    await writeFile(
      taskPath,
      `---
type: task
name: Touch
status: doing
---

# Touch
`
    );

    const schema = await loadSchema(vaultDir);
    await editNoteFromJson(schema, vaultDir, taskPath, JSON.stringify({ name: 'Touched' }), {
      jsonMode: false,
    });

    const fm = await readFrontmatter(taskPath);
    expect(fm['name']).toBe('Touched');
    // The user never referenced `priority`; its default must NOT be materialized.
    expect('priority' in fm).toBe(false);
    // The edited field's own value is intact.
    expect(fm['status']).toBe('doing');
  });

  it('control: blanking an OPTIONAL field with no default clears it to unset on both write and audit', async () => {
    // `priority` HAS a default, so blanking it would be filled. Use an optional
    // field WITHOUT a default to confirm trim-everywhere "unset" is preserved.
    const optionalSchema: Schema = {
      version: 2,
      types: {
        task: {
          output_dir: 'tasks',
          fields: {
            name: { prompt: 'text', required: true },
            note: { prompt: 'text' },
          },
        },
      },
    };
    const v = await mkdtemp(join(tmpdir(), 'edit-optional-'));
    await mkdir(join(v, '.bwrb'), { recursive: true });
    await writeFile(join(v, '.bwrb', 'schema.json'), JSON.stringify(optionalSchema, null, 2));
    await mkdir(join(v, 'tasks'), { recursive: true });

    const taskPath = join(v, 'tasks', 'Opt.md');
    await writeFile(
      taskPath,
      `---
type: task
name: Opt
note: something
---

# Opt
`
    );

    const schema = await loadSchema(v);
    await editNoteFromJson(schema, v, taskPath, JSON.stringify({ note: '   ' }), {
      jsonMode: false,
    });

    // Blank optional value is treated as unset; no default is forced in.
    const fm = await readFrontmatter(taskPath);
    expect(fm['note'] === undefined || String(fm['note']).trim() === '').toBe(true);

    // Audit treats the blank optional as unset → no empty/required complaint.
    const results = await runAudit(schema, v, { strict: false, vaultDir: v, schema });
    const codes = auditIssues(results, 'Opt.md');
    expect(codes).not.toContain('empty-string-required');

    await rm(v, { recursive: true, force: true });
  });
});
