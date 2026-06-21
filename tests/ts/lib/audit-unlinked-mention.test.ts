import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm, readFile } from 'fs/promises';
import { mkdtemp } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadSchema } from '../../../src/lib/schema.js';
import { runAudit } from '../../../src/lib/audit/detection.js';
import { runAutoFix } from '../../../src/lib/audit/fix.js';
import {
  buildEntityMentionIndex,
  detectUnlinkedMentions,
  maskNonProse,
} from '../../../src/lib/audit/unlinked-mention.js';
import { buildVaultNoteSnapshot } from '../../../src/lib/discovery.js';
import type { Schema } from '../../../src/types/schema.js';
import { resolveSchema } from '../../../src/lib/schema.js';

const SCHEMA: Schema = {
  version: 2,
  types: {
    meta: { fields: {} },
    person: {
      extends: 'meta',
      output_dir: 'People',
      fields: {
        type: { value: 'person' },
        aliases: { prompt: 'list', alias: true, list_format: 'yaml-array' },
      },
      field_order: ['type', 'aliases'],
    },
    note: {
      extends: 'meta',
      output_dir: 'Notes',
      fields: { type: { value: 'note' } },
      field_order: ['type'],
    },
  },
};

// ---------------------------------------------------------------------------
// Unit tests on the detection module (no filesystem)
// ---------------------------------------------------------------------------

describe('unlinked-mention: maskNonProse', () => {
  it('masks fenced code blocks while preserving line count', () => {
    const body = 'Steve Yegge here.\n```\nSteve Yegge in code\n```\nSteve again.';
    const masked = maskNonProse(body);
    expect(masked.split('\n')).toHaveLength(body.split('\n').length);
    // The code-fence "Steve Yegge in code" line should be blanked.
    expect(masked).not.toContain('Steve Yegge in code');
    // Prose mentions remain.
    expect(masked).toContain('Steve Yegge here.');
  });

  it('masks inline code, wikilinks, markdown links, and URLs', () => {
    const body =
      'Plain Mercury. `Mercury code`. [[Mercury]]. [Mercury](Mercury.md). https://mercury.example/Mercury';
    const masked = maskNonProse(body);
    // Exactly one un-masked "Mercury" should survive: the plain-text one.
    const count = (masked.match(/Mercury/g) ?? []).length;
    expect(count).toBe(1);
  });
});

describe('unlinked-mention: detectUnlinkedMentions', () => {
  const schema = resolveSchema(SCHEMA);

  function indexFor(notes: Array<{ relativePath: string; frontmatter?: Record<string, unknown>; resolvedType?: string }>) {
    return buildEntityMentionIndex(
      { notes: notes.map((n) => ({ path: n.relativePath, relativePath: n.relativePath, ...(n.frontmatter ? { frontmatter: n.frontmatter } : {}), ...(n.resolvedType ? { resolvedType: n.resolvedType } : {}) })) },
      schema
    );
  }

  const personNotes = [
    { relativePath: 'People/Steve Yegge.md', resolvedType: 'person', frontmatter: { type: 'person', aliases: ['Stevey'] } },
    { relativePath: 'People/Margaret Hamilton.md', resolvedType: 'person', frontmatter: { type: 'person' } },
  ];

  it('flags an exact name mention as auto-fixable with a plain wikilink', () => {
    const index = indexFor(personNotes);
    const issues = detectUnlinkedMentions('I talked to Steve Yegge today.', 'Notes/Daily.md', index);
    expect(issues).toHaveLength(1);
    const issue = issues[0]!;
    expect(issue.code).toBe('unlinked-mention');
    expect(issue.autoFixable).toBe(true);
    expect(issue.meta?.['tier']).toBe('exact');
    expect(issue.meta?.['replacement']).toBe('[[Steve Yegge]]');
  });

  it('flags an alias mention as auto-fixable using the display form', () => {
    const index = indexFor(personNotes);
    const issues = detectUnlinkedMentions('Notes from Stevey.', 'Notes/Daily.md', index);
    expect(issues).toHaveLength(1);
    const issue = issues[0]!;
    expect(issue.autoFixable).toBe(true);
    expect(issue.meta?.['matchedKind']).toBe('alias');
    expect(issue.meta?.['replacement']).toBe('[[Steve Yegge|Stevey]]');
  });

  it('uses the display form to preserve surface casing that differs from the name', () => {
    const index = indexFor(personNotes);
    const issues = detectUnlinkedMentions('saw steve yegge yesterday', 'Notes/Daily.md', index);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.meta?.['replacement']).toBe('[[Steve Yegge|steve yegge]]');
  });

  it('does not flag a mention already inside a wikilink', () => {
    const index = indexFor(personNotes);
    const issues = detectUnlinkedMentions('I talked to [[Steve Yegge]] today.', 'Notes/Daily.md', index);
    expect(issues).toHaveLength(0);
  });

  it('does not flag a note mentioning its own name', () => {
    const index = indexFor(personNotes);
    const issues = detectUnlinkedMentions('I am Steve Yegge.', 'People/Steve Yegge.md', index);
    expect(issues).toHaveLength(0);
  });

  it('does not flag a note mentioning its own alias', () => {
    const index = indexFor(personNotes);
    const issues = detectUnlinkedMentions('People call me Stevey.', 'People/Steve Yegge.md', index);
    expect(issues).toHaveLength(0);
  });

  it('respects word boundaries (no substring matches)', () => {
    const index = indexFor([
      { relativePath: 'People/Ada.md', resolvedType: 'person', frontmatter: { type: 'person' } },
    ]);
    // "Adafruit" and "Canada" both contain "Ada" but must not match.
    const issues = detectUnlinkedMentions('Bought an Adafruit board in Canada.', 'Notes/Daily.md', index);
    expect(issues).toHaveLength(0);
  });

  it('flags a fuzzy near-match as a flag-only review item (never auto-fixed)', () => {
    const index = indexFor(personNotes);
    const issues = detectUnlinkedMentions('Reading a post by Steve Yeg.', 'Notes/Daily.md', index);
    const fuzzy = issues.find((i) => i.meta?.['tier'] === 'fuzzy');
    expect(fuzzy).toBeDefined();
    expect(fuzzy!.autoFixable).toBe(false);
    expect(fuzzy!.similarFiles).toContain('Steve Yegge');
  });

  it('flags an ambiguous mention as flag-only with multiple candidates', () => {
    // Two distinct entities both expose the surface "Mercury": one by name,
    // one by alias.
    const index = indexFor([
      { relativePath: 'Notes/Mercury.md', resolvedType: 'note', frontmatter: { type: 'note' } },
      { relativePath: 'People/Freddie.md', resolvedType: 'person', frontmatter: { type: 'person', aliases: ['Mercury'] } },
    ]);
    const issues = detectUnlinkedMentions('Talking about Mercury.', 'Notes/Daily.md', index);
    const ambiguous = issues.find((i) => i.meta?.['tier'] === 'ambiguous');
    expect(ambiguous).toBeDefined();
    expect(ambiguous!.autoFixable).toBe(false);
    expect(ambiguous!.candidates).toEqual(['Freddie', 'Mercury']);
  });

  it('does not flag inside code fences, inline code, or URLs', () => {
    const index = indexFor(personNotes);
    const body = [
      '```',
      'Steve Yegge',
      '```',
      'A `Steve Yegge` token.',
      'See https://example.com/Steve%20Yegge',
    ].join('\n');
    const issues = detectUnlinkedMentions(body, 'Notes/Daily.md', index);
    expect(issues).toHaveLength(0);
  });

  it('skips surfaces shorter than the minimum length', () => {
    const index = indexFor([
      { relativePath: 'Notes/Hi.md', resolvedType: 'note', frontmatter: { type: 'note' } },
    ]);
    const issues = detectUnlinkedMentions('Hi there.', 'Notes/Daily.md', index);
    expect(issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Integration tests through runAudit / runAutoFix on a real vault
// ---------------------------------------------------------------------------

describe('unlinked-mention: end-to-end audit + fix', () => {
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), 'bwrb-unlinked-'));
    await mkdir(join(vaultDir, '.bwrb'), { recursive: true });
    await writeFile(join(vaultDir, '.bwrb', 'schema.json'), JSON.stringify(SCHEMA, null, 2));
    await mkdir(join(vaultDir, 'People'), { recursive: true });
    await mkdir(join(vaultDir, 'Notes'), { recursive: true });

    await writeFile(
      join(vaultDir, 'People', 'Steve Yegge.md'),
      `---\ntype: person\naliases:\n  - Stevey\n---\n`
    );
  });

  afterEach(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  it('detects and auto-fixes an exact unlinked mention to a wikilink', async () => {
    await writeFile(
      join(vaultDir, 'Notes', 'Daily.md'),
      `---\ntype: note\n---\nI spoke with Steve Yegge today.\n`
    );
    const schema = await loadSchema(vaultDir);

    const results = await runAudit(schema, vaultDir, { strict: false });
    const daily = results.find((r) => r.relativePath === 'Notes/Daily.md');
    expect(daily?.issues.some((i) => i.code === 'unlinked-mention' && i.autoFixable)).toBe(true);

    await runAutoFix(results, schema, vaultDir, { dryRun: false });
    const after = await readFile(join(vaultDir, 'Notes', 'Daily.md'), 'utf-8');
    expect(after).toContain('[[Steve Yegge]]');
    expect(after).not.toMatch(/(?<!\[\[)Steve Yegge(?!\]\])/);
  });

  it('auto-fixes an alias mention using the display form', async () => {
    await writeFile(
      join(vaultDir, 'Notes', 'Daily.md'),
      `---\ntype: note\n---\nNotes from Stevey.\n`
    );
    const schema = await loadSchema(vaultDir);
    const results = await runAudit(schema, vaultDir, { strict: false });
    await runAutoFix(results, schema, vaultDir, { dryRun: false });
    const after = await readFile(join(vaultDir, 'Notes', 'Daily.md'), 'utf-8');
    expect(after).toContain('[[Steve Yegge|Stevey]]');
  });

  it('does not modify an already-linked mention', async () => {
    const original = `---\ntype: note\n---\nI spoke with [[Steve Yegge]] today.\n`;
    await writeFile(join(vaultDir, 'Notes', 'Daily.md'), original);
    const schema = await loadSchema(vaultDir);
    const results = await runAudit(schema, vaultDir, { strict: false });
    const daily = results.find((r) => r.relativePath === 'Notes/Daily.md');
    expect(daily?.issues.some((i) => i.code === 'unlinked-mention')).toBeFalsy();
  });

  it('does not auto-fix a fuzzy near-match', async () => {
    await writeFile(
      join(vaultDir, 'Notes', 'Daily.md'),
      `---\ntype: note\n---\nReading Steve Yeg today.\n`
    );
    const schema = await loadSchema(vaultDir);
    const results = await runAudit(schema, vaultDir, { strict: false });
    await runAutoFix(results, schema, vaultDir, { dryRun: false });
    const after = await readFile(join(vaultDir, 'Notes', 'Daily.md'), 'utf-8');
    // The fuzzy mention is left untouched.
    expect(after).toContain('Steve Yeg today');
    expect(after).not.toContain('[[Steve Yegge|Steve Yeg]]');
  });

  it('only-filter scopes the run to unlinked-mention issues', async () => {
    await writeFile(
      join(vaultDir, 'Notes', 'Daily.md'),
      `---\ntype: note\n---\nMet Steve Yegge.\n`
    );
    const schema = await loadSchema(vaultDir);
    const results = await runAudit(schema, vaultDir, { strict: false, onlyIssue: 'unlinked-mention' });
    for (const r of results) {
      for (const i of r.issues) {
        expect(i.code).toBe('unlinked-mention');
      }
    }
  });

  it('ignore-filter suppresses unlinked-mention issues', async () => {
    await writeFile(
      join(vaultDir, 'Notes', 'Daily.md'),
      `---\ntype: note\n---\nMet Steve Yegge.\n`
    );
    const schema = await loadSchema(vaultDir);
    const results = await runAudit(schema, vaultDir, { strict: false, ignoreIssue: 'unlinked-mention' });
    const daily = results.find((r) => r.relativePath === 'Notes/Daily.md');
    expect(daily?.issues.some((i) => i.code === 'unlinked-mention')).toBeFalsy();
  });
});
