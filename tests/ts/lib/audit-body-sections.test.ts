import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm, readFile, mkdtemp } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadSchema } from '../../../src/lib/schema.js';
import { runAudit } from '../../../src/lib/audit/detection.js';
import { runAutoFix } from '../../../src/lib/audit/fix.js';
import {
  detectMissingBodySections,
  isBodySectionPresent,
} from '../../../src/lib/audit/body-sections.js';
import type { BodySection, Schema } from '../../../src/types/schema.js';

// ---------------------------------------------------------------------------
// Unit tests on the pure detector (no filesystem)
// ---------------------------------------------------------------------------

const SECTIONS: BodySection[] = [
  { title: 'Steps to Reproduce', level: 2, content_type: 'bullets' },
  { title: 'Expected Behavior', level: 2, content_type: 'paragraphs' },
];

describe('body-sections: detectMissingBodySections', () => {
  it('flags a missing declared section', () => {
    const body = '## Steps to Reproduce\n- one\n';
    const issues = detectMissingBodySections(body, SECTIONS);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe('missing-body-section');
    expect(issues[0]!.message).toContain('Expected Behavior');
    expect(issues[0]!.autoFixable).toBe(true);
    expect(issues[0]!.inBody).toBe(true);
  });

  it('does not flag when all sections are present', () => {
    const body = '## Steps to Reproduce\n- one\n\n## Expected Behavior\n\nIt should work.\n';
    const issues = detectMissingBodySections(body, SECTIONS);
    expect(issues).toHaveLength(0);
  });

  it('tolerates trailing whitespace and ATX closing hashes', () => {
    const body = '## Steps to Reproduce  \n\n## Expected Behavior ##\n';
    const issues = detectMissingBodySections(body, SECTIONS);
    expect(issues).toHaveLength(0);
  });

  it('flags all sections for an empty body', () => {
    const issues = detectMissingBodySections('', SECTIONS);
    expect(issues.map((i) => i.meta?.['title'])).toEqual([
      'Steps to Reproduce',
      'Expected Behavior',
    ]);
  });

  it('does not count a heading inside a fenced code block as present', () => {
    const body = '```\n## Steps to Reproduce\n```\n\n## Expected Behavior\n\nok\n';
    const issues = detectMissingBodySections(body, SECTIONS);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.meta?.['title']).toBe('Steps to Reproduce');
  });

  it('flags a heading present at the wrong level and records the line', () => {
    // "## Steps to Reproduce" declared, but the body only has it at level 3.
    const body = '### Steps to Reproduce\n- one\n\n## Expected Behavior\n\nok\n';
    const issues = detectMissingBodySections(body, SECTIONS);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.meta?.['wrongLevel']).toBe(true);
    expect(issues[0]!.lineNumber).toBe(1);
  });

  it('recurses into nested child sections', () => {
    const nested: BodySection[] = [
      {
        title: 'Plan',
        level: 2,
        children: [{ title: 'Risks', level: 3, content_type: 'bullets' }],
      },
    ];
    const body = '## Plan\n\nA plan.\n';
    const issues = detectMissingBodySections(body, nested);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.meta?.['title']).toBe('Risks');
    expect(issues[0]!.meta?.['level']).toBe(3);
  });

  it('returns nothing when the type declares no body sections', () => {
    expect(detectMissingBodySections('anything', [])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Shared presence helper (#653): single source of truth used by both
// `bwrb edit`'s add-missing-sections flow and the audit
// `missing-body-section` detector + fix.
// ---------------------------------------------------------------------------

describe('body-sections: isBodySectionPresent', () => {
  it('returns true for an exact heading match', () => {
    expect(isBodySectionPresent('## Notes\n\nstuff\n', 2, 'Notes')).toBe(true);
  });

  it('returns false when the heading is absent', () => {
    expect(isBodySectionPresent('# Title\n\nbody\n', 2, 'Notes')).toBe(false);
  });

  it('returns false when the heading exists only at the wrong level', () => {
    expect(isBodySectionPresent('### Notes\n', 2, 'Notes')).toBe(false);
    expect(isBodySectionPresent('# Notes\n', 2, 'Notes')).toBe(false);
  });

  it('tolerates trailing whitespace', () => {
    expect(isBodySectionPresent('## Notes   \n', 2, 'Notes')).toBe(true);
  });

  it('tolerates an ATX closing-hash sequence', () => {
    expect(isBodySectionPresent('## Notes ##\n', 2, 'Notes')).toBe(true);
    expect(isBodySectionPresent('## Notes ###  \n', 2, 'Notes')).toBe(true);
  });

  it('tolerates leading indentation', () => {
    expect(isBodySectionPresent('   ## Notes\n', 2, 'Notes')).toBe(true);
  });

  it('does not count a heading inside a fenced code block as present', () => {
    expect(isBodySectionPresent('```\n## Notes\n```\n', 2, 'Notes')).toBe(false);
  });

  it('is case-sensitive on the title', () => {
    expect(isBodySectionPresent('## notes\n', 2, 'Notes')).toBe(false);
  });

  it('does not match a heading with extra trailing text (anchored end)', () => {
    // Pins the unified behavior (#653): `bwrb edit` previously used an
    // unanchored prefix matcher that would have treated this as present;
    // the shared helper anchors the line end, matching the audit matcher.
    expect(isBodySectionPresent('## Notes and more\n', 2, 'Notes')).toBe(false);
  });

  it('regex-escapes special characters in the title', () => {
    // Pins the unified behavior (#653): `bwrb edit` previously fed the raw
    // title into a RegExp, so `.` matched any char. The shared helper escapes.
    expect(isBodySectionPresent('## A.B\n', 2, 'A.B')).toBe(true);
    expect(isBodySectionPresent('## AxB\n', 2, 'A.B')).toBe(false);
  });

  it('supports level 1 and deeper levels', () => {
    expect(isBodySectionPresent('# Top\n', 1, 'Top')).toBe(true);
    expect(isBodySectionPresent('#### Deep\n', 4, 'Deep')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// End-to-end audit + fix on a real vault
// ---------------------------------------------------------------------------

const SCHEMA: Schema = {
  version: 2,
  types: {
    meta: { fields: {} },
    bug: {
      extends: 'meta',
      output_dir: 'Bugs',
      fields: { type: { value: 'bug' } },
      field_order: ['type'],
      body_sections: [
        { title: 'Steps to Reproduce', level: 2, content_type: 'bullets' },
        { title: 'Expected Behavior', level: 2, content_type: 'paragraphs' },
      ],
    },
    note: {
      extends: 'meta',
      output_dir: 'Notes',
      fields: { type: { value: 'note' } },
      field_order: ['type'],
    },
  },
};

describe('body-sections: end-to-end audit + fix', () => {
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), 'bwrb-body-sections-'));
    await mkdir(join(vaultDir, '.bwrb'), { recursive: true });
    await writeFile(join(vaultDir, '.bwrb', 'schema.json'), JSON.stringify(SCHEMA, null, 2));
    await mkdir(join(vaultDir, 'Bugs'), { recursive: true });
    await mkdir(join(vaultDir, 'Notes'), { recursive: true });
  });

  afterEach(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  it('detects a missing body section', async () => {
    await writeFile(
      join(vaultDir, 'Bugs', 'Crash.md'),
      `---\ntype: bug\n---\n## Steps to Reproduce\n- click\n`
    );
    const schema = await loadSchema(vaultDir);
    const results = await runAudit(schema, vaultDir, { strict: false });
    const bug = results.find((r) => r.relativePath === 'Bugs/Crash.md');
    const missing = bug?.issues.filter((i) => i.code === 'missing-body-section') ?? [];
    expect(missing).toHaveLength(1);
    expect(missing[0]!.meta?.['title']).toBe('Expected Behavior');
  });

  it('does not flag a note whose type declares no body sections', async () => {
    await writeFile(join(vaultDir, 'Notes', 'Daily.md'), `---\ntype: note\n---\nFree text.\n`);
    const schema = await loadSchema(vaultDir);
    const results = await runAudit(schema, vaultDir, { strict: false });
    const daily = results.find((r) => r.relativePath === 'Notes/Daily.md');
    expect(daily?.issues.some((i) => i.code === 'missing-body-section')).toBeFalsy();
  });

  it('auto-fixes by appending the missing heading scaffold, and is idempotent', async () => {
    await writeFile(
      join(vaultDir, 'Bugs', 'Crash.md'),
      `---\ntype: bug\n---\n## Steps to Reproduce\n- click\n`
    );
    const schema = await loadSchema(vaultDir);

    const results = await runAudit(schema, vaultDir, { strict: false });
    await runAutoFix(results, schema, vaultDir, { dryRun: false });

    const after = await readFile(join(vaultDir, 'Bugs', 'Crash.md'), 'utf-8');
    expect(after).toContain('## Expected Behavior');
    // Existing content is preserved.
    expect(after).toContain('## Steps to Reproduce');
    expect(after).toContain('- click');

    // Re-auditing should now find nothing, and a second fix is a no-op.
    const results2 = await runAudit(schema, vaultDir, { strict: false });
    const bug2 = results2.find((r) => r.relativePath === 'Bugs/Crash.md');
    expect(bug2?.issues.some((i) => i.code === 'missing-body-section')).toBeFalsy();

    await runAutoFix(results2, schema, vaultDir, { dryRun: false });
    const after2 = await readFile(join(vaultDir, 'Bugs', 'Crash.md'), 'utf-8');
    // No duplicate heading appended.
    expect(after2.match(/## Expected Behavior/g)).toHaveLength(1);
  });

  it('dry-run does not write', async () => {
    const original = `---\ntype: bug\n---\n## Steps to Reproduce\n- click\n`;
    await writeFile(join(vaultDir, 'Bugs', 'Crash.md'), original);
    const schema = await loadSchema(vaultDir);
    const results = await runAudit(schema, vaultDir, { strict: false });
    await runAutoFix(results, schema, vaultDir, { dryRun: true });
    const after = await readFile(join(vaultDir, 'Bugs', 'Crash.md'), 'utf-8');
    expect(after).toBe(original);
  });

  it('only-filter scopes the run to missing-body-section issues', async () => {
    await writeFile(join(vaultDir, 'Bugs', 'Crash.md'), `---\ntype: bug\n---\n`);
    const schema = await loadSchema(vaultDir);
    const results = await runAudit(schema, vaultDir, {
      strict: false,
      onlyIssue: 'missing-body-section',
    });
    for (const r of results) {
      for (const i of r.issues) {
        expect(i.code).toBe('missing-body-section');
      }
    }
  });

  it('ignore-filter suppresses missing-body-section issues', async () => {
    await writeFile(join(vaultDir, 'Bugs', 'Crash.md'), `---\ntype: bug\n---\n`);
    const schema = await loadSchema(vaultDir);
    const results = await runAudit(schema, vaultDir, {
      strict: false,
      ignoreIssue: 'missing-body-section',
    });
    const bug = results.find((r) => r.relativePath === 'Bugs/Crash.md');
    expect(bug?.issues.some((i) => i.code === 'missing-body-section')).toBeFalsy();
  });
});
