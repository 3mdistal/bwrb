import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';

import { loadSchema } from '../../../src/lib/schema.js';
import { editNoteFromJson } from '../../../src/lib/edit.js';
import { validateFrontmatter } from '../../../src/lib/validation.js';
import { parseNote } from '../../../src/lib/frontmatter.js';
import { runAudit } from '../../../src/lib/audit/detection.js';
import type { Schema } from '../../../src/types/schema.js';

/**
 * Regression coverage for the #707 write↔audit parity break on `prompt: 'list'`
 * fields that are NOT `multiple: true`.
 *
 * A prior round restricted the blank-as-unset scalar shortcut (`isBlankScalar`)
 * to exclude only `multiple: true` fields. But a field declared as
 * `prompt: 'list'` WITHOUT `multiple` is ALSO list-shaped. For such a field a
 * whitespace-only scalar like `tags: '   '` made `hasValue` false, so
 * `validateFieldType` never ran and the non-array scalar string was accepted and
 * PERSISTED on write — while `audit` treats `prompt: 'list'` as
 * list-shaped (`expectsList = field.prompt === 'list' || field.multiple === true`
 * in `src/lib/audit/detection.ts`) and flagged the SAME value as
 * `wrong-scalar-type`. Write accepted, audit flagged: parity violated.
 *
 * Ground truth: the blank-as-unset shortcut must apply ONLY to genuinely SCALAR
 * fields. A field is list-shaped when `field.multiple === true` OR
 * `field.prompt === 'list'`. The fix uses that same predicate, so a blank scalar
 * on a `prompt: 'list'` field is rejected at write, matching audit's
 * `wrong-scalar-type` flag. Both reject/flag.
 */

const SCHEMA: Schema = {
  version: 2,
  types: {
    person: {
      output_dir: 'people',
      fields: {
        name: { prompt: 'text', required: true },
        tags: { prompt: 'list', list_format: 'yaml-array' },
        // The alias role: `prompt: 'list'` WITHOUT `multiple` (list-shaped).
        aliases: { prompt: 'list', alias: true, list_format: 'yaml-array' },
      },
    },
  },
};

async function setupVault(): Promise<string> {
  const vaultDir = await mkdtemp(join(tmpdir(), 'edit-blank-list-prompt-'));
  await mkdir(join(vaultDir, '.bwrb'), { recursive: true });
  await writeFile(join(vaultDir, '.bwrb', 'schema.json'), JSON.stringify(SCHEMA, null, 2));
  await mkdir(join(vaultDir, 'people'), { recursive: true });
  return vaultDir;
}

async function readFrontmatter(filePath: string): Promise<Record<string, unknown>> {
  const { frontmatter } = await parseNote(filePath);
  return frontmatter;
}

function auditIssues(
  results: Awaited<ReturnType<typeof runAudit>>,
  fileName: string
): { code: string; field?: string }[] {
  const result = results.find((r) => r.relativePath.endsWith(fileName));
  return (result?.issues ?? []).map((i) => ({ code: i.code, field: i.field }));
}

describe("whitespace scalar on prompt:'list' (alias) field: write↔audit parity (#707)", () => {
  let vaultDir: string;
  beforeEach(async () => {
    vaultDir = await setupVault();
  });
  afterEach(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  it("validateFrontmatter REJECTS a whitespace scalar on a prompt:'list' alias field (matches audit flag)", async () => {
    const schema = await loadSchema(vaultDir);
    const result = validateFrontmatter(schema, 'person', {
      type: 'person',
      name: 'x',
      aliases: '   ',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'aliases')).toBe(true);
  });

  it("validateFrontmatter REJECTS blank and non-blank scalars on a plain prompt:'list' field", async () => {
    const schema = await loadSchema(vaultDir);
    for (const value of ['   ', 'urgent']) {
      const result = validateFrontmatter(schema, 'person', {
        type: 'person',
        name: 'x',
        tags: value,
      });
      expect(result.valid).toBe(false);
      expect(
        result.errors.some((e) => e.field === 'tags' && e.type === 'invalid_type')
      ).toBe(true);
    }
  });

  it("edit --json: blank and non-blank scalars for an optional plain prompt:'list' field are rejected", async () => {
    const personPath = join(vaultDir, 'people', 'Tagged.md');
    await writeFile(
      personPath,
      `---
type: person
name: Tagged
tags:
  - old
---

# Tagged
`
    );

    const schema = await loadSchema(vaultDir);
    for (const value of ['   ', 'urgent']) {
      await expect(
        editNoteFromJson(schema, vaultDir, personPath, JSON.stringify({ tags: value }), {
          jsonMode: false,
        })
      ).rejects.toThrow(/tags/);
    }

    const fm = await readFrontmatter(personPath);
    expect(fm['tags']).toEqual(['old']);
  });

  it("parity: persisted blank and non-blank scalars on a plain prompt:'list' field are flagged wrong-scalar-type by audit", async () => {
    await writeFile(
      join(vaultDir, 'people', 'BlankTags.md'),
      `---\ntype: person\nname: BlankTags\ntags: "   "\n---\n`
    );
    await writeFile(
      join(vaultDir, 'people', 'ScalarTags.md'),
      `---\ntype: person\nname: ScalarTags\ntags: urgent\n---\n`
    );

    const schema = await loadSchema(vaultDir);
    const results = await runAudit(schema, vaultDir, { strict: false, vaultDir, schema });
    const blankIssues = auditIssues(results, 'BlankTags.md');
    const scalarIssues = auditIssues(results, 'ScalarTags.md');

    expect(blankIssues.some((i) => i.code === 'wrong-scalar-type' && i.field === 'tags')).toBe(true);
    expect(scalarIssues.some((i) => i.code === 'wrong-scalar-type' && i.field === 'tags')).toBe(true);
  });

  it('edit --json: a whitespace scalar for an optional alias list field is rejected; nothing persisted', async () => {
    const personPath = join(vaultDir, 'people', 'Steve.md');
    await writeFile(
      personPath,
      `---
type: person
name: Steve
aliases:
  - Stevey
---

# Steve
`
    );

    const schema = await loadSchema(vaultDir);
    // Write must REJECT — audit would flag this same value as wrong-scalar-type.
    await expect(
      editNoteFromJson(schema, vaultDir, personPath, JSON.stringify({ aliases: '   ' }), {
        jsonMode: false,
      })
    ).rejects.toThrow(/aliases/);

    // The original list value is untouched on disk.
    const fm = await readFrontmatter(personPath);
    expect(fm['aliases']).toEqual(['Stevey']);
  });

  it("parity: a persisted blank scalar on a prompt:'list' field is flagged wrong-scalar-type by audit", async () => {
    // Demonstrates the audit side of the parity: a note carrying a blank scalar on
    // a prompt:'list' alias field is flagged wrong-scalar-type. Since write now
    // REJECTS the same value (test above), the "write accepts, audit flags"
    // disparity is gone.
    const personPath = join(vaultDir, 'people', 'Bad.md');
    await writeFile(personPath, `---\ntype: person\nname: Bad\naliases: "   "\n---\n`);

    const schema = await loadSchema(vaultDir);
    const results = await runAudit(schema, vaultDir, { strict: false, vaultDir, schema });
    const issues = auditIssues(results, 'Bad.md');
    expect(issues.some((i) => i.code === 'wrong-scalar-type' && i.field === 'aliases')).toBe(true);

    // And write rejects that exact value — confirming agreement.
    const result = validateFrontmatter(schema, 'person', {
      type: 'person',
      name: 'Bad',
      aliases: '   ',
    });
    expect(result.valid).toBe(false);
  });

  it('control: a proper alias ARRAY value passes write and audit, and persists', async () => {
    const personPath = join(vaultDir, 'people', 'Good.md');
    await writeFile(
      personPath,
      `---
type: person
name: Good
---

# Good
`
    );

    const schema = await loadSchema(vaultDir);
    await editNoteFromJson(
      schema,
      vaultDir,
      personPath,
      JSON.stringify({ aliases: ['Stevey', 'Steve Yegge'] }),
      { jsonMode: false }
    );

    const fm = await readFrontmatter(personPath);
    expect(fm['aliases']).toEqual(['Stevey', 'Steve Yegge']);

    const results = await runAudit(schema, vaultDir, { strict: false, vaultDir, schema });
    const issues = auditIssues(results, 'Good.md');
    expect(issues.some((i) => i.code === 'wrong-scalar-type')).toBe(false);
  });

  it('control: blank scalar on a genuinely SCALAR field is still treated as unset (#707 preserved)', async () => {
    // The PR's main change — trim-everywhere blank-as-unset for SCALAR fields —
    // must be preserved. `note` here is an optional non-list text field.
    const scalarSchema: Schema = {
      version: 2,
      types: {
        person: {
          output_dir: 'people',
          fields: {
            name: { prompt: 'text', required: true },
            note: { prompt: 'text' },
          },
        },
      },
    };
    const v = await mkdtemp(join(tmpdir(), 'edit-scalar-blank-control-'));
    await mkdir(join(v, '.bwrb'), { recursive: true });
    await writeFile(join(v, '.bwrb', 'schema.json'), JSON.stringify(scalarSchema, null, 2));
    await mkdir(join(v, 'people'), { recursive: true });

    const personPath = join(v, 'people', 'Scalar.md');
    await writeFile(personPath, `---\ntype: person\nname: Scalar\nnote: hello\n---\n\n# Scalar\n`);

    const schema = await loadSchema(v);
    // Blanking an optional scalar field is accepted (unset), NOT rejected.
    await editNoteFromJson(schema, v, personPath, JSON.stringify({ note: '   ' }), {
      jsonMode: false,
    });
    const fm = await readFrontmatter(personPath);
    expect(fm['note'] === undefined || String(fm['note']).trim() === '').toBe(true);

    await rm(v, { recursive: true, force: true });
  });

  it('control: an absent / empty-array alias value remains unset (no false rejection)', async () => {
    const schema = await loadSchema(vaultDir);
    // Absent alias field — unset, valid.
    const absent = validateFrontmatter(schema, 'person', { type: 'person', name: 'x' });
    expect(absent.errors.some((e) => e.field === 'aliases')).toBe(false);
    // Empty array — unset, valid (no wrong-shape rejection).
    const empty = validateFrontmatter(schema, 'person', {
      type: 'person',
      name: 'x',
      aliases: [],
    });
    expect(empty.errors.some((e) => e.field === 'aliases')).toBe(false);
  });
});
