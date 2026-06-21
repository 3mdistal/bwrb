import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm, mkdtemp } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadSchema, resolveSchema } from '../../../src/lib/schema.js';
import { runAudit } from '../../../src/lib/audit/detection.js';
import { buildEntityMentionIndex } from '../../../src/lib/audit/unlinked-mention.js';
import {
  FrequentTermAccumulator,
  extractCandidates,
  FREQUENT_TERM_DEFAULTS,
} from '../../../src/lib/audit/frequent-unlinked-term.js';
import type { Schema } from '../../../src/types/schema.js';

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

// ---------------------------------------------------------------------------
// Candidate extraction (unit)
// ---------------------------------------------------------------------------

describe('frequent-unlinked-term: extractCandidates', () => {
  it('groups consecutive Capitalized words into multi-word phrases', () => {
    const hits = extractCandidates('I read the New York Times today.', 3);
    expect(hits.map((h) => h.text)).toContain('New York Times');
  });

  it('caps phrase length at maxPhraseWords', () => {
    const hits = extractCandidates('Alpha Beta Gamma Delta here.', 2);
    // Should not produce a single 4-word phrase.
    expect(hits.every((h) => h.text.split(' ').length <= 2)).toBe(true);
  });

  it('marks sentence-start position', () => {
    const hits = extractCandidates('Today was fine. Rust is great.', 3);
    const today = hits.find((h) => h.text === 'Today');
    const rust = hits.find((h) => h.text === 'Rust');
    expect(today?.atSentenceStart).toBe(true);
    expect(rust?.atSentenceStart).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Accumulator / thresholds (unit)
// ---------------------------------------------------------------------------

describe('frequent-unlinked-term: FrequentTermAccumulator', () => {
  const emptyIndex = indexFor([]);

  it('surfaces a multi-word phrase repeated >= threshold across >= threshold notes', () => {
    const acc = new FrequentTermAccumulator(emptyIndex, { minMentions: 4, minNotes: 2 });
    // 2 notes, 4 total mentions.
    acc.addBody('We use Rust Foundation here. Rust Foundation is great.', 'a.md');
    acc.addBody('The Rust Foundation again. Rust Foundation rules.', 'b.md');
    const issues = acc.finish();
    const term = issues.find((i) => i.value === 'Rust Foundation');
    expect(term).toBeDefined();
    expect(term?.code).toBe('frequent-unlinked-term');
    expect(term?.autoFixable).toBe(false);
    expect(term?.meta?.['mentions']).toBe(4);
    expect(term?.meta?.['noteCount']).toBe(2);
  });

  it('does NOT surface a term below the mention threshold', () => {
    const acc = new FrequentTermAccumulator(emptyIndex, { minMentions: 4, minNotes: 2 });
    acc.addBody('Apache Kafka here. Apache Kafka again.', 'a.md');
    acc.addBody('Apache Kafka once more.', 'b.md');
    // 3 total mentions < 4.
    expect(acc.finish().find((i) => i.value === 'Apache Kafka')).toBeUndefined();
  });

  it('does NOT surface a term confined to a single note', () => {
    const acc = new FrequentTermAccumulator(emptyIndex, { minMentions: 4, minNotes: 2 });
    acc.addBody('Apache Kafka. Apache Kafka. Apache Kafka. Apache Kafka.', 'a.md');
    expect(acc.finish().find((i) => i.value === 'Apache Kafka')).toBeUndefined();
  });

  it('excludes terms that already have a note (closed-world handoff)', () => {
    const index = indexFor([
      { relativePath: 'People/Steve Yegge.md', resolvedType: 'person', frontmatter: { type: 'person' } },
    ]);
    const acc = new FrequentTermAccumulator(index, { minMentions: 2, minNotes: 1 });
    acc.addBody('Steve Yegge wrote this. Steve Yegge again.', 'a.md');
    expect(acc.finish().find((i) => i.value === 'Steve Yegge')).toBeUndefined();
  });

  it('excludes terms that match a registered alias', () => {
    const index = indexFor([
      {
        relativePath: 'People/Steve Yegge.md',
        resolvedType: 'person',
        frontmatter: { type: 'person', aliases: ['Stevey'] },
      },
    ]);
    const acc = new FrequentTermAccumulator(index, { minMentions: 2, minNotes: 1 });
    acc.addBody('Stevey said this. Stevey said that.', 'a.md');
    expect(acc.finish().find((i) => i.value?.toString().toLowerCase() === 'stevey')).toBeUndefined();
  });

  it('does not count text inside code/links/wikilinks (reuses #600 masking)', () => {
    const acc = new FrequentTermAccumulator(emptyIndex, { minMentions: 3, minNotes: 2 });
    // Only one prose mention; the rest are masked.
    acc.addBody('Rust Foundation here. `Rust Foundation` [[Rust Foundation]] [x](Rust Foundation).', 'a.md');
    acc.addBody('Rust Foundation in note b.', 'b.md');
    // 2 prose mentions total (< 3) → not surfaced, proving masked ones were ignored.
    expect(acc.finish().find((i) => i.value === 'Rust Foundation')).toBeUndefined();
  });

  it('excludes single-word stopwords even when frequent', () => {
    const acc = new FrequentTermAccumulator(emptyIndex, { minMentions: 2, minNotes: 2 });
    acc.addBody('Today rules. Things happen, Today.', 'a.md');
    acc.addBody('Stuff, Today. More, Today.', 'b.md');
    expect(acc.finish().find((i) => i.value?.toString().toLowerCase() === 'today')).toBeUndefined();
  });

  it('drops single-word candidates that only ever start sentences', () => {
    const acc = new FrequentTermAccumulator(emptyIndex, { minMentions: 2, minNotes: 2 });
    // "Coffee" appears only at sentence starts.
    acc.addBody('Coffee is good. Coffee helps.', 'a.md');
    acc.addBody('Coffee again. Coffee always.', 'b.md');
    expect(acc.finish().find((i) => i.value === 'Coffee')).toBeUndefined();
  });

  it('surfaces a single-word term when it appears mid-sentence', () => {
    const acc = new FrequentTermAccumulator(emptyIndex, { minMentions: 2, minNotes: 2 });
    acc.addBody('we love Kubernetes a lot, and also Kubernetes elsewhere.', 'a.md');
    acc.addBody('we use Kubernetes daily, plus Kubernetes again.', 'b.md');
    expect(acc.finish().find((i) => i.value === 'Kubernetes')).toBeDefined();
  });

  it('never marks any surfaced issue auto-fixable', () => {
    const acc = new FrequentTermAccumulator(emptyIndex);
    acc.addBody('Rust Foundation. Rust Foundation. Rust Foundation. Rust Foundation.', 'a.md');
    acc.addBody('Rust Foundation again.', 'b.md');
    for (const issue of acc.finish()) {
      expect(issue.autoFixable).toBe(false);
    }
  });

  it('exposes sensible documented defaults', () => {
    expect(FREQUENT_TERM_DEFAULTS.minMentions).toBe(4);
    expect(FREQUENT_TERM_DEFAULTS.minNotes).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// End-to-end through runAudit (filesystem)
// ---------------------------------------------------------------------------

describe('frequent-unlinked-term: runAudit integration', () => {
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), 'bwrb-fut-'));
    await mkdir(join(vaultDir, '.bwrb'), { recursive: true });
    await writeFile(join(vaultDir, '.bwrb', 'schema.json'), JSON.stringify(SCHEMA, null, 2));
    await mkdir(join(vaultDir, 'Notes'), { recursive: true });
  });

  afterEach(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  it('emits a vault-wide result for a frequent unlinked term', async () => {
    await writeFile(
      join(vaultDir, 'Notes', 'a.md'),
      '---\ntype: note\n---\nI keep mentioning Project Phoenix. Project Phoenix is big.\n'
    );
    await writeFile(
      join(vaultDir, 'Notes', 'b.md'),
      '---\ntype: note\n---\nMore on Project Phoenix. Project Phoenix forever.\n'
    );

    const schemaLoaded = await loadSchema(vaultDir);
    const results = await runAudit(schemaLoaded, vaultDir, {
      strict: false,
      onlyIssue: 'frequent-unlinked-term',
      vaultDir,
      schema: schemaLoaded,
    });

    const allIssues = results.flatMap((r) => r.issues);
    const phoenix = allIssues.find((i) => i.value === 'Project Phoenix');
    expect(phoenix).toBeDefined();
    expect(phoenix?.code).toBe('frequent-unlinked-term');
    expect(phoenix?.autoFixable).toBe(false);
  });

  it('does not surface a term once a note exists for it', async () => {
    await mkdir(join(vaultDir, 'People'), { recursive: true });
    await writeFile(
      join(vaultDir, 'People', 'Project Phoenix.md'),
      '---\ntype: person\n---\n'
    );
    await writeFile(
      join(vaultDir, 'Notes', 'a.md'),
      '---\ntype: note\n---\nMentioning Project Phoenix. Project Phoenix here.\n'
    );
    await writeFile(
      join(vaultDir, 'Notes', 'b.md'),
      '---\ntype: note\n---\nMore Project Phoenix. Project Phoenix again.\n'
    );

    const schemaLoaded = await loadSchema(vaultDir);
    const results = await runAudit(schemaLoaded, vaultDir, {
      strict: false,
      onlyIssue: 'frequent-unlinked-term',
      vaultDir,
      schema: schemaLoaded,
    });

    const allIssues = results.flatMap((r) => r.issues);
    expect(allIssues.find((i) => i.value === 'Project Phoenix')).toBeUndefined();
  });
});
