import { describe, expect, it } from 'vitest';
import {
  buildDerivedFieldPlan,
  getDerivedFieldPlan,
  projectDerivedFields,
  validateDerivedFields,
} from '../../../src/lib/derived-fields.js';
import { resolveSchema } from '../../../src/lib/schema.js';
import type { Field } from '../../../src/types/schema.js';

function plan(fields: Record<string, Field>) {
  return buildDerivedFieldPlan(fields, 'types.task.fields');
}

describe('derived fields', () => {
  it('extracts dependencies and evaluates derived dependencies topologically', () => {
    const derived = plan({
      title: { prompt: 'text' },
      slug: { derived: { expression: 'lower(title)', type: 'string' } },
      labelled: { derived: { expression: 'upper(slug)', type: 'string' } },
    });
    expect(derived.fields.get('labelled')?.dependencies).toEqual(['slug']);
    expect(derived.order).toEqual(['slug', 'labelled']);
    expect(projectDerivedFields(derived, { title: 'HELLO' }, { asOf: '2026-08-10' })).toMatchObject({ slug: 'hello', labelled: 'HELLO' });
  });

  it('rejects unknown, self, and cyclic references with field chains', () => {
    expect(() => plan({ x: { derived: { expression: 'missing + 1', type: 'number' } } })).toThrow('unknown field reference "missing"');
    expect(() => plan({ x: { derived: { expression: 'x + 1', type: 'number' } } })).toThrow('cannot reference itself');
    expect(() => plan({ a: { derived: { expression: 'b', type: 'string' } }, b: { derived: { expression: 'a', type: 'string' } } })).toThrow('a -> b -> a');
  });

  it('propagates null for absent inputs and overwrites stored collisions', () => {
    const derived = plan({ input: { prompt: 'text' }, output: { derived: { expression: 'upper(input)', type: 'string' } } });
    expect(projectDerivedFields(derived, { output: 'stale' }, { asOf: '2026-08-10' }).output).toBeNull();
    expect(projectDerivedFields(derived, { input: 'fresh', output: 'stale' }, { asOf: '2026-08-10' }).output).toBe('FRESH');
  });

  it('binds today to asOf and rejects runtime-dependent or cross-note syntax', () => {
    const derived = plan({ today: { derived: { expression: 'today()', type: 'date' } } });
    expect(projectDerivedFields(derived, {}, { asOf: '2026-08-10' }).today).toBe('2026-08-10');
    expect(() => plan({ x: { derived: { expression: 'now()', type: 'date' } } })).toThrow('now() is not supported');
    expect(() => plan({ x: { derived: { expression: 'file.name', type: 'string' } } })).toThrow('file access is not supported');
    expect(() => plan({ x: { derived: { expression: 'isRoot()', type: 'boolean' } } })).toThrow('isRoot() is not supported');
  });

  it('enforces declared scalar result types and finite numbers', () => {
    const number = plan({ x: { derived: { expression: '1 / 0', type: 'number' } } });
    expect(() => projectDerivedFields(number, {}, { asOf: '2026-08-10' })).toThrow('expected number');
    const bool = plan({ x: { derived: { expression: "'yes'", type: 'boolean' } } });
    expect(() => projectDerivedFields(bool, {}, { asOf: '2026-08-10' })).toThrow('expected boolean');
  });

  it('requires a full valid calendar date result and includes note paths in runtime errors', () => {
    const invalid = plan({ x: { derived: { expression: "'2026-02-30'", type: 'date' } } });
    expect(() => projectDerivedFields(invalid, {}, { asOf: '2026-08-10', notePath: 'Tasks/T.md' }))
      .toThrow('Derived field "x" at Tasks/T.md result type mismatch');
    const valid = plan({ x: { derived: { expression: "'2026-02-28'", type: 'date' } } });
    expect(projectDerivedFields(valid, {}, { asOf: '2026-08-10' }).x).toBe('2026-02-28');
  });

  it('rejects prompt-like declarations and caches plans by loaded schema', () => {
    expect(() => plan({ x: { prompt: 'text', derived: { expression: "'x'", type: 'string' } } }))
      .toThrow('derived fields cannot also declare prompt');
    const schema = resolveSchema({ version: 2, types: {
      task: { fields: { x: { derived: { expression: "'x'", type: 'string' } } } },
    } });
    const plans = validateDerivedFields(schema);
    expect(getDerivedFieldPlan(schema, 'task')).toBe(plans.byType.get('task'));
  });
});
