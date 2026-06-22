import { describe, it, expect } from 'vitest';
import {
  buildSelectOptions,
  buildRelationOptions,
  type FieldPromptOptions,
} from '../../../src/lib/field-prompt.js';
import { type Field } from '../../../src/types/schema.js';

const CREATE: FieldPromptOptions = { mode: 'create' };
const TEMPLATE_DEFAULT: FieldPromptOptions = { mode: 'template-default' };
const TEMPLATE_EDIT: FieldPromptOptions = { mode: 'template-edit', currentValue: 'x' };

const selectOptions = ['alpha', 'beta'];

function field(overrides: Partial<Field> = {}): Field {
  return {
    prompt: 'select',
    options: [{ value: 'alpha' }, { value: 'beta' }],
    ...overrides,
  } as Field;
}

describe('buildSelectOptions', () => {
  describe('create mode', () => {
    it('required field has no sentinel and emits per-option hints', () => {
      const f = field({
        required: true,
        options: [{ value: 'alpha', description: 'A' }, { value: 'beta' }],
      });
      const result = buildSelectOptions(f, selectOptions, CREATE);
      expect(result.options).toEqual(['alpha', 'beta']);
      expect(result.hints).toEqual(['A', '']);
      expect(result.skipLabel).toBeUndefined();
    });

    it('optional field without default prefixes "(skip)"', () => {
      const result = buildSelectOptions(field(), selectOptions, CREATE);
      expect(result.options).toEqual(['(skip)', 'alpha', 'beta']);
      expect(result.hints).toEqual(['', '', '']);
      expect(result.skipLabel).toBe('(skip)');
    });

    it('optional field with default annotates the skip label', () => {
      const result = buildSelectOptions(field({ default: 'beta' }), selectOptions, CREATE);
      expect(result.options[0]).toBe('(skip) [beta]');
      expect(result.skipLabel).toBe('(skip) [beta]');
    });
  });

  describe('template-default mode', () => {
    it('always prefixes a plain "(skip)" and emits no hints', () => {
      const result = buildSelectOptions(field({ default: 'beta', required: true }), selectOptions, TEMPLATE_DEFAULT);
      expect(result.options).toEqual(['(skip)', 'alpha', 'beta']);
      expect(result.hints).toBeUndefined();
      expect(result.skipLabel).toBe('(skip)');
    });
  });

  describe('template-edit mode', () => {
    it('prefixes "(keep)" and "(clear)" with no skip label', () => {
      const result = buildSelectOptions(field(), selectOptions, TEMPLATE_EDIT);
      expect(result.options).toEqual(['(keep)', '(clear)', 'alpha', 'beta']);
      expect(result.hints).toBeUndefined();
      expect(result.skipLabel).toBeUndefined();
    });
  });
});

describe('buildRelationOptions', () => {
  const dynamic = ['Note A', 'Note B'];

  it('create + required: no sentinel', () => {
    const result = buildRelationOptions(dynamic, field({ required: true }), CREATE);
    expect(result.options).toEqual(['Note A', 'Note B']);
    expect(result.skipLabel).toBeUndefined();
  });

  it('create + optional: "(skip)" prefix', () => {
    const result = buildRelationOptions(dynamic, field(), CREATE);
    expect(result.options).toEqual(['(skip)', 'Note A', 'Note B']);
    expect(result.skipLabel).toBe('(skip)');
  });

  it('create + optional with default: annotated skip label', () => {
    const result = buildRelationOptions(dynamic, field({ default: 'Note B' }), CREATE);
    expect(result.options[0]).toBe('(skip) [Note B]');
    expect(result.skipLabel).toBe('(skip) [Note B]');
  });

  it('template-default: plain "(skip)" regardless of required/default', () => {
    const result = buildRelationOptions(dynamic, field({ required: true, default: 'Note B' }), TEMPLATE_DEFAULT);
    expect(result.options).toEqual(['(skip)', 'Note A', 'Note B']);
    expect(result.skipLabel).toBe('(skip)');
  });

  it('template-edit: "(keep)" / "(clear)" prefix', () => {
    const result = buildRelationOptions(dynamic, field(), TEMPLATE_EDIT);
    expect(result.options).toEqual(['(keep)', '(clear)', 'Note A', 'Note B']);
    expect(result.skipLabel).toBeUndefined();
  });
});
