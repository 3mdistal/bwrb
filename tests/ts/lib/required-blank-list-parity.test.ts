import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';

import { loadSchema } from '../../../src/lib/schema.js';
import { validateFrontmatter } from '../../../src/lib/validation.js';
import { runAudit } from '../../../src/lib/audit/detection.js';
import type { Schema } from '../../../src/types/schema.js';

/**
 * Regression coverage for the #707 REQUIRED-emptiness regression on list-shaped
 * fields (`prompt: 'list'` or `multiple: true`).
 *
 * A prior round of #707 excluded ALL list-shaped fields from the blank-as-unset
 * shortcut so a non-blank scalar (e.g. `labels: 'urgent'`) would still reach
 * type validation. That over-corrected: a BLANK value (`''` / whitespace /
 * empty array) on a REQUIRED list field stopped being treated as "missing", so
 * `validateFrontmatter` accepted it (`validateFieldType` leniently accepts a
 * string for `prompt: 'list'`) and write PERSISTED an empty required value —
 * while audit still reported `empty-string-required`. Write accepted, audit
 * flagged: parity violated.
 *
 * Ground truth: a blank value on a list-shaped field is EMPTY for the required
 * check (required -> required_field_missing; optional -> unset, no error),
 * exactly as audit's `isEmptyRequiredValue` classifies it. A NON-blank scalar on
 * a non-alias list field still flows to type validation (soft-coerce, out of
 * scope). Alias fields keep their stricter array contract (covered separately in
 * edit-blank-list-prompt-parity.test.ts).
 */

const SCHEMA: Schema = {
  version: 2,
  types: {
    widget: {
      output_dir: 'Widgets',
      fields: {
        type: { value: 'widget' },
        // Required list-shaped fields, both flavors.
        reqlist: { prompt: 'list', required: true },
        reqmulti: { prompt: 'select', multiple: true, required: true, options: ['a', 'b'] },
        // Optional list-shaped field.
        optlist: { prompt: 'list' },
      },
      field_order: ['type', 'reqlist', 'reqmulti', 'optlist'],
    },
  },
};

async function setupVault(): Promise<string> {
  const vaultDir = await mkdtemp(join(tmpdir(), 'required-blank-list-'));
  await mkdir(join(vaultDir, '.bwrb'), { recursive: true });
  await writeFile(join(vaultDir, '.bwrb', 'schema.json'), JSON.stringify(SCHEMA, null, 2));
  await mkdir(join(vaultDir, 'Widgets'), { recursive: true });
  return vaultDir;
}

function auditCodes(
  results: Awaited<ReturnType<typeof runAudit>>,
  fileName: string
): { code: string; field?: string }[] {
  const result = results.find((r) => r.relativePath.endsWith(fileName));
  return (result?.issues ?? []).map((i) => ({ code: i.code, field: i.field }));
}

describe('required blank list-field emptiness: write↔audit parity (#707)', () => {
  let vaultDir: string;
  beforeEach(async () => {
    vaultDir = await setupVault();
  });
  afterEach(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  // --- write side: validateFrontmatter ---

  for (const [label, blank] of [
    ['empty string', ''],
    ['whitespace-only', '   '],
  ] as const) {
    it(`REJECTS a ${label} value on a required prompt:'list' field (required-missing)`, async () => {
      const schema = await loadSchema(vaultDir);
      const result = validateFrontmatter(schema, 'widget', {
        type: 'widget',
        reqlist: blank,
        reqmulti: ['a'],
      });
      expect(result.valid).toBe(false);
      expect(
        result.errors.some(
          (e) => e.field === 'reqlist' && e.type === 'required_field_missing'
        )
      ).toBe(true);
    });
  }

  it("REJECTS an empty array on a required multiple field (required-missing)", async () => {
    const schema = await loadSchema(vaultDir);
    const result = validateFrontmatter(schema, 'widget', {
      type: 'widget',
      reqlist: ['x'],
      reqmulti: [],
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some(
        (e) => e.field === 'reqmulti' && e.type === 'required_field_missing'
      )
    ).toBe(true);
  });

  it('passes a required list field with a valid non-empty array', async () => {
    const schema = await loadSchema(vaultDir);
    const result = validateFrontmatter(schema, 'widget', {
      type: 'widget',
      reqlist: ['alpha'],
      reqmulti: ['a'],
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  for (const [label, value] of [
    ['empty string', ''],
    ['whitespace-only', '   '],
    ['empty array', [] as unknown],
  ] as const) {
    it(`treats a ${label} value on an OPTIONAL list field as unset (no error)`, async () => {
      const schema = await loadSchema(vaultDir);
      const result = validateFrontmatter(schema, 'widget', {
        type: 'widget',
        reqlist: ['x'],
        reqmulti: ['a'],
        optlist: value,
      });
      expect(result.errors.some((e) => e.field === 'optlist')).toBe(false);
    });
  }

  it('treats an ABSENT optional list field as unset (no error)', async () => {
    const schema = await loadSchema(vaultDir);
    const result = validateFrontmatter(schema, 'widget', {
      type: 'widget',
      reqlist: ['x'],
      reqmulti: ['a'],
    });
    expect(result.errors.some((e) => e.field === 'optlist')).toBe(false);
  });

  // --- audit side: parity ---

  it("parity: audit flags empty-string-required on a required prompt:'list' field with a blank value", async () => {
    const path = join(vaultDir, 'Widgets', 'ReqBlank.md');
    await writeFile(path, `---\ntype: widget\nreqlist: "   "\nreqmulti: [a]\n---\n`);
    const schema = await loadSchema(vaultDir);
    const results = await runAudit(schema, vaultDir, { strict: false, vaultDir, schema });
    const codes = auditCodes(results, 'ReqBlank.md');
    expect(
      codes.some((c) => c.code === 'empty-string-required' && c.field === 'reqlist')
    ).toBe(true);
  });

  it('parity: audit flags empty-string-required on a required multiple field with an empty array', async () => {
    const path = join(vaultDir, 'Widgets', 'ReqEmptyArr.md');
    await writeFile(path, `---\ntype: widget\nreqlist: [x]\nreqmulti: []\n---\n`);
    const schema = await loadSchema(vaultDir);
    const results = await runAudit(schema, vaultDir, { strict: false, vaultDir, schema });
    const codes = auditCodes(results, 'ReqEmptyArr.md');
    expect(
      codes.some((c) => c.code === 'empty-string-required' && c.field === 'reqmulti')
    ).toBe(true);
  });

  it('parity: audit does NOT flag an optional list field that is absent or an empty array', async () => {
    const path = join(vaultDir, 'Widgets', 'OptUnset.md');
    await writeFile(path, `---\ntype: widget\nreqlist: [x]\nreqmulti: [a]\noptlist: []\n---\n`);
    const schema = await loadSchema(vaultDir);
    const results = await runAudit(schema, vaultDir, { strict: false, vaultDir, schema });
    const codes = auditCodes(results, 'OptUnset.md');
    expect(codes.some((c) => c.field === 'optlist')).toBe(false);
  });

  it('control: a non-blank scalar on a non-alias list field is still accepted on write (soft-coerce, out of scope)', async () => {
    const schema = await loadSchema(vaultDir);
    const result = validateFrontmatter(schema, 'widget', {
      type: 'widget',
      reqlist: 'urgent',
      reqmulti: ['a'],
    });
    expect(result.errors.some((e) => e.field === 'reqlist')).toBe(false);
  });
});
