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
import { runAutoFix } from '../../../src/lib/audit/fix.js';
import { parseNote } from '../../../src/lib/frontmatter.js';
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

    it('audit flags empty alias entries (illegal-aliases) as an error', async () => {
      await writeFile(
        join(vaultDir, 'People', 'Bad.md'),
        `---\ntype: person\naliases:\n  - Real\n  - ""\n---\n`
      );
      const schema = await loadSchema(vaultDir);
      const results = await runAudit(schema, vaultDir, { strict: false });
      const bad = results.find((r) => r.relativePath === 'People/Bad.md');
      const issue = bad?.issues.find((i) => i.code === 'illegal-aliases');
      expect(issue).toBeDefined();
      expect(issue?.severity).toBe('error');
      // Empty-only is the safe auto-fix subset.
      expect(issue?.autoFixable).toBe(true);
    });

    it('audit flags DUPLICATE aliases as an illegal-aliases error (not a warning), matching the write path (#617)', async () => {
      await writeFile(
        join(vaultDir, 'People', 'Dup.md'),
        `---\ntype: person\naliases:\n  - Steve\n  - Steve\n---\n`
      );
      const schema = await loadSchema(vaultDir);
      const results = await runAudit(schema, vaultDir, { strict: false });
      const dup = results.find((r) => r.relativePath === 'People/Dup.md');

      // The write path rejects duplicate aliases as a hard error; audit now
      // agrees — it is an `illegal-aliases` ERROR, NOT a `duplicate-list-values`
      // warning.
      const issue = dup?.issues.find((i) => i.code === 'illegal-aliases');
      expect(issue).toBeDefined();
      expect(issue?.severity).toBe('error');
      expect(issue?.autoFixable).toBe(true);
      expect(dup?.issues.some((i) => i.code === 'duplicate-list-values')).toBe(false);
    });

    it('--fix auto-cleans empty/whitespace + duplicate aliases (dedupe, first wins) and is idempotent', async () => {
      await writeFile(
        join(vaultDir, 'People', 'Messy.md'),
        `---\ntype: person\naliases:\n  - Steve\n  - ""\n  - "  "\n  - Steve\n  - stevey\n---\n`
      );
      const schema = await loadSchema(vaultDir);

      const results = await runAudit(schema, vaultDir, { strict: false });
      const messyResult = results.filter((r) => r.relativePath === 'People/Messy.md');
      await runAutoFix(messyResult, schema, vaultDir);

      const fixed = await parseNote(join(vaultDir, 'People', 'Messy.md'));
      // Blanks dropped, duplicate removed, order preserved (first occurrence).
      expect(fixed.frontmatter['aliases']).toEqual(['Steve', 'stevey']);

      // Re-audit: no illegal-aliases issue remains (idempotent).
      const after = await runAudit(schema, vaultDir, { strict: false });
      const messyAfter = after.find((r) => r.relativePath === 'People/Messy.md');
      expect(messyAfter?.issues.some((i) => i.code === 'illegal-aliases') ?? false).toBe(false);

      // Re-running --fix on a clean note changes nothing.
      const reRun = await runAudit(schema, vaultDir, { strict: false });
      await runAutoFix(
        reRun.filter((r) => r.relativePath === 'People/Messy.md'),
        schema,
        vaultDir
      );
      const stable = await parseNote(join(vaultDir, 'People', 'Messy.md'));
      expect(stable.frontmatter['aliases']).toEqual(['Steve', 'stevey']);
    });

    // DEFAULT fix path data-loss regression (#617). These exercise the FULL
    // auto-fix pass (runAudit with NO onlyIssue filter, then runAutoFix), which
    // is where the bug lived: the `illegal-aliases` fixer is correct in
    // isolation, but the generic `invalid-list-element` blank-remover used to
    // CO-FIRE on the same alias field. It removed blanks by original index
    // applied to a shrinking array, so with 2+ leading blanks a stale index
    // deleted a distinct alias ("Real" → silently destroyed) while the run still
    // reported success. The fix makes `illegal-aliases` the sole owner of
    // alias-field list cleanup. The fixture deliberately puts the real alias
    // AFTER the blanks so a regression would catch the data loss.
    describe('default fix path never loses a distinct alias (#617 data-loss regression)', () => {
      const writePerson = async (name: string, yamlAliases: string) => {
        await writeFile(
          join(vaultDir, 'People', `${name}.md`),
          `---\ntype: person\naliases:\n${yamlAliases}---\n`
        );
      };

      // Run the DEFAULT auto-fix pass (all detections, not --only) and return
      // the resulting alias array plus the fix summary.
      const fixDefaultPath = async (name: string) => {
        const schema = await loadSchema(vaultDir);
        const results = await runAudit(schema, vaultDir, { strict: false });
        const summary = await runAutoFix(
          results.filter((r) => r.relativePath === `People/${name}.md`),
          schema,
          vaultDir
        );
        const fixed = await parseNote(join(vaultDir, 'People', `${name}.md`));
        return { aliases: fixed.frontmatter['aliases'], summary, schema };
      };

      it('["", "  ", "Real"] -> ["Real"] (the distinct alias survives), idempotent', async () => {
        // Two LEADING blanks then a real alias: the exact shape that triggered
        // the stale-index data loss under the default path.
        await writePerson('Lead', `  - ""\n  - "  "\n  - Real\n`);

        const { aliases, summary, schema } = await fixDefaultPath('Lead');
        expect(aliases).toEqual(['Real']);
        // Reported success without claiming an inflated/incorrect remaining count.
        expect(summary.remaining).toBe(0);
        expect(summary.fixed).toBeGreaterThan(0);

        // Idempotent: no illegal-aliases issue remains, re-fix is a no-op.
        const after = await runAudit(schema, vaultDir, { strict: false });
        const lead = after.find((r) => r.relativePath === 'People/Lead.md');
        expect(lead?.issues.some((i) => i.code === 'illegal-aliases') ?? false).toBe(false);
        await runAutoFix(
          after.filter((r) => r.relativePath === 'People/Lead.md'),
          schema,
          vaultDir
        );
        const stable = await parseNote(join(vaultDir, 'People', 'Lead.md'));
        expect(stable.frontmatter['aliases']).toEqual(['Real']);
      });

      it('["", ""] -> [] (all blanks removed, no alias to keep)', async () => {
        await writePerson('AllBlank', `  - ""\n  - ""\n`);
        const { aliases, summary } = await fixDefaultPath('AllBlank');
        expect(aliases).toEqual([]);
        expect(summary.remaining).toBe(0);
      });

      it('[A, "", B, "", A] -> [A, B] (blanks dropped AND duplicate deduped, first wins)', async () => {
        await writePerson('Mixed', `  - A\n  - ""\n  - B\n  - ""\n  - A\n`);
        const { aliases, summary, schema } = await fixDefaultPath('Mixed');
        expect(aliases).toEqual(['A', 'B']);
        expect(summary.remaining).toBe(0);

        // Idempotent.
        const after = await runAudit(schema, vaultDir, { strict: false });
        await runAutoFix(
          after.filter((r) => r.relativePath === 'People/Mixed.md'),
          schema,
          vaultDir
        );
        const stable = await parseNote(join(vaultDir, 'People', 'Mixed.md'));
        expect(stable.frontmatter['aliases']).toEqual(['A', 'B']);
      });

      it('only the single illegal-aliases issue fires on an alias field (invalid-list-element is suppressed)', async () => {
        await writePerson('Guard', `  - ""\n  - "  "\n  - Real\n`);
        const schema = await loadSchema(vaultDir);
        const results = await runAudit(schema, vaultDir, { strict: false });
        const guard = results.find((r) => r.relativePath === 'People/Guard.md');
        // The alias-field guard means invalid-list-element must NOT co-fire.
        expect(guard?.issues.some((i) => i.code === 'invalid-list-element')).toBe(false);
        expect(guard?.issues.some((i) => i.code === 'illegal-aliases')).toBe(true);
      });
    });

    it('non-string alias entries are flagged but NOT auto-fixed', async () => {
      // A YAML-numeric alias entry: we cannot infer the intended text, so this
      // stays flag-only (consistent with the write path rejecting it).
      await writeFile(
        join(vaultDir, 'People', 'NumAlias.md'),
        `---\ntype: person\naliases:\n  - Steve\n  - 123\n---\n`
      );
      const schema = await loadSchema(vaultDir);
      const results = await runAudit(schema, vaultDir, { strict: false });
      const num = results.find((r) => r.relativePath === 'People/NumAlias.md');
      const issue = num?.issues.find((i) => i.code === 'illegal-aliases');
      expect(issue).toBeDefined();
      expect(issue?.severity).toBe('error');
      expect(issue?.autoFixable).toBe(false);

      // The illegal-aliases fix must NOT drop or merge the non-string entry — no
      // alias data is lost. (A separate, pre-existing `invalid-list-element`
      // coercion may stringify a bare numeric YAML element, e.g. 123 → "123";
      // either way the entry survives.)
      await runAutoFix(
        results.filter((r) => r.relativePath === 'People/NumAlias.md'),
        schema,
        vaultDir
      );
      const after = await parseNote(join(vaultDir, 'People', 'NumAlias.md'));
      const aliases = after.frontmatter['aliases'] as unknown[];
      expect(aliases).toHaveLength(2);
      expect(aliases[0]).toBe('Steve');
      expect(String(aliases[1])).toBe('123');
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

  // Confirm this PR did NOT change `invalid-list-element` behavior for NON-alias
  // list fields. The alias-field guard added for #617 must be scoped to alias
  // fields only — a plain list field with blanks is still detected and removed
  // by `invalid-list-element` exactly as before (the stale-index bug there is a
  // separate, pre-existing issue tracked elsewhere; we don't assert on its
  // result shape, only that detection still fires and the field is untouched by
  // the alias path).
  describe('non-alias list fields are unaffected by the alias-field guard (#617)', () => {
    const TAG_SCHEMA: Schema = {
      version: 2,
      types: {
        meta: { fields: {} },
        note: {
          extends: 'meta',
          output_dir: 'Notes',
          fields: {
            type: { value: 'note' },
            // A plain (non-alias) list field.
            tags: { prompt: 'list' },
          },
          field_order: ['type', 'tags'],
        },
      },
    };

    let vaultDir: string;

    beforeEach(async () => {
      vaultDir = await mkdtemp(join(tmpdir(), 'bwrb-taglist-'));
      await mkdir(join(vaultDir, '.bwrb'), { recursive: true });
      await writeFile(
        join(vaultDir, '.bwrb', 'schema.json'),
        JSON.stringify(TAG_SCHEMA, null, 2)
      );
      await mkdir(join(vaultDir, 'Notes'), { recursive: true });
    });

    afterEach(async () => {
      await rm(vaultDir, { recursive: true, force: true });
    });

    it('still reports invalid-list-element for a blank entry in a non-alias list', async () => {
      await writeFile(
        join(vaultDir, 'Notes', 'Tagged.md'),
        `---\ntype: note\ntags:\n  - alpha\n  - ""\n  - beta\n---\n`
      );
      const schema = await loadSchema(vaultDir);
      const results = await runAudit(schema, vaultDir, { strict: false });
      const tagged = results.find((r) => r.relativePath === 'Notes/Tagged.md');
      // The non-alias list is NOT guarded — invalid-list-element still fires.
      expect(tagged?.issues.some((i) => i.code === 'invalid-list-element')).toBe(true);
      // And illegal-aliases never applies to a non-alias field.
      expect(tagged?.issues.some((i) => i.code === 'illegal-aliases')).toBe(false);
    });

    // #683 regression: the `invalid-list-element` blank-remover used to splice by
    // ORIGINAL index against a SHRINKING array. With 2+ blanks a later removal
    // used a stale offset and deleted a distinct, non-blank element (data loss).
    // #617 only sidestepped this for ALIAS fields; non-alias lists were still
    // exposed. These tests run the real default auto-fix pass on a non-alias list
    // and assert ONLY blanks are dropped, every distinct value survives in order,
    // and the fix is idempotent — regardless of where the blanks sit.
    describe('blank removal is index-safe on non-alias lists (#683 data loss)', () => {
      const writeNoteFile = async (name: string, yamlTags: string) => {
        await writeFile(
          join(vaultDir, 'Notes', `${name}.md`),
          `---\ntype: note\ntags:\n${yamlTags}---\n`
        );
      };

      // Default auto-fix pass (all detections, not --only); returns the resulting
      // tags array, the fix summary, and the schema for a follow-up re-run.
      const fixDefaultPath = async (name: string) => {
        const schema = await loadSchema(vaultDir);
        const results = await runAudit(schema, vaultDir, { strict: false });
        const summary = await runAutoFix(
          results.filter((r) => r.relativePath === `Notes/${name}.md`),
          schema,
          vaultDir
        );
        const fixed = await parseNote(join(vaultDir, 'Notes', `${name}.md`));
        return { tags: fixed.frontmatter['tags'], summary, schema };
      };

      // Re-run the default fix once more and return the resulting tags — used to
      // assert idempotency.
      const refix = async (name: string, schema: Awaited<ReturnType<typeof loadSchema>>) => {
        const after = await runAudit(schema, vaultDir, { strict: false });
        expect(
          after
            .find((r) => r.relativePath === `Notes/${name}.md`)
            ?.issues.some((i) => i.code === 'invalid-list-element') ?? false
        ).toBe(false);
        await runAutoFix(
          after.filter((r) => r.relativePath === `Notes/${name}.md`),
          schema,
          vaultDir
        );
        const stable = await parseNote(join(vaultDir, 'Notes', `${name}.md`));
        return stable.frontmatter['tags'];
      };

      it('["", "  ", "Real"] -> ["Real"] (the exact regression: distinct value survives)', async () => {
        // Two LEADING blanks then a real value — the shape that triggered the
        // stale-index data loss. The naive splice-by-original-index would delete
        // "Real" here.
        await writeNoteFile('Lead', `  - ""\n  - "  "\n  - Real\n`);
        const { tags, schema } = await fixDefaultPath('Lead');
        expect(tags).toEqual(['Real']);
        expect(await refix('Lead', schema)).toEqual(['Real']);
      });

      it('["", ""] -> [] (all blanks removed)', async () => {
        await writeNoteFile('AllBlank', `  - ""\n  - ""\n`);
        const { tags, schema } = await fixDefaultPath('AllBlank');
        expect(tags).toEqual([]);
        expect(await refix('AllBlank', schema)).toEqual([]);
      });

      it('[A, "", B, "", C] -> [A, B, C] (interleaved blanks, all distinct values kept)', async () => {
        await writeNoteFile('Inter', `  - A\n  - ""\n  - B\n  - ""\n  - C\n`);
        const { tags, schema } = await fixDefaultPath('Inter');
        expect(tags).toEqual(['A', 'B', 'C']);
        expect(await refix('Inter', schema)).toEqual(['A', 'B', 'C']);
      });

      it('[Real, "", ""] -> [Real] (trailing blanks)', async () => {
        await writeNoteFile('Trail', `  - Real\n  - ""\n  - ""\n`);
        const { tags, schema } = await fixDefaultPath('Trail');
        expect(tags).toEqual(['Real']);
        expect(await refix('Trail', schema)).toEqual(['Real']);
      });

      it('["", Real, ""] -> [Real] (surrounding blanks)', async () => {
        await writeNoteFile('Around', `  - ""\n  - Real\n  - ""\n`);
        const { tags, schema } = await fixDefaultPath('Around');
        expect(tags).toEqual(['Real']);
        expect(await refix('Around', schema)).toEqual(['Real']);
      });
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
