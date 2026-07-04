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
  parseFuzzyThreshold,
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

  it('requires exact casing for single-word note-name mentions', () => {
    const index = indexFor([
      { relativePath: 'People/Orion.md', resolvedType: 'person', frontmatter: { type: 'person' } },
    ]);

    const lower = detectUnlinkedMentions('orion is bright tonight.', 'Notes/Daily.md', index);
    expect(lower).toHaveLength(0);

    const canonical = detectUnlinkedMentions('Orion is bright tonight.', 'Notes/Daily.md', index);
    expect(canonical).toHaveLength(1);
    expect(canonical[0]!.autoFixable).toBe(true);
    expect(canonical[0]!.targetName).toBe('Orion');
  });

  it('keeps multi-word note-name mentions case-insensitive', () => {
    const index = indexFor(personNotes);
    const issues = detectUnlinkedMentions('saw steve yegge yesterday', 'Notes/Daily.md', index);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.meta?.['replacement']).toBe('[[Steve Yegge|steve yegge]]');
  });

  it('keeps declared aliases case-insensitive, including common words', () => {
    const index = indexFor([
      {
        relativePath: 'People/Chronos.md',
        resolvedType: 'person',
        frontmatter: { type: 'person', aliases: ['Time'] },
      },
    ]);
    const issues = detectUnlinkedMentions('time keeps moving.', 'Notes/Daily.md', index);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.autoFixable).toBe(true);
    expect(issues[0]!.meta?.['matchedKind']).toBe('alias');
    expect(issues[0]!.meta?.['replacement']).toBe('[[Chronos|time]]');
  });

  it('skips common single-word note names even when prose casing matches', () => {
    const index = indexFor([
      { relativePath: 'Notes/Time.md', resolvedType: 'note', frontmatter: { type: 'note' } },
    ]);
    const issues = detectUnlinkedMentions('Time moved strangely today.', 'Notes/Daily.md', index);
    expect(issues).toHaveLength(0);
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

  it('does not fuzzy-flag common structural headings like Notes', () => {
    const index = indexFor([
      { relativePath: 'Notes/quotes.md', resolvedType: 'note', frontmatter: { type: 'note' } },
    ]);
    const issues = detectUnlinkedMentions('## Notes\n\nSome ordinary task detail.', 'Tasks/Tidy.md', index);
    expect(issues.some((i) => i.meta?.['tier'] === 'fuzzy')).toBe(false);
    expect(issues).toHaveLength(0);
  });

  it('does not fuzzy-flag common structural labels in composite ATX headings', () => {
    const index = indexFor([
      { relativePath: 'Notes/quotes.md', resolvedType: 'note', frontmatter: { type: 'note' } },
    ]);
    const issues = detectUnlinkedMentions(
      '## Notes from yesterday\n\nSome ordinary task detail.',
      'Tasks/Tidy.md',
      index
    );
    expect(issues.some((i) => i.meta?.['tier'] === 'fuzzy')).toBe(false);
    expect(issues).toHaveLength(0);
  });

  it('does not fuzzy-flag common structural labels in setext headings', () => {
    const index = indexFor([
      { relativePath: 'Notes/quotes.md', resolvedType: 'note', frontmatter: { type: 'note' } },
    ]);
    const issues = detectUnlinkedMentions(
      'Notes from yesterday\n====================\n\nSome ordinary task detail.',
      'Tasks/Tidy.md',
      index
    );
    expect(issues.some((i) => i.meta?.['tier'] === 'fuzzy')).toBe(false);
    expect(issues).toHaveLength(0);
  });

  it('skips common single-word fuzzy candidates in non-heading prose', () => {
    const index = indexFor([
      { relativePath: 'Notes/quotes.md', resolvedType: 'note', frontmatter: { type: 'note' } },
    ]);
    const issues = detectUnlinkedMentions(
      'I took Notes from yesterday into today.',
      'Tasks/Tidy.md',
      index
    );
    const fuzzy = issues.find((i) => i.meta?.['tier'] === 'fuzzy');
    expect(fuzzy).toBeUndefined();
    expect(issues).toHaveLength(0);
  });

  it('skips exact mention detection for common single-word note names', () => {
    const index = indexFor([
      { relativePath: 'Notes/Notes.md', resolvedType: 'note', frontmatter: { type: 'note' } },
    ]);
    const issues = detectUnlinkedMentions('## Notes\n\nSome ordinary task detail.', 'Tasks/Tidy.md', index);
    const exact = issues.find((i) => i.meta?.['tier'] === 'exact');
    expect(exact).toBeUndefined();
    expect(issues).toHaveLength(0);
  });

  it('skips common single-word fuzzy candidates', () => {
    const index = indexFor([
      { relativePath: 'Notes/Thiss.md', resolvedType: 'note', frontmatter: { type: 'note' } },
    ]);
    const issues = detectUnlinkedMentions('This should not be a suggestion.', 'Notes/Daily.md', index);
    expect(issues.some((i) => i.meta?.['tier'] === 'fuzzy')).toBe(false);
    expect(issues).toHaveLength(0);
  });

  it('does not fuzzy-suggest common single-word note names', () => {
    const index = indexFor([
      { relativePath: 'Notes/Time.md', resolvedType: 'note', frontmatter: { type: 'note' } },
    ]);
    const issues = detectUnlinkedMentions('Tyme moved strangely today.', 'Notes/Daily.md', index);
    expect(issues.some((i) => i.meta?.['tier'] === 'fuzzy')).toBe(false);
    expect(issues).toHaveLength(0);
  });

  it('still fuzzy-suggests uncommon single-word note names', () => {
    const index = indexFor([
      { relativePath: 'Notes/Orion.md', resolvedType: 'note', frontmatter: { type: 'note' } },
    ]);
    const issues = detectUnlinkedMentions('Oreon was visible tonight.', 'Notes/Daily.md', index);
    const fuzzy = issues.find((i) => i.meta?.['tier'] === 'fuzzy');
    expect(fuzzy).toBeDefined();
    expect(fuzzy!.similarFiles).toContain('Orion');
  });

  it('still finds a fuzzy suffix when a multi-word candidate starts with a common word', () => {
    const index = indexFor(personNotes);
    const issues = detectUnlinkedMentions('Also Steve Yeg wrote about it.', 'Notes/Daily.md', index);
    const fuzzy = issues.find((i) => i.meta?.['tier'] === 'fuzzy');
    expect(fuzzy).toBeDefined();
    expect(fuzzy!.value).toBe('Steve Yeg');
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
// Configurable fuzzy threshold (#622)
// ---------------------------------------------------------------------------

describe('unlinked-mention: configurable fuzzy threshold', () => {
  const schema = resolveSchema(SCHEMA);

  function indexFor(
    notes: Array<{ relativePath: string; frontmatter?: Record<string, unknown>; resolvedType?: string }>
  ) {
    return buildEntityMentionIndex(
      {
        notes: notes.map((n) => ({
          path: n.relativePath,
          relativePath: n.relativePath,
          ...(n.frontmatter ? { frontmatter: n.frontmatter } : {}),
          ...(n.resolvedType ? { resolvedType: n.resolvedType } : {}),
        })),
      },
      schema
    );
  }

  // "Canadians" is Levenshtein distance 3 from "Canada" — just outside the
  // conservative default of 2.
  const notes = [
    { relativePath: 'People/Canada.md', resolvedType: 'note', frontmatter: { type: 'note' } },
  ];

  it('does NOT fuzzy-flag a near-match just outside the default threshold', () => {
    const index = indexFor(notes);
    // "Canadians" → "Canada": distance 3 — outside default 2.
    const issues = detectUnlinkedMentions('Visiting Canadians today.', 'Notes/Daily.md', index);
    const fuzzy = issues.filter((i) => i.meta?.['tier'] === 'fuzzy');
    expect(fuzzy).toHaveLength(0);
  });

  it('still caps raised thresholds by candidate length', () => {
    const index = indexFor(notes);
    const issues = detectUnlinkedMentions(
      'Visiting Canadians today.',
      'Notes/Daily.md',
      index,
      { fuzzyThreshold: 3 }
    );
    const fuzzy = issues.find((i) => i.meta?.['tier'] === 'fuzzy');
    expect(fuzzy).toBeUndefined();
  });

  it('allows distance 1 for candidates 4-7 characters long', () => {
    const index = indexFor([
      { relativePath: 'Notes/Falcon.md', resolvedType: 'note', frontmatter: { type: 'note' } },
    ]);
    const issues = detectUnlinkedMentions('Falkon appeared in the margin.', 'Notes/Daily.md', index, {
      fuzzyThreshold: 5,
    });
    const fuzzy = issues.find((i) => i.meta?.['tier'] === 'fuzzy');
    expect(fuzzy).toBeDefined();
    expect(fuzzy!.similarFiles).toContain('Falcon');
  });

  it('does not allow distance 2 for candidates 4-7 characters long', () => {
    const index = indexFor([
      { relativePath: 'Notes/Falcon.md', resolvedType: 'note', frontmatter: { type: 'note' } },
    ]);
    const issues = detectUnlinkedMentions('Falken appeared in the margin.', 'Notes/Daily.md', index, {
      fuzzyThreshold: 5,
    });
    expect(issues.some((i) => i.meta?.['tier'] === 'fuzzy')).toBe(false);
  });

  it('allows distance 2 for candidates 8-11 characters long', () => {
    const index = indexFor([
      { relativePath: 'Notes/Falconer.md', resolvedType: 'note', frontmatter: { type: 'note' } },
    ]);
    const issues = detectUnlinkedMentions('Falkener appeared in the margin.', 'Notes/Daily.md', index, {
      fuzzyThreshold: 5,
    });
    const fuzzy = issues.find((i) => i.meta?.['tier'] === 'fuzzy');
    expect(fuzzy).toBeDefined();
    expect(fuzzy!.similarFiles).toContain('Falconer');
  });

  it('lowering the threshold reduces fuzzy flags (distance-2 match suppressed at threshold 1)', () => {
    const index = indexFor([
      { relativePath: 'People/Steve Yegge.md', resolvedType: 'person', frontmatter: { type: 'person' } },
    ]);
    // "Steve Yeg" → "Steve Yegge": distance 2.
    const atDefault = detectUnlinkedMentions('Reading Steve Yeg.', 'Notes/Daily.md', index);
    expect(atDefault.some((i) => i.meta?.['tier'] === 'fuzzy')).toBe(true);

    const lowered = detectUnlinkedMentions('Reading Steve Yeg.', 'Notes/Daily.md', index, {
      fuzzyThreshold: 1,
    });
    expect(lowered.some((i) => i.meta?.['tier'] === 'fuzzy')).toBe(false);
  });

  it('a threshold of 0 disables the fuzzy tier entirely', () => {
    const index = indexFor([
      { relativePath: 'People/Steve Yegge.md', resolvedType: 'person', frontmatter: { type: 'person' } },
    ]);
    const issues = detectUnlinkedMentions('Reading Steve Yeg.', 'Notes/Daily.md', index, {
      fuzzyThreshold: 0,
    });
    expect(issues.some((i) => i.meta?.['tier'] === 'fuzzy')).toBe(false);
  });

  it('fuzzyEnabled:false disables the fuzzy tier but keeps exact/ambiguous', () => {
    const index = indexFor([
      { relativePath: 'People/Steve Yegge.md', resolvedType: 'person', frontmatter: { type: 'person', aliases: ['Stevey'] } },
    ]);
    const body = 'Reading Steve Yeg, said Stevey.';
    const issues = detectUnlinkedMentions(body, 'Notes/Daily.md', index, { fuzzyEnabled: false });
    expect(issues.some((i) => i.meta?.['tier'] === 'fuzzy')).toBe(false);
    // The exact alias mention ("Stevey") is still flagged + auto-fixable.
    expect(issues.some((i) => i.meta?.['tier'] === 'exact' && i.autoFixable)).toBe(true);
  });
});

describe('unlinked-mention: parseFuzzyThreshold validation', () => {
  it('accepts valid integers in range (string and number)', () => {
    expect(parseFuzzyThreshold('2')).toEqual({ ok: true, value: 2 });
    expect(parseFuzzyThreshold(0)).toEqual({ ok: true, value: 0 });
    expect(parseFuzzyThreshold('5')).toEqual({ ok: true, value: 5 });
  });

  it('rejects out-of-range values', () => {
    const tooHigh = parseFuzzyThreshold('6');
    expect(tooHigh.ok).toBe(false);
    const negative = parseFuzzyThreshold('-1');
    expect(negative.ok).toBe(false);
  });

  it('rejects non-integers and garbage with a clear message', () => {
    const frac = parseFuzzyThreshold('2.5');
    expect(frac.ok).toBe(false);
    const garbage = parseFuzzyThreshold('abc');
    expect(garbage.ok).toBe(false);
    if (!garbage.ok) {
      expect(garbage.error).toMatch(/integer between 0 and 5/);
    }
  });
});

// ---------------------------------------------------------------------------
// Mention target exclusion config
// ---------------------------------------------------------------------------

describe('unlinked-mention: mention target exclusions', () => {
  const EXCLUSION_SCHEMA: Schema = {
    version: 2,
    config: {
      mention_exclude_types: ['book'],
      mention_exclude_paths: ['Imports/**'],
    },
    types: {
      meta: { fields: {} },
      reference: {
        extends: 'meta',
        output_dir: 'References',
        fields: { type: { value: 'reference' } },
      },
      book: {
        extends: 'reference',
        output_dir: 'Books',
        fields: {
          type: { value: 'book' },
          aliases: { prompt: 'list', alias: true, list_format: 'yaml-array' },
        },
      },
      person: {
        extends: 'meta',
        output_dir: 'People',
        fields: {
          type: { value: 'person' },
          aliases: { prompt: 'list', alias: true, list_format: 'yaml-array' },
        },
      },
      note: {
        extends: 'meta',
        output_dir: 'Notes',
        fields: { type: { value: 'note' } },
      },
    },
  };

  const exclusionSchema = resolveSchema(EXCLUSION_SCHEMA);

  function exclusionIndexFor(
    notes: Array<{ relativePath: string; frontmatter?: Record<string, unknown>; resolvedType?: string }>
  ) {
    return buildEntityMentionIndex(
      {
        notes: notes.map((n) => ({
          path: n.relativePath,
          relativePath: n.relativePath,
          ...(n.frontmatter ? { frontmatter: n.frontmatter } : {}),
          ...(n.resolvedType ? { resolvedType: n.resolvedType } : {}),
        })),
      },
      exclusionSchema
    );
  }

  it('excludes a configured type from name and alias mention surfaces', () => {
    const index = exclusionIndexFor([
      {
        relativePath: 'Books/The Great Gatsby.md',
        resolvedType: 'book',
        frontmatter: { type: 'book', aliases: ['Jay Gatsby'] },
      },
    ]);

    expect(index.bySurface.has('the great gatsby')).toBe(false);
    expect(index.bySurface.has('jay gatsby')).toBe(false);
    expect(index.allNames).not.toContain('The Great Gatsby');
    expect(index.excludedSurfaces.has('the great gatsby')).toBe(true);
    expect(index.excludedSurfaces.has('jay gatsby')).toBe(true);

    const issues = detectUnlinkedMentions(
      'The Great Gatsby introduces Jay Gatsby.',
      'Notes/Daily.md',
      index
    );
    expect(issues).toHaveLength(0);
  });

  it('excludes descendants of a configured type', () => {
    const schema = resolveSchema({
      ...EXCLUSION_SCHEMA,
      config: { mention_exclude_types: ['reference'] },
    });
    const index = buildEntityMentionIndex(
      {
        notes: [
          {
            path: 'Books/The Left Hand of Darkness.md',
            relativePath: 'Books/The Left Hand of Darkness.md',
            resolvedType: 'book',
            frontmatter: { type: 'book', aliases: ['Left Hand'] },
          },
        ],
      },
      schema
    );

    expect(index.bySurface.has('the left hand of darkness')).toBe(false);
    expect(index.bySurface.has('left hand')).toBe(false);
    expect(index.excludedSurfaces.has('the left hand of darkness')).toBe(true);
  });

  it('excludes notes matching configured vault-relative path globs', () => {
    const index = exclusionIndexFor([
      {
        relativePath: 'Imports/Imported Person.md',
        resolvedType: 'person',
        frontmatter: { type: 'person', aliases: ['Imported Alias'] },
      },
      {
        relativePath: 'People/Handmade Person.md',
        resolvedType: 'person',
        frontmatter: { type: 'person' },
      },
    ]);

    expect(index.bySurface.has('imported person')).toBe(false);
    expect(index.bySurface.has('imported alias')).toBe(false);
    expect(index.bySurface.has('handmade person')).toBe(true);
  });

  it('excludes typeless notes discovered in an excluded type output_dir', async () => {
    const vaultDir = await mkdtemp(join(tmpdir(), 'bwrb-mention-exclude-typeless-'));
    try {
      await mkdir(join(vaultDir, '.bwrb'), { recursive: true });
      await mkdir(join(vaultDir, 'Books'), { recursive: true });
      await writeFile(
        join(vaultDir, '.bwrb', 'schema.json'),
        JSON.stringify(EXCLUSION_SCHEMA, null, 2)
      );
      await writeFile(
        join(vaultDir, 'Books', 'Typeless Tome.md'),
        `---\ntitle: Imported without type\n---\n`
      );

      const loadedSchema = await loadSchema(vaultDir);
      const snapshot = await buildVaultNoteSnapshot(loadedSchema, vaultDir);
      const index = buildEntityMentionIndex(snapshot, loadedSchema);
      const typelessNote = snapshot.notes.find((note) => note.relativePath === 'Books/Typeless Tome.md');

      expect(typelessNote?.resolvedType).toBeUndefined();
      expect(typelessNote?.directoryType).toBe('book');
      expect(index.bySurface.has('typeless tome')).toBe(false);
      expect(index.allNames).not.toContain('Typeless Tome');
      expect(index.excludedSurfaces.has('typeless tome')).toBe(true);

      const issues = detectUnlinkedMentions('Typeless Tome is imported.', 'Notes/Daily.md', index);
      expect(issues).toHaveLength(0);
    } finally {
      await rm(vaultDir, { recursive: true, force: true });
    }
  });

  it('does not use excluded names for fuzzy did-you-mean suggestions', () => {
    const index = exclusionIndexFor([
      {
        relativePath: 'Books/Neuromancer.md',
        resolvedType: 'book',
        frontmatter: { type: 'book' },
      },
    ]);

    const issues = detectUnlinkedMentions('Reading Neuromansir today.', 'Notes/Daily.md', index, {
      fuzzyThreshold: 5,
    });
    expect(issues.some((i) => i.meta?.['tier'] === 'fuzzy')).toBe(false);
  });

  it('throws a clear config error for unknown mention_exclude_types entries', () => {
    expect(() =>
      resolveSchema({
        ...SCHEMA,
        config: { mention_exclude_types: ['persno'] },
      })
    ).toThrow(/config\.mention_exclude_types includes unknown type "persno".*person/);
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

  it('still scans excluded target notes as source documents', async () => {
    const schemaWithExcludedBooks: Schema = {
      version: 2,
      config: { mention_exclude_types: ['book'] },
      types: {
        ...SCHEMA.types,
        book: {
          extends: 'meta',
          output_dir: 'Books',
          fields: { type: { value: 'book' } },
        },
      },
    };
    await writeFile(
      join(vaultDir, '.bwrb', 'schema.json'),
      JSON.stringify(schemaWithExcludedBooks, null, 2)
    );
    await mkdir(join(vaultDir, 'Books'), { recursive: true });
    await writeFile(
      join(vaultDir, 'Books', 'Imported Book.md'),
      `---\ntype: book\n---\nThis imported note mentions Steve Yegge in prose.\n`
    );

    const schema = await loadSchema(vaultDir);
    const results = await runAudit(schema, vaultDir, {
      strict: false,
      onlyIssue: 'unlinked-mention',
    });
    const imported = results.find((r) => r.relativePath === 'Books/Imported Book.md');
    expect(imported?.issues.some((i) => i.code === 'unlinked-mention')).toBe(true);
    expect(imported?.issues[0]?.targetName).toBe('Steve Yegge');
  });
});
