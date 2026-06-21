import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadSchema,
  getFieldsForType,
  getFieldsByOrigin,
  getOptionsForField,
  getType,
  getTraitNames,
} from '../../../src/lib/schema.js';
import { validateSelectOptionValue } from '../../../src/lib/validation.js';

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

    it('own field FULLY overrides a trait field on options/label/prompt', async () => {
      const loaded = await loadFromSchema({
        version: 2,
        traits: {
          actionable: {
            fields: {
              status: {
                prompt: 'select',
                label: 'from-trait',
                options: ['trait-only'],
              },
            },
          },
        },
        types: {
          task: {
            traits: ['actionable'],
            fields: {
              status: {
                prompt: 'select',
                label: 'from-own',
                options: ['own-a', 'own-b'],
              },
            },
          },
        },
      });

      const status = getFieldsForType(loaded, 'task').status;
      // Own wins on EVERY key, not just default/value/description/granularity.
      expect(status?.label).toBe('from-own');
      expect(status?.options).toEqual(['own-a', 'own-b']);
      expect(status?.prompt).toBe('select');

      // Validation uses own's options: own values accepted, trait's rejected.
      const allowed = getOptionsForField(loaded, 'task', 'status');
      expect(allowed).toEqual(['own-a', 'own-b']);
      expect(validateSelectOptionValue('own-a', allowed)).toBeNull();
      expect(validateSelectOptionValue('trait-only', allowed)).not.toBeNull();

      // Provenance: returned object is own's full definition, attributed to own.
      const byOrigin = getFieldsByOrigin(loaded, 'task');
      expect(byOrigin.ownFields.status?.label).toBe('from-own');
      expect(byOrigin.ownFields.status?.options).toEqual(['own-a', 'own-b']);
      expect(byOrigin.traitFields.get('actionable')).toBeUndefined();
    });

    it('full layering parent + trait + own: own fully wins, NO trait leak', async () => {
      const loaded = await loadFromSchema({
        version: 2,
        traits: {
          actionable: {
            fields: {
              status: {
                prompt: 'select',
                label: 'from-trait',
                options: ['trait-x'],
              },
            },
          },
        },
        types: {
          base: {
            fields: {
              status: { prompt: 'text', label: 'from-parent' },
            },
          },
          task: {
            extends: 'base',
            traits: ['actionable'],
            fields: {
              status: {
                prompt: 'select',
                label: 'from-own',
                options: ['own-x'],
              },
            },
          },
        },
      });

      const status = getFieldsForType(loaded, 'task').status;
      // Own's label present; neither trait's nor parent's leaks through.
      expect(status?.label).toBe('from-own');
      expect(status?.options).toEqual(['own-x']);
      expect(status?.label).not.toBe('from-trait');
      expect(status?.label).not.toBe('from-parent');

      const allowed = getOptionsForField(loaded, 'task', 'status');
      expect(validateSelectOptionValue('own-x', allowed)).toBeNull();
      expect(validateSelectOptionValue('trait-x', allowed)).not.toBeNull();

      const byOrigin = getFieldsByOrigin(loaded, 'task');
      expect(byOrigin.ownFields.status?.label).toBe('from-own');
      expect(byOrigin.traitFields.get('actionable')).toBeUndefined();
      expect(byOrigin.inheritedFields.get('base')).toBeUndefined();
    });

    it('a trait FULLY overrides an inherited field on options/prompt (not just default)', async () => {
      const loaded = await loadFromSchema({
        version: 2,
        traits: {
          actionable: {
            fields: {
              status: {
                prompt: 'select',
                label: 'from-trait',
                options: ['trait-a', 'trait-b'],
              },
            },
          },
        },
        types: {
          base: {
            fields: {
              status: { prompt: 'text', label: 'from-parent' },
            },
          },
          task: { extends: 'base', traits: ['actionable'] },
        },
      });

      const status = getFieldsForType(loaded, 'task').status;
      // Trait wins on every key; the inherited `text`/label is gone.
      expect(status?.prompt).toBe('select');
      expect(status?.label).toBe('from-trait');
      expect(status?.options).toEqual(['trait-a', 'trait-b']);

      const allowed = getOptionsForField(loaded, 'task', 'status');
      expect(validateSelectOptionValue('trait-a', allowed)).toBeNull();

      const byOrigin = getFieldsByOrigin(loaded, 'task');
      expect(byOrigin.traitFields.get('actionable')?.status?.label).toBe('from-trait');
      expect(byOrigin.inheritedFields.get('base')).toBeUndefined();
    });

    it('own-vs-parent (no trait) keeps the restricted merge', async () => {
      const loaded = await loadFromSchema({
        version: 2,
        types: {
          base: {
            fields: {
              status: {
                prompt: 'select',
                label: 'from-parent',
                options: ['parent-a', 'parent-b'],
              },
            },
          },
          // Own carries a structural key (options) AND restricted keys; only the
          // restricted keys should merge — structural stays inherited.
          task: {
            extends: 'base',
            fields: {
              status: {
                default: 'parent-a',
                description: 'own-doc',
                options: ['own-only'],
                label: 'from-own',
              },
            },
          },
        },
      });

      const status = getFieldsForType(loaded, 'task').status;
      // Restricted keys merge from own...
      expect(status?.default).toBe('parent-a');
      expect(status?.description).toBe('own-doc');
      // ...but structural keys (options/label/prompt) stay inherited.
      expect(status?.options).toEqual(['parent-a', 'parent-b']);
      expect(status?.label).toBe('from-parent');
      expect(status?.prompt).toBe('select');

      // Validation still uses the inherited options, not own's.
      const allowed = getOptionsForField(loaded, 'task', 'status');
      expect(allowed).toEqual(['parent-a', 'parent-b']);
      expect(validateSelectOptionValue('own-only', allowed)).not.toBeNull();
    });
  });

  describe('provenance (getFieldsByOrigin)', () => {
    it('returns the winner object with correct attribution per collision kind', async () => {
      const loaded = await loadFromSchema({
        version: 2,
        traits: {
          actionable: {
            fields: {
              traitWin: { prompt: 'select', label: 'trait', options: ['t'] },
              ownBeatsTrait: { prompt: 'select', label: 'trait', options: ['t'] },
            },
          },
        },
        types: {
          base: {
            fields: {
              inheritedWin: { prompt: 'text', label: 'parent' },
            },
          },
          task: {
            extends: 'base',
            traits: ['actionable'],
            fields: {
              ownBeatsTrait: { prompt: 'select', label: 'own', options: ['o'] },
              ownNew: { prompt: 'text', label: 'own' },
            },
          },
        },
      });

      const byOrigin = getFieldsByOrigin(loaded, 'task');

      // own-vs-trait: attributed to own, object is own's full definition.
      expect(byOrigin.ownFields.ownBeatsTrait?.label).toBe('own');
      expect(byOrigin.ownFields.ownBeatsTrait?.options).toEqual(['o']);
      expect(byOrigin.ownFields.ownNew?.label).toBe('own');
      expect(byOrigin.traitFields.get('actionable')).not.toHaveProperty('ownBeatsTrait');

      // trait-only field: attributed to the trait, object is the trait's def.
      expect(byOrigin.traitFields.get('actionable')?.traitWin?.label).toBe('trait');

      // inherited-only field: attributed to the ancestor, object is its def.
      expect(byOrigin.inheritedFields.get('base')?.inheritedWin?.label).toBe('parent');
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
