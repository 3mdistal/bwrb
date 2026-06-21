import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

/**
 * Regression guard for Issue #247.
 * Ensures `schema.schema.json` matches runtime Zod behavior for key fields.
 */
describe('schema.schema.json drift guards', () => {
  let metaSchema: any;

  beforeAll(async () => {
    const schemaUrl = new URL('../../../schema.schema.json', import.meta.url);
    metaSchema = JSON.parse(await readFile(schemaUrl, 'utf-8'));
  });

  it('includes config.open_with system option and default', () => {
    const openWith = metaSchema.definitions.config.properties.open_with;
    expect(openWith).toBeDefined();
    expect(openWith.enum).toContain('system');
    expect(openWith.enum).toContain('editor');
    expect(openWith.enum).toContain('visual');
    expect(openWith.enum).toContain('obsidian');
    expect(openWith.default).toBe('system');
  });

  it('includes runtime config keys in JSON schema', () => {
    const configProps = metaSchema.definitions.config.properties;

    expect(configProps.default_dashboard).toBeDefined();
    expect(configProps.default_dashboard.type).toBe('string');

    expect(configProps.date_format).toBeDefined();
    expect(configProps.date_format.type).toBe('string');
  });

  it('allows array forms for relation field.source and field.default', () => {
    const fieldProps = metaSchema.definitions.frontmatterField.properties;

    const source = fieldProps.source;
    expect(source).toBeDefined();
    expect(source.anyOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'string' }),
        expect.objectContaining({ type: 'array' }),
      ])
    );

    const def = fieldProps.default;
    expect(def).toBeDefined();
    expect(def.anyOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'string' }),
        expect.objectContaining({ type: 'array' }),
      ])
    );
  });

  it('exposes the alias field role on frontmatter fields', () => {
    const alias = metaSchema.definitions.frontmatterField.properties.alias;
    expect(alias).toBeDefined();
    expect(alias.type).toBe('boolean');
  });

  it('allows body section prompt to be none or list', () => {
    const prompt = metaSchema.definitions.bodySection.properties.prompt;
    expect(prompt).toBeDefined();
    expect(prompt.enum).toEqual(expect.arrayContaining(['none', 'list']));
  });

  it('exposes a top-level traits map and a trait definition', () => {
    const traits = metaSchema.properties.traits;
    expect(traits).toBeDefined();
    expect(traits.type).toBe('object');
    expect(traits.additionalProperties.$ref).toBe('#/definitions/trait');

    const trait = metaSchema.definitions.trait;
    expect(trait).toBeDefined();
    expect(trait.properties.fields).toBeDefined();
    expect(trait.properties.fields.additionalProperties.$ref).toBe(
      '#/definitions/frontmatterField'
    );
    expect(trait.properties.description).toBeDefined();
  });

  it('lets a type compose traits via a string array', () => {
    const traitsProp = metaSchema.definitions.typeNode.properties.traits;
    expect(traitsProp).toBeDefined();
    expect(traitsProp.type).toBe('array');
    expect(traitsProp.items.type).toBe('string');

    // A type may be defined with traits alone (no extends/fields/subtypes).
    const anyOf = metaSchema.definitions.typeNode.anyOf;
    expect(anyOf).toEqual(
      expect.arrayContaining([{ required: ['traits'] }])
    );
  });

  it('exposes a recurrence block on the trait definition (#107)', () => {
    const trait = metaSchema.definitions.trait;
    expect(trait.properties.recurrence).toBeDefined();
    expect(trait.properties.recurrence.$ref).toBe('#/definitions/recurrence');

    const recurrence = metaSchema.definitions.recurrence;
    expect(recurrence).toBeDefined();
    expect(recurrence.type).toBe('object');
    expect(recurrence.required).toEqual(expect.arrayContaining(['on']));
    expect(recurrence.properties.on.type).toBe('string');
    expect(recurrence.properties.template.type).toBe('string');
    expect(recurrence.properties.set.type).toBe('object');
    expect(recurrence.properties.set.additionalProperties.type).toBe('string');
  });

  it('includes filename on type definitions', () => {
    const typeDefProps = metaSchema.definitions.typeDefinition.properties;
    expect(typeDefProps.filename).toBeDefined();
    expect(typeDefProps.filename.type).toBe('string');

    const typeNodeProps = metaSchema.definitions.typeNode.properties;
    expect(typeNodeProps.filename).toBeDefined();
    expect(typeNodeProps.filename.type).toBe('string');
  });
});
