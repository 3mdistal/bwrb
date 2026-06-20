import { describe, it, expect } from 'vitest';
import {
  BwrbSchema,
  getOptionValues,
  getOptionDescription,
} from '../../../src/types/schema.js';
import { resolveSchema, getFieldsForType } from '../../../src/lib/schema.js';
import { diffSchemas } from '../../../src/lib/migration/diff.js';
import { getMigrationStatus } from '../../../src/lib/migration/status.js';
import { findUndocumentedSchemaEntries } from '../../../src/lib/audit/schema-docs.js';
import type { z } from 'zod';

type BwrbSchemaType = z.infer<typeof BwrbSchema>;

describe('option helpers', () => {
  it('getOptionValues handles bare strings and {value,description} objects', () => {
    expect(getOptionValues(['a', 'b'])).toEqual(['a', 'b']);
    expect(
      getOptionValues(['a', { value: 'b', description: 'the b option' }])
    ).toEqual(['a', 'b']);
    expect(getOptionValues(undefined)).toEqual([]);
  });

  it('getOptionDescription returns the description only for documented object options', () => {
    const options = ['a', { value: 'b', description: 'the b option' }];
    expect(getOptionDescription(options, 'b')).toBe('the b option');
    expect(getOptionDescription(options, 'a')).toBeUndefined();
    expect(getOptionDescription(options, 'missing')).toBeUndefined();
    expect(getOptionDescription(undefined, 'b')).toBeUndefined();
  });
});

describe('schema parsing with descriptions', () => {
  it('accepts description on types and fields and the option union', () => {
    const parsed = BwrbSchema.parse({
      version: 2,
      types: {
        task: {
          description: 'a concrete next action',
          output_dir: 'Tasks',
          fields: {
            status: {
              prompt: 'select',
              description: 'workflow state',
              options: [
                { value: 'active', description: 'being worked on' },
                'backlog',
              ],
            },
          },
        },
      },
    });

    const taskFields = parsed.types.task.fields!;
    expect(parsed.types.task.description).toBe('a concrete next action');
    expect(taskFields.status!.description).toBe('workflow state');
    expect(taskFields.status!.options).toEqual([
      { value: 'active', description: 'being worked on' },
      'backlog',
    ]);
  });

  it('strips unknown keys rather than persisting them', () => {
    const parsed = BwrbSchema.parse({
      version: 2,
      types: { task: { output_dir: 'Tasks', fields: {}, bogusKey: true } },
    });
    expect('bogusKey' in parsed.types.task).toBe(false);
  });
});

describe('description inheritance', () => {
  const raw: BwrbSchemaType = {
    version: 2,
    types: {
      objective: {
        output_dir: 'Objectives',
        fields: {
          context: { prompt: 'relation', source: 'context', description: 'the area this belongs to' },
        },
      },
      task: {
        extends: 'objective',
        output_dir: 'Tasks',
        fields: {},
      },
      milestone: {
        extends: 'objective',
        output_dir: 'Milestones',
        fields: {
          context: { description: 'the milestone-specific area' },
        },
      },
    },
  };

  it('inherits a field description from an ancestor', () => {
    const schema = resolveSchema(raw);
    const fields = getFieldsForType(schema, 'task');
    expect(fields.context!.description).toBe('the area this belongs to');
  });

  it('lets a subtype override an inherited field description', () => {
    const schema = resolveSchema(raw);
    const fields = getFieldsForType(schema, 'milestone');
    expect(fields.context!.description).toBe('the milestone-specific area');
  });
});

describe('migration treats descriptions as cosmetic', () => {
  const base: BwrbSchemaType = {
    version: 2,
    schemaVersion: '1.0.0',
    types: {
      task: {
        output_dir: 'Tasks',
        fields: {
          status: { prompt: 'select', options: ['active', 'done'] },
        },
      },
    },
  };

  it('adding a type description produces no migration', () => {
    const next: BwrbSchemaType = {
      ...base,
      types: { task: { ...base.types.task, description: 'a next action' } },
    };
    const plan = diffSchemas(base, next, '1.0.0', '1.0.0');
    expect(plan.hasChanges).toBe(false);
  });

  it('adding a field description produces no migration', () => {
    const next: BwrbSchemaType = {
      ...base,
      types: {
        task: {
          ...base.types.task,
          fields: {
            status: { prompt: 'select', options: ['active', 'done'], description: 'state' },
          },
        },
      },
    };
    const plan = diffSchemas(base, next, '1.0.0', '1.0.0');
    expect(plan.hasChanges).toBe(false);
  });

  it('annotating an option (value unchanged) produces no migration', () => {
    const next: BwrbSchemaType = {
      ...base,
      types: {
        task: {
          ...base.types.task,
          fields: {
            status: {
              prompt: 'select',
              options: [{ value: 'active', description: 'being worked on' }, 'done'],
            },
          },
        },
      },
    };
    const plan = diffSchemas(base, next, '1.0.0', '1.0.0');
    expect(plan.hasChanges).toBe(false);
  });

  it('getMigrationStatus reports a description-only edit as not pending', () => {
    const next: BwrbSchemaType = {
      ...base,
      types: { task: { ...base.types.task, description: 'a next action' } },
    };
    const status = getMigrationStatus(next, {
      schema: base,
      schemaVersion: '1.0.0',
    } as Parameters<typeof getMigrationStatus>[1]);
    expect(status.pending).toBe(false);
  });

  it('getMigrationStatus still reports a real structural change as pending', () => {
    const next: BwrbSchemaType = {
      ...base,
      types: {
        task: {
          ...base.types.task,
          fields: {
            status: { prompt: 'select', options: ['active', 'done'] },
            owner: { prompt: 'text' }, // genuinely new field
          },
        },
      },
    };
    const status = getMigrationStatus(next, {
      schema: base,
      schemaVersion: '1.0.0',
    } as Parameters<typeof getMigrationStatus>[1]);
    expect(status.pending).toBe(true);
  });
});

describe('findUndocumentedSchemaEntries', () => {
  it('reports types and own fields lacking a description, skipping static identity fields', () => {
    const raw: BwrbSchemaType = {
      version: 2,
      types: {
        task: {
          output_dir: 'Tasks',
          fields: {
            type: { value: 'task' }, // static identity — skipped
            status: { prompt: 'select', options: ['a'], description: 'state' }, // documented
            owner: { prompt: 'text' }, // undocumented
          },
        },
        note: {
          description: 'a note',
          output_dir: 'Notes',
          fields: {},
        },
      },
    };
    const schema = resolveSchema(raw);
    const result = findUndocumentedSchemaEntries(schema);

    expect(result.types).toContain('task');
    expect(result.types).not.toContain('note');
    expect(result.fields).toContainEqual({ type: 'task', field: 'owner' });
    expect(result.fields).not.toContainEqual({ type: 'task', field: 'status' });
    expect(result.fields).not.toContainEqual({ type: 'task', field: 'type' });
  });
});
