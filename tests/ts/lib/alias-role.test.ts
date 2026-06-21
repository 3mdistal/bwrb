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

    it('relation/link target index resolves an alias to the entity path', async () => {
      const schema = await loadSchema(vaultDir);
      const targetIndex = await buildNoteTargetIndex(schema, vaultDir);

      expect(targetIndex.targetToPaths.get('Steve')).toContain('People/Steve Yegge.md');
      expect(targetIndex.targetToPaths.get('stevey')).toContain('People/Steve Yegge.md');
      // The canonical name still resolves.
      expect(targetIndex.targetToPaths.get('Steve Yegge')).toContain('People/Steve Yegge.md');
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
});
