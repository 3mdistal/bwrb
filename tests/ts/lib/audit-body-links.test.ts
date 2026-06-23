import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm, mkdtemp } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadSchema } from '../../../src/lib/schema.js';
import { runAudit } from '../../../src/lib/audit/detection.js';
import {
  detectBodyWikilinks,
  detectBodyFileLinks,
} from '../../../src/lib/audit/body-links.js';
import { deriveNoteTargetIndex } from '../../../src/lib/discovery.js';
import type { VaultNoteSnapshot } from '../../../src/lib/discovery.js';
import type { Schema } from '../../../src/types/schema.js';

// ---------------------------------------------------------------------------
// Unit tests on the pure wikilink detector (no filesystem)
// ---------------------------------------------------------------------------

/** Build a tiny note-target index from a list of vault-relative note paths. */
function indexFor(paths: string[]) {
  const snapshot: VaultNoteSnapshot = {
    notes: paths.map((relativePath) => ({ relativePath, path: relativePath })),
  };
  return deriveNoteTargetIndex(snapshot);
}

describe('body-links: detectBodyWikilinks', () => {
  const index = indexFor(['Notes/RealNote.md', 'People/Steve Yegge.md']);

  it('flags a wikilink that resolves to no note', () => {
    const issues = detectBodyWikilinks('See [[Nonexistent]] for more.', index);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe('broken-body-wikilink');
    expect(issues[0]!.autoFixable).toBe(false);
    expect(issues[0]!.inBody).toBe(true);
    expect(issues[0]!.lineNumber).toBe(1);
    expect(issues[0]!.targetName).toBe('Nonexistent');
  });

  it('does not flag a valid wikilink', () => {
    const issues = detectBodyWikilinks('Refer to [[RealNote]].', index);
    expect(issues).toHaveLength(0);
  });

  it('resolves case-insensitively', () => {
    const issues = detectBodyWikilinks('[[realnote]] and [[REALNOTE]]', index);
    expect(issues).toHaveLength(0);
  });

  it('resolves a display-aliased and heading-suffixed wikilink', () => {
    const issues = detectBodyWikilinks(
      '[[RealNote|some text]] and [[RealNote#A Heading]]',
      index
    );
    expect(issues).toHaveLength(0);
  });

  it('flags a broken wikilink that has a display alias', () => {
    const issues = detectBodyWikilinks('[[Nope|display]]', index);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe('broken-body-wikilink');
    expect(issues[0]!.targetName).toBe('Nope');
  });

  it('offers a fuzzy "did you mean?" hint with the canonical-case filename', () => {
    const issues = detectBodyWikilinks('[[RealNotee]]', index);
    expect(issues).toHaveLength(1);
    // The hint must surface the real-case basename ('RealNote'), not the
    // lowercased index key ('realnote').
    expect(issues[0]!.similarFiles).toContain('RealNote');
    expect(issues[0]!.similarFiles).not.toContain('realnote');
    expect(issues[0]!.suggestion).toContain('[[RealNote]]');
    expect(issues[0]!.suggestion).toContain('Did you mean');
  });

  it('flags an empty wikilink target as malformed', () => {
    const empty = detectBodyWikilinks('[[]]', index);
    expect(empty).toHaveLength(1);
    expect(empty[0]!.code).toBe('malformed-body-wikilink');

    const whitespace = detectBodyWikilinks('[[   ]]', index);
    expect(whitespace).toHaveLength(1);
    expect(whitespace[0]!.code).toBe('malformed-body-wikilink');
  });

  it('flags an unclosed wikilink', () => {
    const issues = detectBodyWikilinks('A [[Dangling link here\n', index);
    expect(issues.some((i) => i.code === 'malformed-body-wikilink')).toBe(true);
  });

  it('does not flag wikilinks inside a fenced code block', () => {
    const body = '```\n[[Nonexistent]]\n[[]]\n```\nDone.';
    expect(detectBodyWikilinks(body, index)).toHaveLength(0);
  });

  it('does not flag wikilinks inside inline code', () => {
    const body = 'Use `[[Nonexistent]]` syntax.';
    expect(detectBodyWikilinks(body, index)).toHaveLength(0);
  });

  it('reports the correct line number', () => {
    const body = 'line 1\nline 2\n[[Nonexistent]]\n';
    const issues = detectBodyWikilinks(body, index);
    expect(issues[0]!.lineNumber).toBe(3);
  });

  it('does not flag an ambiguous (multi-match) wikilink as broken', () => {
    // Two notes collapse to the same lowercased key -> ambiguous but valid.
    const ambiguousIndex = indexFor(['A/Topic.md', 'B/topic.md']);
    const issues = detectBodyWikilinks('[[Topic]]', ambiguousIndex);
    expect(issues.some((i) => i.code === 'broken-body-wikilink')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit tests on the pure file/image link detector (real temp files)
// ---------------------------------------------------------------------------

describe('body-links: detectBodyFileLinks', () => {
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), 'bwrb-body-links-'));
    await mkdir(join(vaultDir, 'Notes', 'assets'), { recursive: true });
    await writeFile(join(vaultDir, 'Notes', 'exists.md'), 'x');
    await writeFile(join(vaultDir, 'Notes', 'assets', 'pic.png'), 'x');
  });

  afterEach(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  it('flags a broken relative file link', () => {
    const issues = detectBodyFileLinks(
      'See [doc](missing.md).',
      'Notes/Source.md',
      vaultDir
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe('broken-body-file-link');
    expect(issues[0]!.autoFixable).toBe(false);
  });

  it('flags a broken relative image link', () => {
    const issues = detectBodyFileLinks(
      '![alt](missing.png)',
      'Notes/Source.md',
      vaultDir
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe('broken-body-file-link');
    expect(issues[0]!.meta?.['isImage']).toBe(true);
  });

  it('does not flag a valid relative file link', () => {
    const issues = detectBodyFileLinks(
      '[doc](exists.md) and ![pic](assets/pic.png)',
      'Notes/Source.md',
      vaultDir
    );
    expect(issues).toHaveLength(0);
  });

  it('does not flag external URLs', () => {
    const body =
      '[site](https://example.com) [m](mailto:a@b.com) [a](#section) [p](//cdn.example.com/x.png)';
    expect(detectBodyFileLinks(body, 'Notes/Source.md', vaultDir)).toHaveLength(0);
  });

  it('does not flag file links inside a fenced code block', () => {
    const body = '```\n[doc](missing.md)\n```';
    expect(detectBodyFileLinks(body, 'Notes/Source.md', vaultDir)).toHaveLength(0);
  });

  it('handles percent-encoded spaces in the path', () => {
    return writeFile(join(vaultDir, 'Notes', 'a b.md'), 'x').then(() => {
      const issues = detectBodyFileLinks(
        '[doc](a%20b.md)',
        'Notes/Source.md',
        vaultDir
      );
      expect(issues).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// End-to-end audit on a real vault
// ---------------------------------------------------------------------------

const SCHEMA: Schema = {
  version: 2,
  types: {
    meta: { fields: {} },
    note: {
      extends: 'meta',
      output_dir: 'Notes',
      fields: { type: { value: 'note' } },
      field_order: ['type'],
    },
  },
};

describe('body-links: end-to-end audit', () => {
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), 'bwrb-body-links-e2e-'));
    await mkdir(join(vaultDir, '.bwrb'), { recursive: true });
    await writeFile(
      join(vaultDir, '.bwrb', 'schema.json'),
      JSON.stringify(SCHEMA, null, 2)
    );
    await mkdir(join(vaultDir, 'Notes'), { recursive: true });
  });

  afterEach(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  it('flags broken body wikilinks and file links across a real run', async () => {
    await writeFile(
      join(vaultDir, 'Notes', 'Real.md'),
      `---\ntype: note\n---\nI exist.\n`
    );
    await writeFile(
      join(vaultDir, 'Notes', 'Source.md'),
      `---\ntype: note\n---\nGood [[Real]]. Bad [[Ghost]].\nBroken [doc](missing.md).\nExternal [x](https://example.com).\n`
    );
    const schema = await loadSchema(vaultDir);
    const results = await runAudit(schema, vaultDir, { strict: false });
    const src = results.find((r) => r.relativePath === 'Notes/Source.md');

    const broken = src?.issues.filter((i) => i.code === 'broken-body-wikilink') ?? [];
    expect(broken).toHaveLength(1);
    expect(broken[0]!.targetName).toBe('Ghost');

    const fileLinks = src?.issues.filter((i) => i.code === 'broken-body-file-link') ?? [];
    expect(fileLinks).toHaveLength(1);

    // Valid [[Real]] and external URL produced no findings.
    expect(src?.issues.some((i) => i.value === '[[Real]]')).toBeFalsy();
  });

  it('only-filter scopes the run to broken-body-wikilink', async () => {
    await writeFile(
      join(vaultDir, 'Notes', 'Source.md'),
      `---\ntype: note\n---\n[[Ghost]] and [doc](missing.md)\n`
    );
    const schema = await loadSchema(vaultDir);
    const results = await runAudit(schema, vaultDir, {
      strict: false,
      onlyIssue: 'broken-body-wikilink',
    });
    for (const r of results) {
      for (const i of r.issues) {
        expect(i.code).toBe('broken-body-wikilink');
      }
    }
  });

  it('ignore-filter suppresses broken-body-file-link', async () => {
    await writeFile(
      join(vaultDir, 'Notes', 'Source.md'),
      `---\ntype: note\n---\n[doc](missing.md)\n`
    );
    const schema = await loadSchema(vaultDir);
    const results = await runAudit(schema, vaultDir, {
      strict: false,
      ignoreIssue: 'broken-body-file-link',
    });
    const src = results.find((r) => r.relativePath === 'Notes/Source.md');
    expect(src?.issues.some((i) => i.code === 'broken-body-file-link')).toBeFalsy();
  });

  // ---------------------------------------------------------------------------
  // #680 regression: a Source note containing ALL THREE body-link issue codes.
  // `--ignore <one body-link code>` must suppress ONLY that code; the other two
  // must STILL report (they share one detection pass, so the bug was the outer
  // gate skipping the whole block when any one code was ignored).
  // ---------------------------------------------------------------------------
  const ALL_THREE: Array<
    'broken-body-wikilink' | 'malformed-body-wikilink' | 'broken-body-file-link'
  > = ['broken-body-wikilink', 'malformed-body-wikilink', 'broken-body-file-link'];

  async function writeSourceWithAllThree() {
    // [[Ghost]] -> broken-body-wikilink; [[]] -> malformed-body-wikilink;
    // [doc](missing.md) -> broken-body-file-link.
    await writeFile(
      join(vaultDir, 'Notes', 'Source.md'),
      `---\ntype: note\n---\nBroken [[Ghost]].\nMalformed [[]].\nFile [doc](missing.md).\n`
    );
  }

  it('sanity: an unfiltered run reports all three body-link codes', async () => {
    await writeSourceWithAllThree();
    const schema = await loadSchema(vaultDir);
    const results = await runAudit(schema, vaultDir, { strict: false });
    const src = results.find((r) => r.relativePath === 'Notes/Source.md');
    const codes = new Set(src?.issues.map((i) => i.code) ?? []);
    for (const code of ALL_THREE) {
      expect(codes.has(code)).toBe(true);
    }
  });

  for (const ignored of ALL_THREE) {
    it(`--ignore ${ignored} suppresses only that code; the other two still report`, async () => {
      await writeSourceWithAllThree();
      const schema = await loadSchema(vaultDir);
      const results = await runAudit(schema, vaultDir, {
        strict: false,
        ignoreIssue: ignored,
      });
      const src = results.find((r) => r.relativePath === 'Notes/Source.md');
      const codes = new Set(src?.issues.map((i) => i.code) ?? []);

      // The ignored code is gone.
      expect(codes.has(ignored)).toBe(false);
      // The other two body-link codes STILL report.
      for (const code of ALL_THREE) {
        if (code === ignored) continue;
        expect(codes.has(code)).toBe(true);
      }
    });
  }

  for (const only of ALL_THREE) {
    it(`--only ${only} runs body links and reports just that code`, async () => {
      await writeSourceWithAllThree();
      const schema = await loadSchema(vaultDir);
      const results = await runAudit(schema, vaultDir, {
        strict: false,
        onlyIssue: only,
      });
      const src = results.find((r) => r.relativePath === 'Notes/Source.md');
      const codes = src?.issues.map((i) => i.code) ?? [];

      expect(codes.length).toBeGreaterThan(0);
      for (const code of codes) {
        expect(code).toBe(only);
      }
    });
  }
});
