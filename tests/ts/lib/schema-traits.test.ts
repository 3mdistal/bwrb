import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadSchema,
  getFieldsForType,
  getFieldsByOrigin,
  getType,
  getTraitNames,
} from '../../../src/lib/schema.js';

/**
 * Coverage for schema traits (#442): reusable field bundles composed into a type
 * alongside `extends` inheritance.
 *
 * Precedence implemented and asserted here (highest wins):
 *   own type fields > traits (later trait in array wins) > inherited (parent chain)
 */

async function loadFromSchema(schema: unknown) {
  const tempDir = await mkdtemp(join(tmpdir(), 'bwrb-traits-test-'));
  await mkdir(join(tempDir, '.bwrb'), { recursive: true });
  await writeFile(join(tempDir, '.bwrb/schema.json'), JSON.stringify(schema));
  try {
    return await loadSchema(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

describe('schema traits', () => {
  it('composes a trait\'s fields into a type', async () => {
    const loaded = await loadFromSchema({
      version: 2,
      traits: {
        actionable: {
          fields: {
            status: { prompt: 'select', options: ['inbox', 'next', 'done'] },
            due: { prompt: 'date' },
          },
        },
      },
      types: {
        task: { traits: ['actionable'], fields: { title: { prompt: 'text' } } },
      },
    });

    const fields = getFieldsForType(loaded, 'task');
    expect(Object.keys(fields).sort()).toEqual(['due', 'status', 'title']);
    expect(fields.status?.options).toEqual(['inbox', 'next', 'done']);
  });

  it('composes multiple traits into one type', async () => {
    const loaded = await loadFromSchema({
      version: 2,
      traits: {
        actionable: { fields: { status: { prompt: 'text' } } },
        ratable: { fields: { rating: { prompt: 'number' } } },
      },
      types: {
        task: { traits: ['actionable', 'ratable'] },
      },
    });

    const fields = getFieldsForType(loaded, 'task');
    expect(Object.keys(fields).sort()).toEqual(['rating', 'status']);
  });

  it('records composed trait names on the resolved type', async () => {
    const loaded = await loadFromSchema({
      version: 2,
      traits: { actionable: { fields: { status: { prompt: 'text' } } } },
      types: { task: { traits: ['actionable'] } },
    });
    expect(getType(loaded, 'task')?.traits).toEqual(['actionable']);
    expect(getTraitNames(loaded)).toEqual(['actionable']);
  });

  describe('precedence', () => {
    it('own type field overrides a trait field of the same name', async () => {
      const loaded = await loadFromSchema({
        version: 2,
        traits: {
          actionable: { fields: { status: { prompt: 'text', label: 'from-trait' } } },
        },
        types: {
          // Own `status` carries a `value`, which is one of the allowed overrides;
          // the merged field keeps the trait base but takes the own value.
          task: {
            traits: ['actionable'],
            fields: { status: { value: 'own-value' } },
          },
        },
      });
      const status = getFieldsForType(loaded, 'task').status;
      expect(status?.value).toBe('own-value');
      // The field is attributed to the type's own fields, not the trait.
      const byOrigin = getFieldsByOrigin(loaded, 'task');
      expect(Object.keys(byOrigin.ownFields)).toContain('status');
      expect(byOrigin.traitFields.get('actionable')).toBeUndefined();
    });

    it('a trait field overrides an inherited field of the same name', async () => {
      const loaded = await loadFromSchema({
        version: 2,
        traits: {
          actionable: { fields: { status: { prompt: 'select', options: ['next'] } } },
        },
        types: {
          base: { fields: { status: { prompt: 'text' } } },
          task: { extends: 'base', traits: ['actionable'] },
        },
      });
      const status = getFieldsForType(loaded, 'task').status;
      expect(status?.prompt).toBe('select');
      expect(status?.options).toEqual(['next']);

      const byOrigin = getFieldsByOrigin(loaded, 'task');
      // Field is attributed to the trait, not the inherited base.
      expect(byOrigin.traitFields.get('actionable')).toHaveProperty('status');
      expect(byOrigin.inheritedFields.get('base')).toBeUndefined();
    });

    it('a later trait in the array wins over an earlier one', async () => {
      const loaded = await loadFromSchema({
        version: 2,
        traits: {
          first: { fields: { status: { prompt: 'text', label: 'first' } } },
          second: { fields: { status: { prompt: 'select', label: 'second', options: ['a'] } } },
        },
        types: {
          task: { traits: ['first', 'second'] },
        },
      });
      const status = getFieldsForType(loaded, 'task').status;
      expect(status?.prompt).toBe('select');
      expect(status?.label).toBe('second');

      const byOrigin = getFieldsByOrigin(loaded, 'task');
      // Attributed to the winning (later) trait only.
      expect(byOrigin.traitFields.get('second')).toHaveProperty('status');
      expect(byOrigin.traitFields.get('first')).toBeUndefined();
    });
  });

  describe('field ordering', () => {
    it('orders fields inherited -> trait -> own when no explicit order', async () => {
      const loaded = await loadFromSchema({
        version: 2,
        traits: {
          actionable: { fields: { status: { prompt: 'text' }, due: { prompt: 'date' } } },
        },
        types: {
          base: { fields: { inheritedField: { prompt: 'text' } } },
          task: {
            extends: 'base',
            traits: ['actionable'],
            fields: { ownField: { prompt: 'text' } },
          },
        },
      });
      const order = getType(loaded, 'task')!.fieldOrder;
      expect(order).toEqual(['inheritedField', 'status', 'due', 'ownField']);
    });
  });

  describe('validation', () => {
    it('errors when a type composes an unknown trait', async () => {
      await expect(
        loadFromSchema({
          version: 2,
          traits: { actionable: { fields: { status: { prompt: 'text' } } } },
          types: { task: { traits: ['missing'] } },
        })
      ).rejects.toThrow(/unknown trait "missing"/);
    });

    it('errors helpfully when no traits are declared at all', async () => {
      await expect(
        loadFromSchema({
          version: 2,
          types: { task: { traits: ['actionable'] } },
        })
      ).rejects.toThrow(/No traits are declared/);
    });
  });

  describe('back-compat', () => {
    it('resolves a schema with no traits exactly as before', async () => {
      const loaded = await loadFromSchema({
        version: 2,
        types: {
          base: { fields: { status: { prompt: 'text' } } },
          task: { extends: 'base', fields: { title: { prompt: 'text' } } },
        },
      });
      const fields = getFieldsForType(loaded, 'task');
      expect(Object.keys(fields).sort()).toEqual(['status', 'title']);
      expect(getType(loaded, 'task')?.traits).toEqual([]);
      expect(getTraitNames(loaded)).toEqual([]);

      const byOrigin = getFieldsByOrigin(loaded, 'task');
      expect(byOrigin.traitFields.size).toBe(0);
    });
  });
});
