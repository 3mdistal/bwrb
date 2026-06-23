/**
 * Unit tests for `bwrb edit`'s add-missing-sections tree-walk (#697).
 *
 * `edit`'s add-sections flow must recurse the full `body_sections` tree (like
 * the audit `missing-body-section` detector) so a declared nested CHILD heading
 * is added even when its PARENT heading already exists. These tests pin the pure
 * helpers (`collectMissingBodySections` / `appendBodySection`) that the
 * interactive flow is built on, plus the edit<->audit agreement guarantee.
 */

import { describe, it, expect } from 'vitest';
import {
  collectMissingBodySections,
  appendBodySection,
} from '../../../src/lib/edit.js';
import { detectMissingBodySections } from '../../../src/lib/audit/body-sections.js';
import type { BodySection } from '../../../src/types/schema.js';

const NESTED: BodySection[] = [
  {
    title: 'Plan',
    level: 2,
    content_type: 'paragraphs',
    children: [
      { title: 'Risks', level: 3, content_type: 'bullets' },
      { title: 'Mitigations', level: 3, content_type: 'bullets' },
    ],
  },
  { title: 'Notes', level: 2, content_type: 'paragraphs' },
];

/** Apply every still-missing section to the body, mirroring the interactive
 * loop's "yes to all" path (re-checking against the growing body). */
function addAll(body: string, sections: BodySection[]): string {
  let out = body;
  for (const { section } of collectMissingBodySections(out, sections)) {
    out = appendBodySection(out, section);
  }
  return out;
}

describe('edit add-sections: collectMissingBodySections', () => {
  it('adds a missing nested CHILD when its parent is already present (#697)', () => {
    // Parent "## Plan" is present; declared children are missing.
    const body = '## Plan\n\nThe plan.\n\n## Notes\n\nstuff\n';
    const missing = collectMissingBodySections(body, NESTED);
    expect(missing.map((m) => m.title)).toEqual(['Risks', 'Mitigations']);
    expect(missing.map((m) => m.level)).toEqual([3, 3]);
  });

  it('adds nothing for a fully-present note (idempotent candidate set)', () => {
    const body =
      '## Plan\n\nThe plan.\n\n### Risks\n\n- \n\n### Mitigations\n\n- \n\n## Notes\n\nstuff\n';
    expect(collectMissingBodySections(body, NESTED)).toHaveLength(0);
  });

  it('still reports missing TOP-LEVEL sections (behavior unchanged)', () => {
    const body = '## Plan\n\nThe plan.\n\n### Risks\n\n- \n\n### Mitigations\n\n- \n';
    expect(collectMissingBodySections(body, NESTED).map((m) => m.title)).toEqual(['Notes']);
  });

  it('does not re-report present headings with trailing ws / closing hashes', () => {
    const body =
      '## Plan  \n\n### Risks ##\n\n### Mitigations ###  \n\n## Notes\t\n';
    expect(collectMissingBodySections(body, NESTED)).toHaveLength(0);
  });

  it('treats a code-fenced heading as missing', () => {
    const body = '## Plan\n\n```\n### Risks\n```\n\n### Mitigations\n\n- \n\n## Notes\n\nx\n';
    expect(collectMissingBodySections(body, NESTED).map((m) => m.title)).toEqual(['Risks']);
  });
});

describe('edit add-sections: appendBodySection', () => {
  it('appends a child heading at its declared level without children', () => {
    const body = '## Plan\n\nThe plan.\n';
    const child = NESTED[0]!.children![0]!; // Risks, level 3
    const out = appendBodySection(body, child);
    expect(out).toContain('### Risks');
    expect(out).not.toContain('### Mitigations'); // siblings not pulled in
    // Existing content preserved.
    expect(out).toContain('## Plan');
    expect(out).toContain('The plan.');
  });

  it('is idempotent end-to-end: re-running adds nothing and never duplicates', () => {
    const start = '## Plan\n\nThe plan.\n\n## Notes\n\nstuff\n';
    const once = addAll(start, NESTED);
    expect(once).toContain('### Risks');
    expect(once).toContain('### Mitigations');
    const twice = addAll(once, NESTED);
    expect(twice).toBe(once);
    expect(twice.match(/### Risks/g)).toHaveLength(1);
    expect(twice.match(/### Mitigations/g)).toHaveLength(1);
  });
});

describe('edit add-sections <-> audit agreement (#697)', () => {
  const cases: Array<{ name: string; body: string; sections: BodySection[] }> = [
    { name: 'present parent, missing children', body: '## Plan\n\nx\n\n## Notes\n\ny\n', sections: NESTED },
    { name: 'empty body', body: '', sections: NESTED },
    { name: 'fully present', body: '## Plan\n\n### Risks\n\n### Mitigations\n\n## Notes\n', sections: NESTED },
    { name: 'code-fenced heading', body: '## Plan\n\n```\n### Risks\n```\n\n## Notes\n', sections: NESTED },
  ];

  for (const { name, body, sections } of cases) {
    it(`edit's missing set == audit's missing set: ${name}`, () => {
      const editTitles = collectMissingBodySections(body, sections).map((m) => m.title).sort();
      const auditTitles = detectMissingBodySections(body, sections)
        .map((i) => i.meta?.['title'] as string)
        .sort();
      expect(editTitles).toEqual(auditTitles);
    });
  }
});
