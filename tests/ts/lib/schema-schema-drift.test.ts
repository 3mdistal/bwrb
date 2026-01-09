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

  it('allows body section prompt to be none or list', () => {
    const prompt = metaSchema.definitions.bodySection.properties.prompt;
    expect(prompt).toBeDefined();
    expect(prompt.enum).toEqual(expect.arrayContaining(['none', 'list']));
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
