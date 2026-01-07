/**
 * Shared test schemas for bwrb test suite.
 *
 * This module is the single source of truth for test schemas.
 * Use BASELINE_SCHEMA for most tests. Use composable extensions
 * or special-case schemas only when testing specific behaviors.
 *
 * Guidelines:
 * - Use BASELINE_SCHEMA for general tests needing a realistic schema
 * - Use MINIMAL_SCHEMA for fast tests needing just one type
 * - Use special-case schemas (PAGINATION_SCHEMA, EMPTY_SCHEMA) for edge cases
 * - Use composable functions (withEntityPerson) when you need extra types
 * - Only define inline schemas for migration diff tests or truly unique needs
 */

// =============================================================================
// Type Definitions
// =============================================================================

/** Raw schema structure (not yet resolved by schema.ts) */
export interface TestSchema {
  $schema?: string;
  version: number;
  schemaVersion?: string;
  types: Record<string, TestTypeDefinition>;
  audit?: {
    ignored_directories?: string[];
  };
}

interface TestTypeDefinition {
  extends?: string;
  output_dir?: string;
  fields?: Record<string, TestFieldDefinition>;
  field_order?: string[];
  body_sections?: TestBodySection[];
}

interface TestFieldDefinition {
  value?: string;
  prompt?: 'text' | 'select' | 'relation' | 'list' | 'date';
  options?: string[];
  default?: unknown;
  required?: boolean;
  source?: string;
  filter?: Record<string, unknown>;
  format?: string;
  multiple?: boolean;
  owned?: boolean;
  label?: string;
  list_format?: string;
}

interface TestBodySection {
  title: string;
  level: number;
  content_type: string;
  prompt?: string;
  prompt_label?: string;
}

// =============================================================================
// BASELINE_SCHEMA - Canonical realistic schema for most tests
// =============================================================================

/**
 * The canonical baseline schema representing a realistic v1.0 shape.
 *
 * Includes:
 * - Inheritance chain: objective -> task, objective -> milestone
 * - Typed relations: task.milestone (relation to milestone type)
 * - Required fields with defaults
 * - Multiple field types: select, text, relation, value, list
 * - Body sections: Steps, Notes
 * - Ownership types: project owns research
 *
 * Use this for most tests. It exercises inheritance, relations, and
 * the full range of field types.
 */
export const BASELINE_SCHEMA: TestSchema = {
  version: 2,
  types: {
    objective: {
      output_dir: 'Objectives',
      fields: {
        type: { value: 'objective' },
      },
      field_order: ['type'],
    },
    task: {
      extends: 'objective',
      output_dir: 'Objectives/Tasks',
      fields: {
        type: { value: 'task' },
        status: {
          prompt: 'select',
          options: ['raw', 'backlog', 'in-flight', 'settled'],
          default: 'backlog',
          required: true,
        },
        milestone: {
          prompt: 'relation',
          source: 'milestone',
          filter: { status: { not_in: ['settled'] } },
          format: 'quoted-wikilink',
        },
        'creation-date': { value: '$NOW' },
        deadline: { prompt: 'text', label: 'Deadline (YYYY-MM-DD)' },
        tags: {
          prompt: 'list',
          list_format: 'yaml-array',
          default: [],
        },
      },
      field_order: ['type', 'status', 'milestone', 'creation-date', 'deadline', 'tags'],
      body_sections: [
        { title: 'Steps', level: 2, content_type: 'checkboxes', prompt: 'list', prompt_label: 'Steps' },
        { title: 'Notes', level: 2, content_type: 'paragraphs' },
      ],
    },
    milestone: {
      extends: 'objective',
      output_dir: 'Objectives/Milestones',
      fields: {
        type: { value: 'milestone' },
        status: {
          prompt: 'select',
          options: ['raw', 'backlog', 'in-flight', 'settled'],
          default: 'raw',
          required: true,
        },
      },
      field_order: ['type', 'status'],
      body_sections: [{ title: 'Tasks', level: 2, content_type: 'none' }],
    },
    idea: {
      output_dir: 'Ideas',
      fields: {
        type: { value: 'idea' },
        status: {
          prompt: 'select',
          options: ['raw', 'backlog', 'in-flight', 'settled'],
          default: 'raw',
          required: true,
        },
        priority: { prompt: 'select', options: ['low', 'medium', 'high'] },
        labels: {
          prompt: 'select',
          options: ['urgent', 'blocked', 'review', 'wip'],
          multiple: true,
        },
      },
      field_order: ['type', 'status', 'priority', 'labels'],
    },
    // Ownership types - project owns research notes
    project: {
      output_dir: 'Projects',
      fields: {
        type: { value: 'project' },
        status: {
          prompt: 'select',
          options: ['raw', 'backlog', 'in-flight', 'settled'],
          default: 'raw',
          required: true,
        },
        research: {
          prompt: 'relation',
          source: 'research',
          owned: true,
        },
      },
      field_order: ['type', 'status', 'research'],
    },
    research: {
      output_dir: 'Research',
      fields: {
        type: { value: 'research' },
        status: {
          prompt: 'select',
          options: ['raw', 'backlog', 'in-flight', 'settled'],
          default: 'raw',
          required: true,
        },
      },
      field_order: ['type', 'status'],
    },
  },
  audit: {
    ignored_directories: ['Templates'],
  },
};

// =============================================================================
// MINIMAL_SCHEMA - Fast tests needing just one type
// =============================================================================

/**
 * Minimal schema with just the 'idea' type.
 * Use for fast tests that don't need inheritance or relations.
 */
export const MINIMAL_SCHEMA: TestSchema = {
  version: 2,
  types: {
    idea: {
      output_dir: 'Ideas',
      fields: {
        type: { value: 'idea' },
        status: {
          prompt: 'select',
          options: ['raw', 'backlog', 'in-flight', 'settled'],
          default: 'raw',
        },
        priority: { prompt: 'select', options: ['low', 'medium', 'high'] },
      },
      field_order: ['type', 'status', 'priority'],
    },
  },
};

// =============================================================================
// Special-Case Schemas
// =============================================================================

/**
 * Schema with 15+ options for testing pagination in select prompts.
 */
export const PAGINATION_SCHEMA: TestSchema = {
  version: 2,
  types: {
    item: {
      output_dir: 'Items',
      fields: {
        type: { value: 'item' },
        category: {
          prompt: 'select',
          options: [
            'category-01',
            'category-02',
            'category-03',
            'category-04',
            'category-05',
            'category-06',
            'category-07',
            'category-08',
            'category-09',
            'category-10',
            'category-11',
            'category-12',
            'category-13',
            'category-14',
            'category-15',
          ],
          required: true,
        },
      },
      field_order: ['type', 'category'],
    },
  },
};

/**
 * Schema with empty types object for testing edge cases.
 */
export const EMPTY_SCHEMA: TestSchema = {
  version: 2,
  types: {},
};

/**
 * Schema for audit tests - includes inheritance and relations.
 * Slightly simpler than BASELINE_SCHEMA, focused on audit scenarios.
 */
export const AUDIT_SCHEMA: TestSchema = {
  version: 2,
  types: {
    idea: {
      output_dir: 'Ideas',
      fields: {
        type: { value: 'idea' },
        status: {
          prompt: 'select',
          options: ['raw', 'backlog', 'in-flight', 'settled'],
          default: 'raw',
          required: true,
        },
      },
      field_order: ['type', 'status'],
    },
    objective: {
      output_dir: 'Objectives',
      fields: {
        type: { value: 'objective' },
      },
      field_order: ['type'],
    },
    task: {
      extends: 'objective',
      output_dir: 'Tasks',
      fields: {
        type: { value: 'task' },
        status: {
          prompt: 'select',
          options: ['raw', 'backlog', 'in-flight', 'settled'],
          default: 'raw',
          required: true,
        },
      },
      field_order: ['type', 'status'],
    },
    milestone: {
      extends: 'objective',
      output_dir: 'Objectives/Milestones',
      fields: {
        type: { value: 'milestone' },
        status: {
          prompt: 'select',
          options: ['raw', 'backlog', 'in-flight', 'settled'],
          default: 'raw',
          required: true,
        },
      },
      field_order: ['type', 'status'],
    },
  },
};

// =============================================================================
// Composable Schema Extensions
// =============================================================================

/**
 * Add entity/person types to a schema (for inheritance testing).
 *
 * @example
 * const schema = withEntityPerson(BASELINE_SCHEMA);
 */
export function withEntityPerson<T extends TestSchema>(schema: T): T {
  return {
    ...schema,
    types: {
      ...schema.types,
      entity: {
        output_dir: 'Entities',
        fields: {
          type: { value: 'entity' },
        },
        field_order: ['type'],
      },
      person: {
        extends: 'entity',
        output_dir: 'Entities/People',
        fields: {
          type: { value: 'person' },
        },
        field_order: ['type'],
        body_sections: [],
      },
    },
  };
}

/**
 * Add a relation field that references a non-existent type.
 * Useful for testing empty choice handling.
 *
 * @example
 * const schema = withBrokenRelation(MINIMAL_SCHEMA);
 */
export function withBrokenRelation<T extends TestSchema>(schema: T, typeName: string = 'item'): T {
  const typeToModify = schema.types[typeName];
  if (!typeToModify) {
    // Create a new type with the broken relation
    return {
      ...schema,
      types: {
        ...schema.types,
        [typeName]: {
          output_dir: `${typeName.charAt(0).toUpperCase()}${typeName.slice(1)}s`,
          fields: {
            type: { value: typeName },
            ref: { prompt: 'relation', source: 'nonexistent_type', format: 'wikilink' },
          },
          field_order: ['type', 'ref'],
        },
      },
    };
  }
  // Add broken relation to existing type
  return {
    ...schema,
    types: {
      ...schema.types,
      [typeName]: {
        ...typeToModify,
        fields: {
          ...typeToModify.fields,
          ref: { prompt: 'relation', source: 'nonexistent_type', format: 'wikilink' },
        },
        field_order: [...(typeToModify.field_order || []), 'ref'],
      },
    },
  };
}

/**
 * Create a schema with additional types merged in.
 *
 * @example
 * const schema = withTypes(BASELINE_SCHEMA, {
 *   note: { output_dir: 'Notes', fields: { type: { value: 'note' } } }
 * });
 */
export function withTypes<T extends TestSchema>(
  schema: T,
  additionalTypes: Record<string, TestTypeDefinition>
): T {
  return {
    ...schema,
    types: {
      ...schema.types,
      ...additionalTypes,
    },
  };
}

// =============================================================================
// Schema for Static Fixture Vault
// =============================================================================

/**
 * Schema for the static fixture vault (tests/fixtures/vault).
 * Derived from BASELINE_SCHEMA + entity/person types for full coverage.
 *
 * This schema is used to generate tests/fixtures/vault/.bwrb/schema.json.
 * The static vault contains sample notes and templates for PTY tests.
 */
export const FIXTURE_VAULT_SCHEMA: TestSchema = withEntityPerson({
  ...BASELINE_SCHEMA,
  $schema: '../../../schema.schema.json',
});
