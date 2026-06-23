import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

/**
 * Minimal, dependency-free JSON Schema (draft-07 subset) validator.
 *
 * `schema.schema.json` only uses a small slice of draft-07: `type`,
 * `properties`, `additionalProperties` (bool or schema), `required`, `enum`,
 * `items`, `anyOf`/`oneOf`, and local `$ref`. A bespoke validator keeps this
 * drift guard free of runtime dependencies while still mechanically checking
 * that real vault schemas satisfy (and that legacy shapes are rejected by) the
 * published JSON Schema.
 */
function makeValidator(root: any) {
  const resolveRef = (ref: string): any => {
    if (!ref.startsWith('#/')) throw new Error(`unsupported $ref: ${ref}`);
    let node = root;
    for (const seg of ref.slice(2).split('/')) {
      node = node[seg];
      if (node === undefined) throw new Error(`unresolved $ref: ${ref}`);
    }
    return node;
  };

  const typeOf = (v: unknown): string => {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    if (Number.isInteger(v)) return 'integer';
    return typeof v;
  };

  const matchesType = (expected: string, v: unknown): boolean => {
    const actual = typeOf(v);
    if (expected === 'number') return actual === 'number' || actual === 'integer';
    if (expected === 'integer') return actual === 'integer';
    return actual === expected;
  };

  const check = (schema: any, value: unknown, path: string, errors: string[]): void => {
    if (schema.$ref) {
      check(resolveRef(schema.$ref), value, path, errors);
      return;
    }
    if (schema.anyOf) {
      const ok = schema.anyOf.some((s: any) => {
        const sub: string[] = [];
        check(s, value, path, sub);
        return sub.length === 0;
      });
      if (!ok) errors.push(`${path}: did not match anyOf`);
      return;
    }
    if (schema.oneOf) {
      const matches = schema.oneOf.filter((s: any) => {
        const sub: string[] = [];
        check(s, value, path, sub);
        return sub.length === 0;
      });
      if (matches.length !== 1) errors.push(`${path}: matched ${matches.length} oneOf branches`);
      return;
    }
    if (schema.type && !matchesType(schema.type, value)) {
      errors.push(`${path}: expected ${schema.type}, got ${typeOf(value)}`);
      return;
    }
    if (schema.enum && !schema.enum.includes(value as never)) {
      errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
    }
    if (schema.type === 'object' && typeOf(value) === 'object') {
      const obj = value as Record<string, unknown>;
      for (const req of schema.required ?? []) {
        if (!(req in obj)) errors.push(`${path}: missing required "${req}"`);
      }
      for (const [k, v] of Object.entries(obj)) {
        const propSchema = schema.properties?.[k];
        if (propSchema) {
          check(propSchema, v, `${path}/${k}`, errors);
        } else if (schema.additionalProperties === false) {
          errors.push(`${path}: additional property "${k}" not allowed`);
        } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
          check(schema.additionalProperties, v, `${path}/${k}`, errors);
        }
      }
    }
    if (schema.type === 'array' && Array.isArray(value) && schema.items) {
      value.forEach((item, i) => check(schema.items, item, `${path}[${i}]`, errors));
    }
  };

  return (value: unknown): { ok: boolean; errors: string[] } => {
    const errors: string[] = [];
    check(root, value, '#', errors);
    return { ok: errors.length === 0, errors };
  };
}

/**
 * Regression guard for Issues #247 and #626.
 *
 * `schema.schema.json` is the hand-maintained JSON Schema users point their
 * editor's JSON LSP at. It is NOT generated from the Zod schema, so it can
 * silently drift from the real runtime contract in `src/types/schema.ts` /
 * `src/lib/schema.ts`. These guards mechanically assert the two agree on the
 * points #626 raised (type definitions use `fields`, not `frontmatter`;
 * `config.date_granularity` and field-level `granularity` exist) and, more
 * generally, that a real `fields`-based vault schema validates against it.
 */
describe('schema.schema.json drift guards', () => {
  let metaSchema: any;
  let docsSchema: any;

  beforeAll(async () => {
    const schemaUrl = new URL('../../../schema.schema.json', import.meta.url);
    metaSchema = JSON.parse(await readFile(schemaUrl, 'utf-8'));
    // The published copy users actually fetch from the docs site.
    const docsUrl = new URL('../../../docs-site/public/schema.json', import.meta.url);
    docsSchema = JSON.parse(await readFile(docsUrl, 'utf-8'));
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

  // --- #626: config.date_granularity must exist (Zod ConfigSchema.date_granularity) ---
  it('exposes config.date_granularity with the day/month/year enum (#626)', () => {
    const granularity = metaSchema.definitions.config.properties.date_granularity;
    expect(granularity).toBeDefined();
    expect(granularity.type).toBe('string');
    expect(granularity.enum).toEqual(expect.arrayContaining(['day', 'month', 'year']));
  });

  // --- #626: field-level granularity must exist (Zod FieldSchema.granularity) ---
  it('exposes field-level granularity with the day/month/year enum (#626)', () => {
    const granularity = metaSchema.definitions.frontmatterField.properties.granularity;
    expect(granularity).toBeDefined();
    expect(granularity.type).toBe('string');
    expect(granularity.enum).toEqual(expect.arrayContaining(['day', 'month', 'year']));
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

  // --- #679: optional successor name template on the recurrence block ---
  it('exposes recurrence.name_template as an optional string (#679)', () => {
    const recurrence = metaSchema.definitions.recurrence;
    expect(recurrence.properties.name_template).toBeDefined();
    expect(recurrence.properties.name_template.type).toBe('string');
    // Optional: never added to `required`.
    expect(recurrence.required).not.toContain('name_template');
  });

  // --- #626 core: type definitions use the flat v2 `fields` contract ---
  describe('type definitions match the flat v2 loader contract (#626)', () => {
    it('a type composes traits via a string array', () => {
      const traitsProp = metaSchema.definitions.typeNode.properties.traits;
      expect(traitsProp).toBeDefined();
      expect(traitsProp.type).toBe('array');
      expect(traitsProp.items.type).toBe('string');
    });

    it('typeNode exposes `fields` (not the legacy `frontmatter`) keyed by field defs', () => {
      const props = metaSchema.definitions.typeNode.properties;
      expect(props.fields).toBeDefined();
      expect(props.fields.additionalProperties.$ref).toBe('#/definitions/frontmatterField');
      // The loader reads `fields`; the legacy `frontmatter` shape must be gone.
      expect(props.frontmatter).toBeUndefined();
      expect(props.frontmatter_order).toBeUndefined();
      expect(props.subtypes).toBeUndefined();
    });

    it('does NOT mark `frontmatter`/`output_dir` as required anywhere (#626)', () => {
      // The old typeDefinition demanded ["output_dir", "frontmatter"]; the Zod
      // TypeSchema requires neither (all properties optional).
      expect(metaSchema.definitions.typeDefinition).toBeUndefined();
      const typeNode = metaSchema.definitions.typeNode;
      const required = typeNode.required ?? [];
      expect(required).not.toContain('frontmatter');
      // No anyOf branch may demand the legacy frontmatter pairing.
      const anyOf = typeNode.anyOf ?? [];
      for (const branch of anyOf) {
        expect(branch.required ?? []).not.toContain('frontmatter');
      }
    });

    it('typeNode carries the full flat v2 property set from the Zod TypeSchema', () => {
      const props = metaSchema.definitions.typeNode.properties;
      for (const key of [
        'extends',
        'traits',
        'description',
        'fields',
        'field_order',
        'body_sections',
        'recursive',
        'output_dir',
        'filename',
        'plural',
      ]) {
        expect(props[key], `typeNode missing v2 property "${key}"`).toBeDefined();
      }
    });
  });

  it('includes filename on type definitions', () => {
    const typeNodeProps = metaSchema.definitions.typeNode.properties;
    expect(typeNodeProps.filename).toBeDefined();
    expect(typeNodeProps.filename.type).toBe('string');
  });

  // --- The published docs-site copy must not drift from the root schema ---
  it('docs-site/public/schema.json matches schema.schema.json (modulo $id)', () => {
    const stripId = (s: any) => {
      const { $id, ...rest } = s;
      return rest;
    };
    expect(stripId(docsSchema)).toEqual(stripId(metaSchema));
  });

  // --- End-to-end: a real fields-based vault schema validates against the JSON Schema ---
  describe('real vault schemas validate against the JSON Schema', () => {
    let validate: ReturnType<typeof makeValidator>;

    beforeAll(() => {
      validate = makeValidator(metaSchema);
    });

    it('the test fixture schema (uses `fields`) validates', async () => {
      const fixtureUrl = new URL(
        '../../fixtures/vault/.bwrb/schema.json',
        import.meta.url
      );
      const fixture = JSON.parse(await readFile(fixtureUrl, 'utf-8'));
      const { ok, errors } = validate(fixture);
      if (!ok) {
        throw new Error(
          'fixture schema failed JSON-Schema validation:\n' + errors.join('\n')
        );
      }
      expect(ok).toBe(true);
    });

    it('a fields-based schema with date_granularity/granularity validates (#626)', () => {
      const valid = {
        version: 2,
        config: { date_granularity: 'day' },
        types: {
          task: {
            output_dir: 'Tasks',
            fields: {
              status: { prompt: 'select', options: ['todo', 'done'] },
              due: { prompt: 'date', granularity: 'month' },
            },
          },
        },
      };
      const { ok, errors } = validate(valid);
      expect(errors).toEqual([]);
      expect(ok).toBe(true);
    });

    it('rejects the legacy `frontmatter`-based type shape (#626)', () => {
      // The shape the OLD schema *demanded* — `frontmatter` instead of `fields` —
      // must now be rejected (additionalProperties: false on typeNode).
      const legacy = {
        version: 2,
        types: {
          task: {
            output_dir: 'Tasks',
            frontmatter: { status: { prompt: 'text' } },
          },
        },
      };
      expect(validate(legacy).ok).toBe(false);
    });
  });
});
