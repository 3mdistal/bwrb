import { describe, it, expect } from "vitest";
import {
  diffSchemas,
  formatDiffForDisplay,
  formatDiffForJson,
  suggestVersionBump,
} from "../../../../src/lib/migration/diff.js";
import { BwrbSchema } from "../../../../src/types/schema.js";
import type { z } from "zod";

type BwrbSchemaType = z.infer<typeof BwrbSchema>;

describe("diffSchemas", () => {
  const baseSchema: BwrbSchemaType = {
    version: 2,
    schemaVersion: "1.0.0",
    types: {
      task: {
        output_dir: "Tasks",
        fields: {
          status: { prompt: "select", options: ["active", "completed", "archived"], required: true },
          priority: { prompt: "select", options: ["low", "medium", "high"] },
          due: { prompt: "date" },
        },
      },
      note: {
        output_dir: "Notes",
        fields: {
          tags: { prompt: "list" },
        },
      },
    },
  };

  describe("field changes", () => {
    it("should detect added fields", () => {
      const newSchema: BwrbSchemaType = {
        ...baseSchema,
        schemaVersion: "1.1.0",
        types: {
          ...baseSchema.types,
          task: {
            ...baseSchema.types.task,
            fields: {
              ...baseSchema.types.task.fields,
              assignee: { prompt: "text" },
            },
          },
        },
      };

      const plan = diffSchemas(baseSchema, newSchema, "1.0.0", "1.1.0");

      expect(plan.hasChanges).toBe(true);
      expect(plan.deterministic).toHaveLength(1);
      expect(plan.deterministic[0]).toEqual({
        op: "add-field",
        targetType: "task",
        field: "assignee",
      });
    });

    it("should detect removed fields as non-deterministic", () => {
      const newSchema: BwrbSchemaType = {
        ...baseSchema,
        schemaVersion: "2.0.0",
        types: {
          ...baseSchema.types,
          task: {
            ...baseSchema.types.task,
            fields: {
              status: baseSchema.types.task.fields!.status,
              // priority and due removed
            },
          },
        },
      };

      const plan = diffSchemas(baseSchema, newSchema, "1.0.0", "2.0.0");

      expect(plan.hasChanges).toBe(true);
      expect(plan.nonDeterministic.length).toBeGreaterThanOrEqual(1);
      const removeOps = plan.nonDeterministic.filter(
        (op) => op.op === "remove-field"
      );
      expect(removeOps.length).toBeGreaterThanOrEqual(1);
    });

    // The diff engine does not auto-detect field renames. A schema-only rename
    // (drop one field, add another) is inherently ambiguous — it is
    // indistinguishable from two unrelated changes — so it surfaces as an
    // add-field + remove-field pair, never as a `rename-field` op. Intentional
    // renames are performed explicitly via `bwrb bulk --rename old=new`.
    // See issue #694 and docs/product/migrations.md.
    it("should surface a schema-only field rename as add+remove, never rename-field", () => {
      const newSchema: BwrbSchemaType = {
        ...baseSchema,
        schemaVersion: "2.0.0",
        types: {
          ...baseSchema.types,
          task: {
            ...baseSchema.types.task,
            fields: {
              status: baseSchema.types.task.fields!.status,
              priority: baseSchema.types.task.fields!.priority,
              // `assignee` replaces a removed `due` field; from the schema
              // diff's perspective this is just an add + a remove.
              assignee: { prompt: "text" },
            },
          },
        },
      };

      const plan = diffSchemas(baseSchema, newSchema, "1.0.0", "2.0.0");

      const allOps = [...plan.deterministic, ...plan.nonDeterministic];
      expect(allOps.some((op) => op.op === "rename-field")).toBe(false);
      expect(
        plan.deterministic.some(
          (op) => op.op === "add-field" && op.field === "assignee"
        )
      ).toBe(true);
      expect(
        plan.nonDeterministic.some(
          (op) => op.op === "remove-field" && op.field === "due"
        )
      ).toBe(true);
    });
  });

  describe("type changes", () => {
    it("should detect added types as deterministic", () => {
      const newSchema: BwrbSchemaType = {
        ...baseSchema,
        schemaVersion: "1.1.0",
        types: {
          ...baseSchema.types,
          project: {
            output_dir: "Projects",
            fields: {
              name: { prompt: "text", required: true },
            },
          },
        },
      };

      const plan = diffSchemas(baseSchema, newSchema, "1.0.0", "1.1.0");

      expect(plan.hasChanges).toBe(true);
      expect(plan.deterministic).toContainEqual({
        op: "add-type",
        typeName: "project",
      });
    });

    it("should detect removed types as non-deterministic", () => {
      const newSchema: BwrbSchemaType = {
        ...baseSchema,
        schemaVersion: "2.0.0",
        types: {
          task: baseSchema.types.task,
          // note removed
        },
      };

      const plan = diffSchemas(baseSchema, newSchema, "1.0.0", "2.0.0");

      expect(plan.hasChanges).toBe(true);
      expect(plan.nonDeterministic).toContainEqual({
        op: "remove-type",
        typeName: "note",
      });
    });
  });

  describe("no changes", () => {
    it("should return hasChanges=false when schemas are identical", () => {
      const plan = diffSchemas(baseSchema, baseSchema, "1.0.0", "1.0.0");

      expect(plan.hasChanges).toBe(false);
      expect(plan.deterministic).toHaveLength(0);
      expect(plan.nonDeterministic).toHaveLength(0);
    });
  });

  describe("link format changes", () => {
    it("should detect link_format change from wikilink to markdown", () => {
      const oldSchema: BwrbSchemaType = {
        ...baseSchema,
        config: { link_format: "wikilink" },
      };
      const newSchema: BwrbSchemaType = {
        ...baseSchema,
        schemaVersion: "1.1.0",
        config: { link_format: "markdown" },
      };

      const plan = diffSchemas(oldSchema, newSchema, "1.0.0", "1.1.0");

      expect(plan.hasChanges).toBe(true);
      expect(plan.deterministic).toContainEqual({
        op: "normalize-links",
        fromFormat: "wikilink",
        toFormat: "markdown",
      });
    });

    it("should detect link_format change from markdown to wikilink", () => {
      const oldSchema: BwrbSchemaType = {
        ...baseSchema,
        config: { link_format: "markdown" },
      };
      const newSchema: BwrbSchemaType = {
        ...baseSchema,
        schemaVersion: "1.1.0",
        config: { link_format: "wikilink" },
      };

      const plan = diffSchemas(oldSchema, newSchema, "1.0.0", "1.1.0");

      expect(plan.hasChanges).toBe(true);
      expect(plan.deterministic).toContainEqual({
        op: "normalize-links",
        fromFormat: "markdown",
        toFormat: "wikilink",
      });
    });

    it("should not generate normalize-links when link_format unchanged", () => {
      const oldSchema: BwrbSchemaType = {
        ...baseSchema,
        config: { link_format: "wikilink" },
      };
      const newSchema: BwrbSchemaType = {
        ...baseSchema,
        config: { link_format: "wikilink" },
      };

      const plan = diffSchemas(oldSchema, newSchema, "1.0.0", "1.0.0");

      // No normalize-links operation should be present
      const normalizeOps = plan.deterministic.filter((op) => op.op === "normalize-links");
      expect(normalizeOps).toHaveLength(0);
    });

    it("should default undefined link_format to wikilink", () => {
      const oldSchema: BwrbSchemaType = {
        ...baseSchema,
        // No config.link_format - defaults to wikilink
      };
      const newSchema: BwrbSchemaType = {
        ...baseSchema,
        schemaVersion: "1.1.0",
        config: { link_format: "markdown" },
      };

      const plan = diffSchemas(oldSchema, newSchema, "1.0.0", "1.1.0");

      expect(plan.hasChanges).toBe(true);
      expect(plan.deterministic).toContainEqual({
        op: "normalize-links",
        fromFormat: "wikilink",
        toFormat: "markdown",
      });
    });
  });
});

describe("suggestVersionBump", () => {
  it("should suggest major bump for non-deterministic changes", () => {
    const plan = {
      fromVersion: "1.0.0",
      toVersion: "1.0.0",
      hasChanges: true,
      deterministic: [],
      nonDeterministic: [{ op: "remove-field" as const, targetType: "task", field: "status" }],
    };

    const suggestion = suggestVersionBump("1.0.0", plan);
    expect(suggestion).toBe("2.0.0");
  });

  it("should suggest minor bump for deterministic-only changes", () => {
    const plan = {
      fromVersion: "1.0.0",
      toVersion: "1.0.0",
      hasChanges: true,
      deterministic: [{ op: "add-field" as const, targetType: "task", field: "assignee" }],
      nonDeterministic: [],
    };

    const suggestion = suggestVersionBump("1.0.0", plan);
    expect(suggestion).toBe("1.1.0");
  });

  it("should return current version for no changes", () => {
    const plan = {
      fromVersion: "1.0.0",
      toVersion: "1.0.0",
      hasChanges: false,
      deterministic: [],
      nonDeterministic: [],
    };

    const suggestion = suggestVersionBump("1.0.0", plan);
    expect(suggestion).toBe("1.0.0");
  });
});

describe("formatDiffForDisplay", () => {
  it("should format deterministic changes with + prefix", () => {
    const plan = {
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      hasChanges: true,
      deterministic: [{ op: "add-field" as const, targetType: "task", field: "assignee" }],
      nonDeterministic: [],
    };

    const output = formatDiffForDisplay(plan);
    expect(output).toContain("+");
    expect(output).toContain("assignee");
    expect(output).toContain("task");
  });

  it("should format non-deterministic changes with - prefix", () => {
    const plan = {
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      hasChanges: true,
      deterministic: [],
      nonDeterministic: [{ op: "remove-field" as const, targetType: "task", field: "status" }],
    };

    const output = formatDiffForDisplay(plan);
    expect(output).toContain("-");
    expect(output).toContain("status");
    expect(output).toContain("task");
  });

  it("should format normalize-links operation", () => {
    const plan = {
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      hasChanges: true,
      deterministic: [{ op: "normalize-links" as const, fromFormat: "wikilink" as const, toFormat: "markdown" as const }],
      nonDeterministic: [],
    };

    const output = formatDiffForDisplay(plan);
    expect(output).toContain("Normalize");
    expect(output).toContain("wikilink");
    expect(output).toContain("markdown");
  });
});

describe("formatDiffForJson", () => {
  it("should return valid JSON structure", () => {
    const plan = {
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      hasChanges: true,
      deterministic: [{ op: "add-field" as const, targetType: "task", field: "assignee" }],
      nonDeterministic: [],
    };

    const json = formatDiffForJson(plan);
    expect(json.fromVersion).toBe("1.0.0");
    expect(json.toVersion).toBe("1.1.0");
    expect(json.hasChanges).toBe(true);
    expect(json.deterministic).toHaveLength(1);
    expect(json.nonDeterministic).toHaveLength(0);
  });
});
