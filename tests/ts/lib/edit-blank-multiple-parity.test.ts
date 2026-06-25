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
 * Regression coverage for the #707 write↔audit parity break on `multiple` (list)
 * fields.
 *
 * The trim-everywhere blank-as-unset shortcut (`isBlankScalar`) was applied
 * BEFORE validation for EVERY field shape, not just scalars. A whitespace-only
 * scalar string for an optional `multiple: true` field was therefore treated as
 * "unset" and SKIPPED the list/option/date checks: `dates: "   "` on a
 * `prompt: "date", multiple: true` field passed write and was PERSISTED as a
 * scalar string, while `audit` still reported `wrong-scalar-type` (it expects a
 * list). Write accepted, audit flagged: parity violated.
 *
 * Ground truth: audit flags ANY non-array scalar on a `multiple` field as
 * `wrong-scalar-type` (it never routes list fields through `isBlankScalar`). The
 * fix stops the blank-as-unset shortcut from firing on `multiple` fields, so a
 * blank scalar is rejected at write the same way a genuinely invalid value would
 * be — write and audit now AGREE (both reject/flag). A non-blank scalar that
 * carries a value (e.g. `labels: "urgent"`) keeps its long-standing
 * accept-on-write / autofix-on-audit behavior.
 */

const SCHEMA: Schema = {
  version: 2,
  types: {
    event: {
      output_dir: 'events',
      fields: {
        name: { prompt: 'text', required: true },
        // Optional list of dates: a `date` prompt with `multiple: true`.
        dates: { prompt: 'date', multiple: true },
        // Optional multi-select.
        labels: { prompt: 'select', options: ['urgent', 'blocked'], multiple: true },
      },
    },
  },
};

async function setupVault(): Promise<string> {
  const vaultDir = await mkdtemp(join(tmpdir(), 'edit-blank-multiple-'));
  await mkdir(join(vaultDir, '.bwrb'), { recursive: true });
  await writeFile(join(vaultDir, '.bwrb', 'schema.json'), JSON.stringify(SCHEMA, null, 2));
  await mkdir(join(vaultDir, 'events'), { recursive: true });
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

describe('whitespace scalar on multiple field: write↔audit parity (#707)', () => {
  let vaultDir: string;
  beforeEach(async () => {
    vaultDir = await setupVault();
  });
  afterEach(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  it('validateFrontmatter REJECTS a whitespace scalar on a multiple date field (matches audit flag)', async () => {
    const schema = await loadSchema(vaultDir);
    const result = validateFrontmatter(schema, 'event', {
      type: 'event',
      name: 'x',
      dates: '   ',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'dates')).toBe(true);
  });

  it('edit --json: a whitespace scalar for an optional multiple field is rejected; nothing persisted', async () => {
    const eventPath = join(vaultDir, 'events', 'Show.md');
    await writeFile(
      eventPath,
      `---
type: event
name: Show
dates:
  - 2026-01-02
---

# Show
`
    );

    const schema = await loadSchema(vaultDir);
    // Write must REJECT — audit would flag this same value as wrong-scalar-type.
    await expect(
      editNoteFromJson(schema, vaultDir, eventPath, JSON.stringify({ dates: '   ' }), {
        jsonMode: false,
      })
    ).rejects.toThrow(/dates/);

    // The original list value is untouched on disk.
    const fm = await readFrontmatter(eventPath);
    expect(fm['dates']).toEqual(['2026-01-02']);
  });

  it('parity: had the blank scalar been persisted, audit would have flagged wrong-scalar-type', async () => {
    // Demonstrates the audit side of the parity: a note carrying a blank scalar on
    // a multiple field is flagged wrong-scalar-type. Since write now REJECTS the
    // same value (test above), the "write accepts, audit flags" disparity is gone.
    const eventPath = join(vaultDir, 'events', 'Bad.md');
    await writeFile(eventPath, `---\ntype: event\nname: Bad\ndates: "   "\n---\n`);

    const schema = await loadSchema(vaultDir);
    const results = await runAudit(schema, vaultDir, { strict: false, vaultDir, schema });
    const issues = auditIssues(results, 'Bad.md');
    expect(issues.some((i) => i.code === 'wrong-scalar-type' && i.field === 'dates')).toBe(true);

    // And write rejects that exact value — confirming agreement.
    const result = validateFrontmatter(schema, 'event', {
      type: 'event',
      name: 'Bad',
      dates: '   ',
    });
    expect(result.valid).toBe(false);
  });

  it('control: a proper list value on a multiple field passes write and audit', async () => {
    const eventPath = join(vaultDir, 'events', 'Good.md');
    await writeFile(
      eventPath,
      `---
type: event
name: Good
---

# Good
`
    );

    const schema = await loadSchema(vaultDir);
    await editNoteFromJson(
      schema,
      vaultDir,
      eventPath,
      JSON.stringify({ dates: ['2026-01-02', '2026-02-03'] }),
      { jsonMode: false }
    );

    const fm = await readFrontmatter(eventPath);
    expect(fm['dates']).toEqual(['2026-01-02', '2026-02-03']);

    const results = await runAudit(schema, vaultDir, { strict: false, vaultDir, schema });
    const issues = auditIssues(results, 'Good.md');
    expect(issues.some((i) => i.code === 'wrong-scalar-type')).toBe(false);
  });

  it('control: blank scalar on a NON-multiple (scalar) field is still treated as unset (#707 preserved)', async () => {
    // The PR's main change — trim-everywhere blank-as-unset for SCALAR fields —
    // must be preserved. `labels` here is forced scalar by using a non-multiple
    // optional text field.
    const scalarSchema: Schema = {
      version: 2,
      types: {
        event: {
          output_dir: 'events',
          fields: {
            name: { prompt: 'text', required: true },
            note: { prompt: 'text' },
          },
        },
      },
    };
    const v = await mkdtemp(join(tmpdir(), 'edit-scalar-blank-'));
    await mkdir(join(v, '.bwrb'), { recursive: true });
    await writeFile(join(v, '.bwrb', 'schema.json'), JSON.stringify(scalarSchema, null, 2));
    await mkdir(join(v, 'events'), { recursive: true });

    const eventPath = join(v, 'events', 'Scalar.md');
    await writeFile(eventPath, `---\ntype: event\nname: Scalar\nnote: hello\n---\n\n# Scalar\n`);

    const schema = await loadSchema(v);
    // Blanking an optional scalar field is accepted (unset), NOT rejected.
    await editNoteFromJson(schema, v, eventPath, JSON.stringify({ note: '   ' }), {
      jsonMode: false,
    });
    const fm = await readFrontmatter(eventPath);
    expect(fm['note'] === undefined || String(fm['note']).trim() === '').toBe(true);

    await rm(v, { recursive: true, force: true });
  });
});
