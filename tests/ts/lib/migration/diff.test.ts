import { describe, it, expect } from "vitest";
import {
  diffSchemas,
  formatDiffForDisplay,
  formatDiffForJson,
  suggestVersionBump,
} from "../../../../src/lib/migration/diff.js";
import { PikaSchema } from "../../../../src/types/schema.js";
import type { z } from "zod";

type PikaSchemaType = z.infer<typeof PikaSchema>;

describe("diffSchemas", () => {
  const baseSchema: PikaSchemaType = {
    version: 2,
    schemaVersion: "1.0.0",
    enums: {
      status: ["active", "completed", "archived"],
      priority: ["low", "medium", "high"],
    },
    types: {
      task: {
        output_dir: "Tasks",
        fields: {
          status: { prompt: "select", enum: "status", required: true },
          priority: { prompt: "select", enum: "priority" },
          due: { prompt: "date" },
        },
      },
      note: {
        output_dir: "Notes",
        fields: {
          tags: { prompt: "multi-input" },
        },
      },
    },
  };

  describe("field changes", () => {
    it("should detect added fields", () => {
      const newSchema: PikaSchemaType = {
        ...baseSchema,
        schemaVersion: "1.1.0",
        types: {
          ...baseSchema.types,
          task: {
            ...baseSchema.types.task,
            fields: {
              ...baseSchema.types.task.fields,
              assignee: { prompt: "input" },
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
      const newSchema: PikaSchemaType = {
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
  });

  describe("enum changes", () => {
    it("should detect added enum values as deterministic", () => {
      const newSchema: PikaSchemaType = {
        ...baseSchema,
        schemaVersion: "1.1.0",
        enums: {
          ...baseSchema.enums,
          status: ["active", "completed", "archived", "pending"],
        },
      };

      const plan = diffSchemas(baseSchema, newSchema, "1.0.0", "1.1.0");

      expect(plan.hasChanges).toBe(true);
      expect(plan.deterministic).toContainEqual({
        op: "add-enum-value",
        enum: "status",
        value: "pending",
      });
    });

    it("should detect removed enum values as non-deterministic", () => {
      const newSchema: PikaSchemaType = {
        ...baseSchema,
        schemaVersion: "2.0.0",
        enums: {
          ...baseSchema.enums,
          status: ["active", "completed"], // archived removed
        },
      };

      const plan = diffSchemas(baseSchema, newSchema, "1.0.0", "2.0.0");

      expect(plan.hasChanges).toBe(true);
      expect(plan.nonDeterministic).toContainEqual({
        op: "remove-enum-value",
        enum: "status",
        value: "archived",
      });
    });
  });

  describe("type changes", () => {
    it("should detect added types as deterministic", () => {
      const newSchema: PikaSchemaType = {
        ...baseSchema,
        schemaVersion: "1.1.0",
        types: {
          ...baseSchema.types,
          project: {
            output_dir: "Projects",
            fields: {
              name: { prompt: "input", required: true },
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
      const newSchema: PikaSchemaType = {
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
