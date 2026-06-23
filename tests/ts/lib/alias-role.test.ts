import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtemp } from 'fs/promises';
import {
  resolveSchema,
  loadSchema,
  getAliasFieldName,
  getEntityAliases,
} from '../../../src/lib/schema.js';
import { validateFrontmatter } from '../../../src/lib/validation.js';
import { buildNoteIndex, resolveNoteQuery } from '../../../src/lib/navigation.js';
import { buildNoteTargetIndex } from '../../../src/lib/discovery.js';
import { runAudit } from '../../../src/lib/audit/detection.js';
import type { Schema } from '../../../src/types/schema.js';

// A schema with a person type whose `aliases` field carries the alias role,
// and a plain note type with no alias field (back-compat coverage).
const ALIAS_SCHEMA: Schema = {
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
      fields: {
        type: { value: 'note' },
      },
      field_order: ['type'],
    },
  },
};

describe('alias field role', () => {
  describe('schema parsing / role detection', () => {
    it('recognizes the field declared with alias: true as the alias role', () => {
      const schema = resolveSchema(ALIAS_SCHEMA);
      expect(getAliasFieldName(schema, 'person')).toBe('aliases');
    });

    it('returns undefined for a type with no alias-role field (back-compat)', () => {
      const schema = resolveSchema(ALIAS_SCHEMA);
      expect(getAliasFieldName(schema, 'note')).toBeUndefined();
    });

    it('honors an inherited alias field', () => {
      const schema = resolveSchema({
        version: 2,
        types: {
          meta: { fields: {} },
          entity: {
            extends: 'meta',
            output_dir: 'Entities',
            fields: { aliases: { prompt: 'list', alias: true } },
          },
          company: { extends: 'entity', output_dir: 'Companies', fields: { type: { value: 'company' } } },
        },
      });
      expect(getAliasFieldName(schema, 'company')).toBe('aliases');
    });
  });

  describe('getEntityAliases', () => {
    const schema = resolveSchema(ALIAS_SCHEMA);

    it('extracts a clean, deduplicated alias list', () => {
      const aliases = getEntityAliases(schema, 'person', {
        type: 'person',
        aliases: ['Steve', 'Steve Yegge', 'stevey'],
      });
      expect(aliases).toEqual(['Steve', 'Steve Yegge', 'stevey']);
    });

    it('trims, drops empties, and dedupes defensively', () => {
      const aliases = getEntityAliases(schema, 'person', {
        type: 'person',
        aliases: ['  Steve  ', '', 'Steve', 'Yegge'],
      });
      expect(aliases).toEqual(['Steve', 'Yegge']);
    });

    it('returns [] for a type with no alias field', () => {
      expect(getEntityAliases(schema, 'note', { type: 'note', aliases: ['x'] })).toEqual([]);
    });

    it('returns [] when the alias field is absent or malformed', () => {
      expect(getEntityAliases(schema, 'person', { type: 'person' })).toEqual([]);
      expect(getEntityAliases(schema, 'person', { type: 'person', aliases: 'Steve' })).toEqual([]);
    });
  });

  describe('alias-format validation', () => {
    const schema = resolveSchema(ALIAS_SCHEMA);

    it('accepts an array of non-empty unique strings', () => {
      const result = validateFrontmatter(schema, 'person', {
        type: 'person',
        aliases: ['Steve', 'Steve Yegge'],
      });
      expect(result.valid).toBe(true);
    });

    it('accepts an absent alias field (optional, back-compat)', () => {
      const result = validateFrontmatter(schema, 'person', { type: 'person' });
      expect(result.valid).toBe(true);
    });

    it('rejects a scalar string instead of an array', () => {
      const result = validateFrontmatter(schema, 'person', {
        type: 'person',
        aliases: 'Steve',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.type === 'invalid_alias')).toBe(true);
    });

    it('rejects empty string entries', () => {
      const result = validateFrontmatter(schema, 'person', {
        type: 'person',
        aliases: ['Steve', ''],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.type === 'invalid_alias')).toBe(true);
    });

    it('rejects non-string entries', () => {
      const result = validateFrontmatter(schema, 'person', {
        type: 'person',
        aliases: ['Steve', 123],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.type === 'invalid_alias')).toBe(true);
    });

    it('rejects duplicate aliases', () => {
      const result = validateFrontmatter(schema, 'person', {
        type: 'person',
        aliases: ['Steve', 'Steve'],
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.type === 'invalid_alias')).toBe(true);
    });
  });

  describe('name resolution and linking via aliases (real vault)', () => {
    let vaultDir: string;

    beforeEach(async () => {
      vaultDir = await mkdtemp(join(tmpdir(), 'bwrb-alias-'));
      await mkdir(join(vaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(vaultDir, '.bwrb', 'schema.json'),
        JSON.stringify(ALIAS_SCHEMA, null, 2)
      );
      await mkdir(join(vaultDir, 'People'), { recursive: true });
      await mkdir(join(vaultDir, 'Notes'), { recursive: true });

      await writeFile(
        join(vaultDir, 'People', 'Steve Yegge.md'),
        `---\ntype: person\naliases:\n  - Steve\n  - stevey\n---\n`
      );
      await writeFile(
        join(vaultDir, 'Notes', 'Plain Note.md'),
        `---\ntype: note\n---\n`
      );
    });

    afterEach(async () => {
      await rm(vaultDir, { recursive: true, force: true });
    });

    it('resolveNoteQuery finds an entity by its alias', async () => {
      const schema = await loadSchema(vaultDir);
      const index = await buildNoteIndex(schema, vaultDir);

      expect(index.byAlias.has('Steve')).toBe(true);

      const result = resolveNoteQuery(index, 'stevey');
      expect(result.exact?.relativePath).toBe('People/Steve Yegge.md');
    });

    it('a real note name wins over an alias of the same string', async () => {
      // Add a real note literally named "Steve".
      await writeFile(join(vaultDir, 'Notes', 'Steve.md'), `---\ntype: note\n---\n`);
      const schema = await loadSchema(vaultDir);
      const index = await buildNoteIndex(schema, vaultDir);

      const result = resolveNoteQuery(index, 'Steve');
      expect(result.exact?.relativePath).toBe('Notes/Steve.md');
    });

    it('a case-variant real note name wins over an alias (#616)', async () => {
      // Real note literally named "steve" (lowercase) and a DIFFERENT entity
      // aliased "Steve" (capital). The real-name-wins guard is case-insensitive,
      // so the alias must NOT shadow the case-variant real note.
      await writeFile(join(vaultDir, 'Notes', 'steve.md'), `---\ntype: note\n---\n`);
      const schema = await loadSchema(vaultDir);
      const index = await buildNoteIndex(schema, vaultDir);

      // The alias "Steve" is never registered, because the real note "steve"
      // wins case-insensitively.
      expect(index.byAlias.has('Steve')).toBe(false);

      // Querying "Steve" resolves to the REAL note via case-insensitive basename
      // matching, never silently to the aliased entity.
      const result = resolveNoteQuery(index, 'Steve');
      expect(result.exact?.relativePath).toBe('Notes/steve.md');
    });

    it('relation/link target index resolves an alias to the entity path', async () => {
      const schema = await loadSchema(vaultDir);
      const targetIndex = await buildNoteTargetIndex(schema, vaultDir);

      // The index is keyed by the lowercased target (case-insensitive
      // resolution, consistent with open/navigation).
      expect(targetIndex.targetToPaths.get('steve')).toContain('People/Steve Yegge.md');
      expect(targetIndex.targetToPaths.get('stevey')).toContain('People/Steve Yegge.md');
      // The canonical name still resolves.
      expect(targetIndex.targetToPaths.get('steve yegge')).toContain('People/Steve Yegge.md');
    });

    it('relation target index: a case-variant real note wins over an alias (#616)', async () => {
      // Real note "steve" (lowercase); "Steve Yegge" is aliased "Steve".
      await writeFile(join(vaultDir, 'Notes', 'steve.md'), `---\ntype: note\n---\n`);
      const schema = await loadSchema(vaultDir);
      const targetIndex = await buildNoteTargetIndex(schema, vaultDir);

      // The lowercased "steve" key is claimed by the REAL note, not the alias of
      // the same string. Audit relation resolution + --fix therefore never bind a
      // `[[Steve]]` reference to the aliased entity — it resolves to the real note.
      expect(targetIndex.targetToPaths.get('steve')).toEqual(['Notes/steve.md']);
      // Other, non-colliding aliases still resolve to the entity.
      expect(targetIndex.targetToPaths.get('stevey')).toContain('People/Steve Yegge.md');
    });

    it('a shared alias across two entities stays ambiguous (no regression)', async () => {
      // A second person also aliased "Steve": genuine ambiguity, never auto-resolved.
      await writeFile(
        join(vaultDir, 'People', 'Steve Jobs.md'),
        `---\ntype: person\naliases:\n  - Steve\n---\n`
      );
      const schema = await loadSchema(vaultDir);
      const index = await buildNoteIndex(schema, vaultDir);

      const result = resolveNoteQuery(index, 'Steve');
      expect(result.exact).toBeNull();
      expect(result.isAmbiguous).toBe(true);
      expect(result.candidates.length).toBe(2);
    });

    it('audit flags empty alias entries (illegal-aliases)', async () => {
      await writeFile(
        join(vaultDir, 'People', 'Bad.md'),
        `---\ntype: person\naliases:\n  - Real\n  - ""\n---\n`
      );
      const schema = await loadSchema(vaultDir);
      const results = await runAudit(schema, vaultDir, { strict: false });
      const bad = results.find((r) => r.relativePath === 'People/Bad.md');
      expect(bad?.issues.some((i) => i.code === 'illegal-aliases')).toBe(true);
    });

    it('audit passes a well-formed aliases note', async () => {
      const schema = await loadSchema(vaultDir);
      const results = await runAudit(schema, vaultDir, { strict: false });
      const steve = results.find((r) => r.relativePath === 'People/Steve Yegge.md');
      // The well-formed note is either omitted (no issues at all) or present
      // without an illegal-aliases issue.
      expect(steve?.issues.some((i) => i.code === 'illegal-aliases') ?? false).toBe(false);
    });
  });

  // End-to-end relation resolution: a relation field reference must resolve
  // through the same case-insensitive rules as open/navigation, so a
  // case-variant `[[Steve]]` resolves to the real `steve` note instead of being
  // reported as a stale reference (#616). The original PR only asserted on index
  // KEYS — these tests run the full audit pipeline.
  describe('case-insensitive relation resolution (real vault)', () => {
    // A `person` type (alias-bearing) plus a `doc` type whose `related` field is
    // a relation, so we can exercise stale-reference / ambiguous-link-target.
    const RELATION_SCHEMA: Schema = {
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
        doc: {
          extends: 'meta',
          output_dir: 'Docs',
          fields: {
            type: { value: 'doc' },
            related: { prompt: 'relation', source: 'any' },
          },
          field_order: ['type', 'related'],
        },
      },
    };

    let vaultDir: string;

    beforeEach(async () => {
      vaultDir = await mkdtemp(join(tmpdir(), 'bwrb-relation-'));
      await mkdir(join(vaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(vaultDir, '.bwrb', 'schema.json'),
        JSON.stringify(RELATION_SCHEMA, null, 2)
      );
      await mkdir(join(vaultDir, 'People'), { recursive: true });
      await mkdir(join(vaultDir, 'Docs'), { recursive: true });
    });

    afterEach(async () => {
      await rm(vaultDir, { recursive: true, force: true });
    });

    const relationIssues = (results: Awaited<ReturnType<typeof runAudit>>, relPath: string) =>
      results.find((r) => r.relativePath === relPath)?.issues ?? [];

    it('[[Steve]] resolves to the real `steve` note, NOT a stale-reference (#616)', async () => {
      // Real note literally named "steve" (lowercase) and a DIFFERENT entity
      // aliased "Steve" (capital). A `[[Steve]]` relation must resolve to the
      // real steve note end-to-end, never flagged stale, never bound to the alias.
      await writeFile(join(vaultDir, 'Docs', 'steve.md'), `---\ntype: doc\n---\n`);
      await writeFile(
        join(vaultDir, 'People', 'Steve Yegge.md'),
        `---\ntype: person\naliases:\n  - Steve\n---\n`
      );
      await writeFile(
        join(vaultDir, 'Docs', 'Ref.md'),
        `---\ntype: doc\nrelated: "[[Steve]]"\n---\n`
      );

      const schema = await loadSchema(vaultDir);
      const results = await runAudit(schema, vaultDir, { strict: false });
      const issues = relationIssues(results, 'Docs/Ref.md');

      expect(issues.some((i) => i.code === 'stale-reference')).toBe(false);
      expect(issues.some((i) => i.code === 'ambiguous-link-target')).toBe(false);
    });

    it('[[CAFÉ]] resolves to the real `café` note via unicode case fold (no stale)', async () => {
      await writeFile(join(vaultDir, 'Docs', 'café.md'), `---\ntype: doc\n---\n`);
      await writeFile(
        join(vaultDir, 'Docs', 'Ref.md'),
        `---\ntype: doc\nrelated: "[[CAFÉ]]"\n---\n`
      );

      const schema = await loadSchema(vaultDir);
      const results = await runAudit(schema, vaultDir, { strict: false });
      const issues = relationIssues(results, 'Docs/Ref.md');

      expect(issues.some((i) => i.code === 'stale-reference')).toBe(false);
      expect(issues.some((i) => i.code === 'ambiguous-link-target')).toBe(false);
    });

    it('genuine case-variant ambiguity (two real notes) surfaces ambiguous-link-target', async () => {
      // Two real notes whose names differ only by case both claim the lowercased
      // key, so `[[Steve]]` is genuinely ambiguous and is never auto-resolved.
      await mkdir(join(vaultDir, 'Docs', 'Sub'), { recursive: true });
      await writeFile(join(vaultDir, 'Docs', 'steve.md'), `---\ntype: doc\n---\n`);
      await writeFile(join(vaultDir, 'Docs', 'Sub', 'Steve.md'), `---\ntype: doc\n---\n`);
      await writeFile(
        join(vaultDir, 'Docs', 'Ref.md'),
        `---\ntype: doc\nrelated: "[[Steve]]"\n---\n`
      );

      const schema = await loadSchema(vaultDir);
      const results = await runAudit(schema, vaultDir, { strict: false });
      const issues = relationIssues(results, 'Docs/Ref.md');

      expect(issues.some((i) => i.code === 'ambiguous-link-target')).toBe(true);
      expect(issues.some((i) => i.code === 'stale-reference')).toBe(false);
    });

    it('a truly-missing target is still a stale-reference', async () => {
      await writeFile(
        join(vaultDir, 'Docs', 'Ref.md'),
        `---\ntype: doc\nrelated: "[[Nonexistent]]"\n---\n`
      );

      const schema = await loadSchema(vaultDir);
      const results = await runAudit(schema, vaultDir, { strict: false });
      const issues = relationIssues(results, 'Docs/Ref.md');

      expect(issues.some((i) => i.code === 'stale-reference')).toBe(true);
    });

    it('an exact-case relation reference still resolves cleanly (no regression)', async () => {
      await writeFile(join(vaultDir, 'Docs', 'Target.md'), `---\ntype: doc\n---\n`);
      await writeFile(
        join(vaultDir, 'Docs', 'Ref.md'),
        `---\ntype: doc\nrelated: "[[Target]]"\n---\n`
      );

      const schema = await loadSchema(vaultDir);
      const results = await runAudit(schema, vaultDir, { strict: false });
      const issues = relationIssues(results, 'Docs/Ref.md');

      expect(issues.some((i) => i.code === 'stale-reference')).toBe(false);
      expect(issues.some((i) => i.code === 'ambiguous-link-target')).toBe(false);
    });
  });
});
