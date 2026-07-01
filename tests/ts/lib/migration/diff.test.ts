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

  // Defect B (#728): the raw add-field loop must be derived against the OLD
  // EFFECTIVE (resolved) schema, like the changed/removed paths. A child type that
  // STARTS raw-declaring a field name it already INHERITS does NOT gain a new
  // field effectively, so it must emit NO add-field op. If that redeclaration
  // changes the field's effective shape, it is classified as field-changed
  // instead. A genuinely new own field must still emit add-field.
  describe("raw add-field of an already-inherited field", () => {
    const inheritanceBase: BwrbSchemaType = {
      version: 2,
      schemaVersion: "1.0.0",
      types: {
        objective: {
          fields: {
            phase: {
              prompt: "select",
              options: ["planned", "active", "done"],
            },
          },
        },
        // task inherits `phase` from objective but does NOT raw-declare it yet.
        task: {
          extends: "objective",
          fields: {
            title: { prompt: "text" },
          },
        },
      },
    };

    it("emits NO add-field when a child structurally redeclares an inherited field", () => {
      // task STARTS raw-declaring `phase` (which it already inherits), changing
      // its effective option set. This is a field change, not a field addition.
      const newSchema: BwrbSchemaType = {
        ...inheritanceBase,
        schemaVersion: "1.1.0",
        types: {
          ...inheritanceBase.types,
          task: {
            extends: "objective",
            fields: {
              title: { prompt: "text" },
              phase: { prompt: "select", options: ["todo", "doing", "done"] },
            },
          },
        },
      };

      const plan = diffSchemas(inheritanceBase, newSchema, "1.0.0", "1.1.0");

      const allOps = [...plan.deterministic, ...plan.nonDeterministic];
      expect(allOps.some((op) => op.op === "add-field" && op.field === "phase")).toBe(
        false
      );
      expect(
        plan.nonDeterministic.some(
          (op) =>
            op.op === "clear-invalid-options" &&
            op.targetType === "task" &&
            op.field === "phase"
        )
      ).toBe(true);
      expect(plan.hasChanges).toBe(true);
    });

    it("still emits add-field for a genuinely new own field (not previously inherited or present)", () => {
      const newSchema: BwrbSchemaType = {
        ...inheritanceBase,
        schemaVersion: "1.1.0",
        types: {
          ...inheritanceBase.types,
          task: {
            extends: "objective",
            fields: {
              title: { prompt: "text" },
              // `assignee` is genuinely new — not inherited, not previously present.
              assignee: { prompt: "text" },
            },
          },
        },
      };

      const plan = diffSchemas(inheritanceBase, newSchema, "1.0.0", "1.1.0");

      expect(plan.hasChanges).toBe(true);
      expect(
        plan.deterministic.some(
          (op) => op.op === "add-field" && op.targetType === "task" && op.field === "assignee"
        )
      ).toBe(true);
    });
  });

  describe("field-changed classification", () => {
    function withTaskField(field: Record<string, unknown>): BwrbSchemaType {
      return {
        ...baseSchema,
        schemaVersion: "1.1.0",
        types: {
          ...baseSchema.types,
          task: {
            ...baseSchema.types.task,
            fields: {
              ...baseSchema.types.task.fields,
              status: field,
            },
          },
        },
      };
    }

    it("emits clear-invalid-options when a select option is removed", () => {
      // status options: active, completed, archived → remove "archived"
      const newSchema = withTaskField({
        prompt: "select",
        options: ["active", "completed"],
        required: true,
      });

      const plan = diffSchemas(baseSchema, newSchema, "1.0.0", "1.1.0");

      expect(plan.hasChanges).toBe(true);
      expect(plan.nonDeterministic).toContainEqual({
        op: "clear-invalid-options",
        targetType: "task",
        field: "status",
        allowedValues: ["active", "completed"],
      });
    });

    it("does NOT emit an op when a select option is only added", () => {
      const newSchema = withTaskField({
        prompt: "select",
        options: ["active", "completed", "archived", "blocked"],
        required: true,
      });

      const plan = diffSchemas(baseSchema, newSchema, "1.0.0", "1.1.0");

      const allOps = [...plan.deterministic, ...plan.nonDeterministic];
      expect(allOps.some((op) => op.op === "clear-invalid-options")).toBe(false);
      // Adding an allowed value is a no-op for existing notes.
      expect(plan.hasChanges).toBe(false);
      // ...but the schema *shape* did change. `schemaChanged` must reflect this
      // so the migrate command can refresh the snapshot (defect #2 / #719):
      // otherwise a later removal of this option is diffed against a stale
      // snapshot that never had it, and the orphaned values are silently missed.
      expect(plan.schemaChanged).toBe(true);
    });

    it("does NOT emit a destructive op when select options are removed ENTIRELY (field becomes free text)", () => {
      // status: select[active, completed, archived] → unconstrained text. The
      // new allowed-option set is empty, but every existing value is valid for a
      // free-text field, so clearing them would be silent data loss (defect #1).
      const newSchema = withTaskField({
        prompt: "text",
        required: true,
      });

      const plan = diffSchemas(baseSchema, newSchema, "1.0.0", "1.1.0");

      const allOps = [...plan.deterministic, ...plan.nonDeterministic];
      // No value-deleting op may be emitted.
      expect(allOps.some((op) => op.op === "clear-invalid-options")).toBe(false);
      // Surface it for review instead (non-mutating).
      expect(
        plan.nonDeterministic.some(
          (op) => op.op === "review-field" && op.field === "status"
        )
      ).toBe(true);
      expect(plan.schemaChanged).toBe(true);
    });

    it("does NOT emit a destructive op when options are removed entirely on a MULTIPLE (array) field", () => {
      // Array variant of the entire-removal case: a constrained multi-select
      // becomes an unconstrained multi-value list. Existing array values are all
      // still valid, so nothing may be filtered/cleared.
      const baseWithMulti: BwrbSchemaType = withTaskField({
        prompt: "select",
        options: ["active", "completed", "archived"],
        required: true,
        multiple: true,
      });
      const newSchema = withTaskField({
        prompt: "list",
        required: true,
        multiple: true,
      });

      const plan = diffSchemas(baseWithMulti, newSchema, "1.1.0", "1.2.0");

      const allOps = [...plan.deterministic, ...plan.nonDeterministic];
      expect(allOps.some((op) => op.op === "clear-invalid-options")).toBe(false);
      expect(
        plan.nonDeterministic.some(
          (op) => op.op === "review-field" && op.field === "status"
        )
      ).toBe(true);
    });

    it("emits clear-invalid-options when an unconstrained field GAINS its first options (text → select)", () => {
      // baseSchema.note.tags is an unconstrained list. Here we constrain task's
      // `status`... but `status` starts constrained. Use a fresh unconstrained
      // field: redefine status as plain text first, then add options.
      const oldUnconstrained = withTaskField({ prompt: "text", required: true });
      const newConstrained = withTaskField({
        prompt: "select",
        options: ["active", "completed"],
        required: true,
      });

      const plan = diffSchemas(oldUnconstrained, newConstrained, "1.0.0", "1.1.0");

      // The transition is non-silent: hasChanges true → major bump suggested.
      expect(plan.hasChanges).toBe(true);
      expect(plan.nonDeterministic).toContainEqual({
        op: "clear-invalid-options",
        targetType: "task",
        field: "status",
        allowedValues: ["active", "completed"],
      });
      // Non-deterministic op present → major bump suggested.
      expect(suggestVersionBump("1.0.0", plan)).toBe("2.0.0");
    });

    it("emits clear-invalid-options when an unconstrained MULTIPLE list GAINS its first options (list → multi-select)", () => {
      const oldUnconstrained = withTaskField({
        prompt: "list",
        multiple: true,
      });
      const newConstrained = withTaskField({
        prompt: "select",
        options: ["active", "completed"],
        multiple: true,
      });

      const plan = diffSchemas(oldUnconstrained, newConstrained, "1.0.0", "1.1.0");

      expect(plan.hasChanges).toBe(true);
      expect(plan.nonDeterministic).toContainEqual({
        op: "clear-invalid-options",
        targetType: "task",
        field: "status",
        allowedValues: ["active", "completed"],
      });
    });

    it("emits a deterministic widen-field-to-multiple when multiple flips false → true", () => {
      const newSchema = withTaskField({
        prompt: "select",
        options: ["active", "completed", "archived"],
        required: true,
        multiple: true,
      });

      const plan = diffSchemas(baseSchema, newSchema, "1.0.0", "1.1.0");

      expect(plan.deterministic).toContainEqual({
        op: "widen-field-to-multiple",
        targetType: "task",
        field: "status",
      });
      expect(plan.nonDeterministic).toHaveLength(0);
    });

    it("emits review-field when multiple narrows true → false", () => {
      const multiSchema = withTaskField({
        prompt: "select",
        options: ["active", "completed", "archived"],
        required: true,
        multiple: true,
      });
      // Narrow back to single.
      const singleSchema = withTaskField({
        prompt: "select",
        options: ["active", "completed", "archived"],
        required: true,
      });

      const plan = diffSchemas(multiSchema, singleSchema, "1.1.0", "1.2.0");

      expect(
        plan.nonDeterministic.some(
          (op) => op.op === "review-field" && op.field === "status"
        )
      ).toBe(true);
      expect(
        plan.deterministic.some((op) => op.op === "widen-field-to-multiple")
      ).toBe(false);
    });

    it("emits review-field when date granularity narrows", () => {
      const yearSchema: BwrbSchemaType = {
        ...baseSchema,
        types: {
          ...baseSchema.types,
          task: {
            ...baseSchema.types.task,
            fields: {
              ...baseSchema.types.task.fields,
              due: { prompt: "date", granularity: "year" },
            },
          },
        },
      };
      const monthSchema: BwrbSchemaType = {
        ...yearSchema,
        schemaVersion: "2.0.0",
        types: {
          ...yearSchema.types,
          task: {
            ...yearSchema.types.task,
            fields: {
              ...yearSchema.types.task.fields,
              due: { prompt: "date", granularity: "month" },
            },
          },
        },
      };

      const plan = diffSchemas(yearSchema, monthSchema, "1.0.0", "2.0.0");

      expect(plan.nonDeterministic).toContainEqual({
        op: "review-field",
        targetType: "task",
        field: "due",
        reason:
          "date granularity is stricter; existing partial dates may need manual review",
      });
      expect(plan.deterministic).toHaveLength(0);
    });

    it("does NOT emit an op when date granularity widens", () => {
      const daySchema: BwrbSchemaType = {
        ...baseSchema,
        types: {
          ...baseSchema.types,
          task: {
            ...baseSchema.types.task,
            fields: {
              ...baseSchema.types.task.fields,
              due: { prompt: "date", granularity: "day" },
            },
          },
        },
      };
      const yearSchema: BwrbSchemaType = {
        ...daySchema,
        schemaVersion: "1.1.0",
        types: {
          ...daySchema.types,
          task: {
            ...daySchema.types.task,
            fields: {
              ...daySchema.types.task.fields,
              due: { prompt: "date", granularity: "year" },
            },
          },
        },
      };

      const plan = diffSchemas(daySchema, yearSchema, "1.0.0", "1.1.0");

      expect(plan.hasChanges).toBe(false);
      expect(plan.schemaChanged).toBe(true);
      expect(plan.deterministic).toHaveLength(0);
      expect(plan.nonDeterministic).toHaveLength(0);
    });

    it("emits review-field when an existing field prompt type changes", () => {
      const oldSchema: BwrbSchemaType = {
        ...baseSchema,
        types: {
          ...baseSchema.types,
          task: {
            ...baseSchema.types.task,
            fields: {
              ...baseSchema.types.task.fields,
              estimate: { prompt: "number" },
            },
          },
        },
      };
      const newSchema: BwrbSchemaType = {
        ...oldSchema,
        schemaVersion: "2.0.0",
        types: {
          ...oldSchema.types,
          task: {
            ...oldSchema.types.task,
            fields: {
              ...oldSchema.types.task.fields,
              estimate: { prompt: "date" },
            },
          },
        },
      };

      const plan = diffSchemas(oldSchema, newSchema, "1.0.0", "2.0.0");

      expect(plan.nonDeterministic).toContainEqual({
        op: "review-field",
        targetType: "task",
        field: "estimate",
        reason: "field prompt type changed; existing values may need manual review",
      });
      expect(plan.deterministic).toHaveLength(0);
    });

    it("emits review-field when a field becomes required", () => {
      // priority starts not-required → make it required.
      const newSchema: BwrbSchemaType = {
        ...baseSchema,
        schemaVersion: "1.1.0",
        types: {
          ...baseSchema.types,
          task: {
            ...baseSchema.types.task,
            fields: {
              ...baseSchema.types.task.fields,
              priority: { prompt: "select", options: ["low", "medium", "high"], required: true },
            },
          },
        },
      };

      const plan = diffSchemas(baseSchema, newSchema, "1.0.0", "1.1.0");

      expect(
        plan.nonDeterministic.some(
          (op) => op.op === "review-field" && op.field === "priority"
        )
      ).toBe(true);
    });

    it("does NOT emit review-field when a field becomes required AND has a default", () => {
      // #728 defect A: bwrb validation (validation.ts) exempts a required field
      // whose definition supplies a `default` — notes missing the value stay valid
      // because the default satisfies them. So the required-toggle must NOT produce
      // a non-deterministic review op (which would needlessly force a major bump and
      // record empty history). See validation.test.ts for the matching assertion
      // that such notes actually validate.
      const newSchema: BwrbSchemaType = {
        ...baseSchema,
        schemaVersion: "1.1.0",
        types: {
          ...baseSchema.types,
          task: {
            ...baseSchema.types.task,
            fields: {
              ...baseSchema.types.task.fields,
              priority: {
                prompt: "select",
                options: ["low", "medium", "high"],
                required: true,
                default: "low",
              },
            },
          },
        },
      };

      const plan = diffSchemas(baseSchema, newSchema, "1.0.0", "1.1.0");

      // The required-toggle itself produces no review op.
      expect(
        plan.nonDeterministic.some(
          (op) => op.op === "review-field" && op.field === "priority"
        )
      ).toBe(false);
    });

    it("still classifies other concurrent aspects when a required+default change is also widened", () => {
      // The required-toggle is exempt (has a default), but a concurrent
      // multiple:false→true on the same field must still be classified
      // independently as a deterministic widen.
      const newSchema: BwrbSchemaType = {
        ...baseSchema,
        schemaVersion: "1.1.0",
        types: {
          ...baseSchema.types,
          task: {
            ...baseSchema.types.task,
            fields: {
              ...baseSchema.types.task.fields,
              priority: {
                prompt: "select",
                options: ["low", "medium", "high"],
                required: true,
                default: "low",
                multiple: true,
              },
            },
          },
        },
      };

      const plan = diffSchemas(baseSchema, newSchema, "1.0.0", "1.1.0");

      // No review op from the required-toggle...
      expect(
        plan.nonDeterministic.some(
          (op) => op.op === "review-field" && op.field === "priority"
        )
      ).toBe(false);
      // ...but the widen-to-multiple is still emitted.
      expect(
        plan.deterministic.some(
          (op) => op.op === "widen-field-to-multiple" && op.field === "priority"
        )
      ).toBe(true);
    });

    it("emits review-field when a default is REMOVED from an already-required field", () => {
      // #728 defect B (symmetric gap): a field is ALREADY required: true WITH a
      // default. Removing that default (default: defined → undefined, required
      // stays true) newly invalidates notes that omit the field — validation only
      // exempts a missing required value while `default !== undefined`. The change
      // must surface as a review-field even though the `required` FLAG itself did
      // not toggle.
      const oldSchema: BwrbSchemaType = {
        ...baseSchema,
        types: {
          ...baseSchema.types,
          task: {
            ...baseSchema.types.task,
            fields: {
              ...baseSchema.types.task.fields,
              priority: {
                prompt: "select",
                options: ["low", "medium", "high"],
                required: true,
                default: "low",
              },
            },
          },
        },
      };
      const newSchema: BwrbSchemaType = {
        ...oldSchema,
        schemaVersion: "2.0.0",
        types: {
          ...oldSchema.types,
          task: {
            ...oldSchema.types.task,
            fields: {
              ...oldSchema.types.task.fields,
              // Same field, required stays true, default removed.
              priority: {
                prompt: "select",
                options: ["low", "medium", "high"],
                required: true,
              },
            },
          },
        },
      };

      const plan = diffSchemas(oldSchema, newSchema, "1.0.0", "2.0.0");

      expect(plan.hasChanges).toBe(true);
      expect(
        plan.nonDeterministic.some(
          (op) => op.op === "review-field" && op.field === "priority"
        )
      ).toBe(true);
    });

    it("does NOT emit review-field when a default is removed from a NON-required field", () => {
      // A non-required field losing its default does not invalidate notes that
      // omit it (validation never requires a value), so no review op.
      const oldSchema: BwrbSchemaType = {
        ...baseSchema,
        types: {
          ...baseSchema.types,
          task: {
            ...baseSchema.types.task,
            fields: {
              ...baseSchema.types.task.fields,
              priority: {
                prompt: "select",
                options: ["low", "medium", "high"],
                default: "low",
              },
            },
          },
        },
      };
      const newSchema: BwrbSchemaType = {
        ...oldSchema,
        schemaVersion: "2.0.0",
        types: {
          ...oldSchema.types,
          task: {
            ...oldSchema.types.task,
            fields: {
              ...oldSchema.types.task.fields,
              priority: {
                prompt: "select",
                options: ["low", "medium", "high"],
              },
            },
          },
        },
      };

      const plan = diffSchemas(oldSchema, newSchema, "1.0.0", "2.0.0");

      expect(
        plan.nonDeterministic.some(
          (op) => op.op === "review-field" && op.field === "priority"
        )
      ).toBe(false);
    });

    it("does NOT emit a NEW required-review when an already-required no-default field gets an unrelated edit", () => {
      // The field was ALREADY exposed (required: true, no default). An unrelated
      // edit (here: adding an option) must not produce a NEW required-exposure
      // review — the exposure state did not change.
      const oldSchema: BwrbSchemaType = {
        ...baseSchema,
        types: {
          ...baseSchema.types,
          task: {
            ...baseSchema.types.task,
            fields: {
              ...baseSchema.types.task.fields,
              priority: {
                prompt: "select",
                options: ["low", "medium", "high"],
                required: true,
              },
            },
          },
        },
      };
      const newSchema: BwrbSchemaType = {
        ...oldSchema,
        schemaVersion: "1.1.0",
        types: {
          ...oldSchema.types,
          task: {
            ...oldSchema.types.task,
            fields: {
              ...oldSchema.types.task.fields,
              priority: {
                prompt: "select",
                // option ADDED — does not narrow, keeps existing values valid.
                options: ["low", "medium", "high", "urgent"],
                required: true,
              },
            },
          },
        },
      };

      const plan = diffSchemas(oldSchema, newSchema, "1.0.0", "1.1.0");

      // Required-exposure did not change → no review-field for priority.
      expect(
        plan.nonDeterministic.some(
          (op) => op.op === "review-field" && op.field === "priority"
        )
      ).toBe(false);
    });

    it("does NOT emit review-field when ADDING a default to an already-required field", () => {
      // Going from required-no-default (exposed) to required-with-default (exempt)
      // only LOOSENS validation — notes missing the field become valid. No review.
      const oldSchema: BwrbSchemaType = {
        ...baseSchema,
        types: {
          ...baseSchema.types,
          task: {
            ...baseSchema.types.task,
            fields: {
              ...baseSchema.types.task.fields,
              priority: {
                prompt: "select",
                options: ["low", "medium", "high"],
                required: true,
              },
            },
          },
        },
      };
      const newSchema: BwrbSchemaType = {
        ...oldSchema,
        schemaVersion: "1.1.0",
        types: {
          ...oldSchema.types,
          task: {
            ...oldSchema.types.task,
            fields: {
              ...oldSchema.types.task.fields,
              priority: {
                prompt: "select",
                options: ["low", "medium", "high"],
                required: true,
                default: "low",
              },
            },
          },
        },
      };

      const plan = diffSchemas(oldSchema, newSchema, "1.0.0", "1.1.0");

      expect(
        plan.nonDeterministic.some(
          (op) => op.op === "review-field" && op.field === "priority"
        )
      ).toBe(false);
    });

    it("emits exactly ONE review-field when required false→true and default removed in the same change", () => {
      // Both `required` and `default` change at once but describe a single
      // boundary crossing (not-exposed → exposed). Must emit ONE review-field.
      const oldSchema: BwrbSchemaType = {
        ...baseSchema,
        types: {
          ...baseSchema.types,
          task: {
            ...baseSchema.types.task,
            fields: {
              ...baseSchema.types.task.fields,
              priority: {
                prompt: "select",
                options: ["low", "medium", "high"],
                required: false,
                default: "low",
              },
            },
          },
        },
      };
      const newSchema: BwrbSchemaType = {
        ...oldSchema,
        schemaVersion: "2.0.0",
        types: {
          ...oldSchema.types,
          task: {
            ...oldSchema.types.task,
            fields: {
              ...oldSchema.types.task.fields,
              priority: {
                prompt: "select",
                options: ["low", "medium", "high"],
                required: true,
              },
            },
          },
        },
      };

      const plan = diffSchemas(oldSchema, newSchema, "1.0.0", "2.0.0");

      const reviews = plan.nonDeterministic.filter(
        (op) => op.op === "review-field" && op.field === "priority"
      );
      expect(reviews).toHaveLength(1);
    });

    it("emits review-field when a relation source changes", () => {
      const oldSchema: BwrbSchemaType = {
        ...baseSchema,
        types: {
          ...baseSchema.types,
          task: {
            ...baseSchema.types.task,
            fields: {
              ...baseSchema.types.task.fields,
              parent: { prompt: "relation", source: "task" },
            },
          },
        },
      };
      const newSchema: BwrbSchemaType = {
        ...oldSchema,
        schemaVersion: "1.1.0",
        types: {
          ...oldSchema.types,
          task: {
            ...oldSchema.types.task,
            fields: {
              ...oldSchema.types.task.fields,
              parent: { prompt: "relation", source: "note" },
            },
          },
        },
      };

      const plan = diffSchemas(oldSchema, newSchema, "1.0.0", "1.1.0");

      expect(
        plan.nonDeterministic.some(
          (op) => op.op === "review-field" && op.field === "parent"
        )
      ).toBe(true);
    });

    // Build a schema whose task.parent relation field has the given `source`.
    // Passing `undefined` omits `source` entirely (unconstrained relation).
    function withParentSource(
      source: string | string[] | undefined,
      schemaVersion = "1.0.0"
    ): BwrbSchemaType {
      const parent =
        source === undefined
          ? { prompt: "relation" as const }
          : { prompt: "relation" as const, source };
      return {
        ...baseSchema,
        schemaVersion,
        types: {
          ...baseSchema.types,
          task: {
            ...baseSchema.types.task,
            fields: {
              ...baseSchema.types.task.fields,
              parent,
            },
          },
        },
      };
    }

    function withHierarchicalParentSource(
      source: string | string[],
      schemaVersion = "1.0.0"
    ): BwrbSchemaType {
      return {
        version: 2,
        schemaVersion,
        types: {
          objective: {
            output_dir: "Objectives",
            fields: {},
          },
          task: {
            extends: "objective",
            output_dir: "Tasks",
            fields: {
              parent: { prompt: "relation", source },
            },
          },
        },
      };
    }

    it("does NOT emit review-field when a relation source only widens (new set ⊇ old)", () => {
      // source: "task" → ["task", "project"]. Existing links targeting `task`
      // remain valid; the change merely allows a wider set, so no review op.
      const oldSchema = withParentSource("task", "1.0.0");
      const newSchema = withParentSource(["task", "project"], "1.1.0");

      const plan = diffSchemas(oldSchema, newSchema, "1.0.0", "1.1.0");

      expect(
        plan.nonDeterministic.some(
          (op) => op.op === "review-field" && op.field === "parent"
        )
      ).toBe(false);
    });

    it("does NOT emit review-field when a child relation source widens to its ancestor", () => {
      // Validation accepts a relation source type plus descendants, so
      // "objective" accepts both objective and task. Existing task links remain
      // valid when "task" widens to its ancestor.
      const oldSchema = withHierarchicalParentSource("task", "1.0.0");
      const newSchema = withHierarchicalParentSource("objective", "1.1.0");

      const plan = diffSchemas(oldSchema, newSchema, "1.0.0", "1.1.0");

      expect(
        plan.nonDeterministic.some(
          (op) => op.op === "review-field" && op.field === "parent"
        )
      ).toBe(false);
    });

    it("does NOT emit review-field when dropping a descendant already covered by an ancestor source", () => {
      // ["objective", "task"] and ["objective"] accept the same effective set
      // because objective already covers its task descendants.
      const oldSchema = withHierarchicalParentSource(["objective", "task"], "1.0.0");
      const newSchema = withHierarchicalParentSource("objective", "1.1.0");

      const plan = diffSchemas(oldSchema, newSchema, "1.0.0", "1.1.0");

      expect(
        plan.nonDeterministic.some(
          (op) => op.op === "review-field" && op.field === "parent"
        )
      ).toBe(false);
    });

    it("emits review-field when a relation source truly narrows from ancestor to child", () => {
      // objective accepted objective notes and task descendants; task accepts
      // only task descendants, so objective links may now be invalid.
      const oldSchema = withHierarchicalParentSource("objective", "1.0.0");
      const newSchema = withHierarchicalParentSource("task", "1.1.0");

      const plan = diffSchemas(oldSchema, newSchema, "1.0.0", "1.1.0");

      expect(
        plan.nonDeterministic.some(
          (op) => op.op === "review-field" && op.field === "parent"
        )
      ).toBe(true);
    });

    it("does NOT emit review-field when a relation source array is merely reordered", () => {
      // Same allowed set, different order → no semantic change, no op.
      const oldSchema = withParentSource(["task", "project"], "1.0.0");
      const newSchema = withParentSource(["project", "task"], "1.1.0");

      const plan = diffSchemas(oldSchema, newSchema, "1.0.0", "1.1.0");

      expect(
        plan.nonDeterministic.some(
          (op) => op.op === "review-field" && op.field === "parent"
        )
      ).toBe(false);
    });

    it("emits review-field when a relation source removes a previously-allowed type", () => {
      // source: ["task", "project"] → "task". Links targeting `project` may now
      // be invalid → narrowing must still surface a review op.
      const oldSchema = withParentSource(["task", "project"], "1.0.0");
      const newSchema = withParentSource("task", "1.1.0");

      const plan = diffSchemas(oldSchema, newSchema, "1.0.0", "1.1.0");

      expect(
        plan.nonDeterministic.some(
          (op) => op.op === "review-field" && op.field === "parent"
        )
      ).toBe(true);
    });

    it("emits review-field when an unconstrained relation source becomes constrained (none → set)", () => {
      // No source (any type allowed) → source: "task". Existing links may have
      // pointed at non-task notes that are now disallowed → must surface a review.
      const oldSchema = withParentSource(undefined, "1.0.0");
      const newSchema = withParentSource("task", "1.1.0");

      const plan = diffSchemas(oldSchema, newSchema, "1.0.0", "1.1.0");

      expect(
        plan.nonDeterministic.some(
          (op) => op.op === "review-field" && op.field === "parent"
        )
      ).toBe(true);
    });

    it("emits review-field when source changes from explicit `any` to a constrained set", () => {
      // `source: "any"` is unconstrained (validation treats it like absent), so
      // any → "task" is the same unconstrained → constrained narrowing.
      const oldSchema = withParentSource("any", "1.0.0");
      const newSchema = withParentSource("task", "1.1.0");

      const plan = diffSchemas(oldSchema, newSchema, "1.0.0", "1.1.0");

      expect(
        plan.nonDeterministic.some(
          (op) => op.op === "review-field" && op.field === "parent"
        )
      ).toBe(true);
    });

    it("does NOT emit review-field when a constrained relation source is removed (set → none)", () => {
      // source: "task" → absent. The field loosens to allow any type; every
      // existing link stays valid → safe loosening, no op.
      const oldSchema = withParentSource("task", "1.0.0");
      const newSchema = withParentSource(undefined, "1.1.0");

      const plan = diffSchemas(oldSchema, newSchema, "1.0.0", "1.1.0");

      expect(
        plan.nonDeterministic.some(
          (op) => op.op === "review-field" && op.field === "parent"
        )
      ).toBe(false);
    });

    it("does NOT emit review-field when a constrained relation source loosens to `any`", () => {
      // source: ["task", "project"] → "any". Loosening to unconstrained keeps
      // every existing link valid → no op.
      const oldSchema = withParentSource(["task", "project"], "1.0.0");
      const newSchema = withParentSource("any", "1.1.0");

      const plan = diffSchemas(oldSchema, newSchema, "1.0.0", "1.1.0");

      expect(
        plan.nonDeterministic.some(
          (op) => op.op === "review-field" && op.field === "parent"
        )
      ).toBe(false);
    });

    it("does not treat an option description-only edit as a change", () => {
      // Same values, but document one option — cosmetic, no migration op.
      const newSchema = withTaskField({
        prompt: "select",
        options: [
          { value: "active", description: "in progress" },
          "completed",
          "archived",
        ],
        required: true,
      });

      const plan = diffSchemas(baseSchema, newSchema, "1.0.0", "1.0.0");

      expect(plan.hasChanges).toBe(false);
      // Cosmetic-only edits must not trigger a snapshot refresh either.
      expect(plan.schemaChanged).toBe(false);
    });

    // Defect B (#728): adding/removing an explicit `multiple: false` is a no-op —
    // omitted and `false` both mean single-valued. It must NOT be treated as a
    // narrowing (no review-field, no major bump), but the schema *shape* changed,
    // so the snapshot still refreshes.
    describe("multiple normalization (absent === false)", () => {
      it("does NOT emit an op when an explicit `multiple: false` is ADDED (was absent)", () => {
        // status has no `multiple` key in baseSchema → add explicit false.
        const newSchema = withTaskField({
          prompt: "select",
          options: ["active", "completed", "archived"],
          required: true,
          multiple: false,
        });

        const plan = diffSchemas(baseSchema, newSchema, "1.0.0", "1.1.0");

        const allOps = [...plan.deterministic, ...plan.nonDeterministic];
        expect(
          allOps.some((op) => op.op === "review-field" && op.field === "status")
        ).toBe(false);
        expect(
          allOps.some((op) => op.op === "widen-field-to-multiple")
        ).toBe(false);
        expect(plan.hasChanges).toBe(false);
        // No version bump for a no-op shape edit...
        expect(suggestVersionBump("1.0.0", plan)).toBe("1.0.0");
        // ...but the snapshot must still refresh so later real changes diff
        // against the current schema.
        expect(plan.schemaChanged).toBe(true);
      });

      it("does NOT emit an op when an explicit `multiple: false` is REMOVED (becomes absent)", () => {
        const withExplicitFalse = withTaskField({
          prompt: "select",
          options: ["active", "completed", "archived"],
          required: true,
          multiple: false,
        });
        const withAbsent = withTaskField({
          prompt: "select",
          options: ["active", "completed", "archived"],
          required: true,
        });

        const plan = diffSchemas(withExplicitFalse, withAbsent, "1.0.0", "1.1.0");

        const allOps = [...plan.deterministic, ...plan.nonDeterministic];
        expect(
          allOps.some((op) => op.op === "review-field" && op.field === "status")
        ).toBe(false);
        expect(plan.hasChanges).toBe(false);
        expect(suggestVersionBump("1.0.0", plan)).toBe("1.0.0");
      });

      it("still emits review-field when narrowing true → absent (absent === false)", () => {
        const multi = withTaskField({
          prompt: "select",
          options: ["active", "completed", "archived"],
          required: true,
          multiple: true,
        });
        const absent = withTaskField({
          prompt: "select",
          options: ["active", "completed", "archived"],
          required: true,
        });

        const plan = diffSchemas(multi, absent, "1.1.0", "1.2.0");

        expect(
          plan.nonDeterministic.some(
            (op) => op.op === "review-field" && op.field === "status"
          )
        ).toBe(true);
        // Narrowing is breaking → major bump.
        expect(suggestVersionBump("1.1.0", plan)).toBe("2.0.0");
      });

      it("still emits review-field when narrowing true → explicit false", () => {
        const multi = withTaskField({
          prompt: "select",
          options: ["active", "completed", "archived"],
          required: true,
          multiple: true,
        });
        const single = withTaskField({
          prompt: "select",
          options: ["active", "completed", "archived"],
          required: true,
          multiple: false,
        });

        const plan = diffSchemas(multi, single, "1.1.0", "1.2.0");

        expect(
          plan.nonDeterministic.some(
            (op) => op.op === "review-field" && op.field === "status"
          )
        ).toBe(true);
      });
    });
  });

  // #728: a field-changed op for a field declared on a PARENT type must reach
  // every CONCRETE descendant whose EFFECTIVE field changed, because
  // executeMigration matches ops to notes by exact type. Ops are derived by
  // comparing each type's RESOLVED field old → new (see detectEffectiveFieldChanges).
  //
  // IMPORTANT — resolver semantics (verified in computeEffectiveFields,
  // src/lib/schema.ts): a child can structurally override an INHERITED field by
  // declaring the keys it wants to fork. Descendants with no structural override
  // follow the declaring ancestor; descendants with a structural override are
  // governed by their own effective field shape.
  describe("field-changed inheritance (declaring type + inheriting descendants)", () => {
    // objective declares `phase` (a select); task extends objective and inherits
    // it; subtask extends task and re-declares `phase` with its own options —
    // so subtask's effective `phase` is forked from objective's.
    const inheritanceBase: BwrbSchemaType = {
      version: 2,
      schemaVersion: "1.0.0",
      types: {
        objective: {
          fields: {
            phase: {
              prompt: "select",
              options: ["planned", "active", "done", "abandoned"],
            },
          },
        },
        task: {
          extends: "objective",
          fields: {
            title: { prompt: "text" },
          },
        },
        subtask: {
          extends: "task",
          fields: {
            phase: { prompt: "select", options: ["todo", "doing", "done"] },
          },
        },
      },
    };

    function withObjectivePhaseOptions(options: string[]): BwrbSchemaType {
      return {
        ...inheritanceBase,
        schemaVersion: "1.1.0",
        types: {
          ...inheritanceBase.types,
          objective: {
            ...inheritanceBase.types.objective,
            fields: {
              phase: { prompt: "select", options },
            },
          },
        },
      };
    }

    it("includes inheriting descendant types in clear-invalid-options", () => {
      // Remove "abandoned" from objective.phase. task INHERITS phase → its notes
      // can hold "abandoned" and must be cleaned too.
      const newSchema = withObjectivePhaseOptions(["planned", "active", "done"]);

      const plan = diffSchemas(inheritanceBase, newSchema, "1.0.0", "1.1.0");

      const clearOps = plan.nonDeterministic.filter(
        (op) => op.op === "clear-invalid-options" && op.field === "phase"
      );
      const targetedTypes = clearOps.map((op) =>
        op.op === "clear-invalid-options" ? op.targetType : ""
      );

      // Declaring type AND inheriting descendant are both targeted.
      expect(targetedTypes).toContain("objective");
      expect(targetedTypes).toContain("task");
    });

    it("does not target a descendant with its own structural option fork", () => {
      const newSchema = withObjectivePhaseOptions(["planned", "active", "done"]);

      const plan = diffSchemas(inheritanceBase, newSchema, "1.0.0", "1.1.0");

      const clearOps = plan.nonDeterministic.filter(
        (op) => op.op === "clear-invalid-options" && op.field === "phase"
      );
      const targetedTypes = clearOps.map((op) =>
        op.op === "clear-invalid-options" ? op.targetType : ""
      );

      // subtask has its own effective options. Parent option removal does not
      // change subtask's effective field, so subtask notes are not cleaned.
      expect(targetedTypes).not.toContain("subtask");
    });

    it("fans out clear-invalid-options to inheriting descendants when a PARENT field gains its first options", () => {
      // Start: objective.phase is UNCONSTRAINED text; task inherits it. Then
      // objective.phase gains a constraining option set. Both the declaring type
      // AND the inheriting descendant must be cleaned, because descendant notes
      // can hold arbitrary text values now outside the new allowed set.
      const unconstrainedBase: BwrbSchemaType = {
        ...inheritanceBase,
        types: {
          ...inheritanceBase.types,
          objective: {
            fields: {
              phase: { prompt: "text" },
            },
          },
          // Drop subtask's raw override so the fixture is purely about
          // declaring-type + inheriting-descendant fan-out.
          subtask: {
            extends: "task",
            fields: {
              title: { prompt: "text" },
            },
          },
        },
      };
      const newSchema: BwrbSchemaType = {
        ...unconstrainedBase,
        schemaVersion: "1.1.0",
        types: {
          ...unconstrainedBase.types,
          objective: {
            fields: {
              phase: { prompt: "select", options: ["planned", "active", "done"] },
            },
          },
        },
      };

      const plan = diffSchemas(unconstrainedBase, newSchema, "1.0.0", "1.1.0");

      const clearOps = plan.nonDeterministic.filter(
        (op) => op.op === "clear-invalid-options" && op.field === "phase"
      );
      const targetedTypes = clearOps.map((op) =>
        op.op === "clear-invalid-options" ? op.targetType : ""
      );

      // Declaring type AND every inheriting descendant are targeted, each with
      // the parent's new effective allowed set.
      expect(targetedTypes).toContain("objective");
      expect(targetedTypes).toContain("task");
      expect(targetedTypes).toContain("subtask");
      for (const op of clearOps) {
        expect(op).toMatchObject({
          op: "clear-invalid-options",
          allowedValues: ["planned", "active", "done"],
        });
      }
    });

    it("propagates a multiple-widen through descendants that do not override multiple", () => {
      // objective.phase multiple false → true. Descendants without their own
      // `multiple` override inherit the widening, even if they fork other keys
      // such as `options`.
      const newSchema: BwrbSchemaType = {
        ...inheritanceBase,
        schemaVersion: "1.1.0",
        types: {
          ...inheritanceBase.types,
          objective: {
            ...inheritanceBase.types.objective,
            fields: {
              phase: {
                prompt: "select",
                options: ["planned", "active", "done", "abandoned"],
                multiple: true,
              },
            },
          },
        },
      };

      const plan = diffSchemas(inheritanceBase, newSchema, "1.0.0", "1.1.0");

      const widenTargets = plan.deterministic
        .filter((op) => op.op === "widen-field-to-multiple" && op.field === "phase")
        .map((op) => (op.op === "widen-field-to-multiple" ? op.targetType : ""));

      expect(widenTargets).toContain("objective");
      expect(widenTargets).toContain("task");
      expect(widenTargets).toContain("subtask");
    });

    it("does not widen a descendant that overrides multiple locally", () => {
      // subtask declares `multiple: false`, so parent multiple false → true does
      // not change subtask's effective field.
      const base: BwrbSchemaType = {
        ...inheritanceBase,
        types: {
          ...inheritanceBase.types,
          subtask: {
            extends: "task",
            fields: {
              phase: { prompt: "select", multiple: false },
            },
          },
        },
      };
      const newSchema: BwrbSchemaType = {
        ...base,
        schemaVersion: "1.1.0",
        types: {
          ...base.types,
          objective: {
            ...base.types.objective,
            fields: {
              phase: {
                prompt: "select",
                options: ["planned", "active", "done", "abandoned"],
                multiple: true,
              },
            },
          },
        },
      };

      const plan = diffSchemas(base, newSchema, "1.0.0", "1.1.0");

      const widenTargets = plan.deterministic
        .filter((op) => op.op === "widen-field-to-multiple" && op.field === "phase")
        .map((op) => (op.op === "widen-field-to-multiple" ? op.targetType : ""));

      expect(widenTargets).toContain("objective");
      expect(widenTargets).toContain("task");
      expect(widenTargets).not.toContain("subtask");
    });

    // A child that re-declares the inherited field ONLY to override metadata
    // (description/default/value/granularity) keeps the parent's structural
    // options/multiple, so its notes still inherit the parent's value set and
    // MUST be cleaned on a parent option removal. A child that overrides
    // structural keys gets its own effective field and is not swept along when
    // the parent shape changes but the child shape does not.
    describe("metadata-only child override is still affected", () => {
      const metadataOverrideBase: BwrbSchemaType = {
        version: 2,
        schemaVersion: "1.0.0",
        types: {
          objective: {
            fields: {
              phase: {
                prompt: "select",
                options: ["planned", "active", "done", "abandoned"],
              },
            },
          },
          task: {
            extends: "objective",
            fields: {
              // Metadata-only override: keeps parent's options. Should STILL be
              // affected by a parent option removal.
              phase: {
                prompt: "select",
                description: "task-specific phase wording",
              },
            },
          },
          subtask: {
            extends: "task",
            fields: {
              phase: { prompt: "select", options: ["todo", "doing", "done"] },
            },
          },
        },
      };

      function withObjectiveOptions(options: string[]): BwrbSchemaType {
        return {
          ...metadataOverrideBase,
          schemaVersion: "1.1.0",
          types: {
            ...metadataOverrideBase.types,
            objective: {
              ...metadataOverrideBase.types.objective,
              fields: {
                phase: { prompt: "select", options },
              },
            },
          },
        };
      }

      it("cleans a child that overrides ONLY metadata (description)", () => {
        const newSchema = withObjectiveOptions(["planned", "active", "done"]);
        const plan = diffSchemas(
          metadataOverrideBase,
          newSchema,
          "1.0.0",
          "1.1.0"
        );

        const targeted = plan.nonDeterministic
          .filter((op) => op.op === "clear-invalid-options" && op.field === "phase")
          .map((op) => (op.op === "clear-invalid-options" ? op.targetType : ""));

        // Declaring type and metadata-only child are cleaned; the structural
        // override grandchild keeps its own effective option set.
        expect(targeted).toContain("objective");
        expect(targeted).toContain("task");
        expect(targeted).not.toContain("subtask");
      });

      it("cleans a child that overrides ONLY a default", () => {
        const base: BwrbSchemaType = {
          ...metadataOverrideBase,
          types: {
            ...metadataOverrideBase.types,
            task: {
              extends: "objective",
              fields: {
                // default-only override (not structural).
                phase: { prompt: "select", default: "planned" },
              },
            },
          },
        };
        const newSchema: BwrbSchemaType = {
          ...base,
          schemaVersion: "1.1.0",
          types: {
            ...base.types,
            objective: {
              ...base.types.objective,
              fields: {
                phase: {
                  prompt: "select",
                  options: ["planned", "active", "done"],
                },
              },
            },
          },
        };
        const plan = diffSchemas(base, newSchema, "1.0.0", "1.1.0");

        const targeted = plan.nonDeterministic
          .filter((op) => op.op === "clear-invalid-options" && op.field === "phase")
          .map((op) => (op.op === "clear-invalid-options" ? op.targetType : ""));

        expect(targeted).toContain("objective");
        expect(targeted).toContain("task");
        expect(targeted).not.toContain("subtask");
      });
    });
  });

  // #728 (removal fan-out): field REMOVAL, like field-changed, is derived from
  // the EFFECTIVE (resolved) schema. Removing a field declared on a PARENT drops
  // it from every inheriting descendant's effective schema, so a `remove-field`
  // op must be emitted per concrete type that loses it — the declaring parent AND
  // each inheriting descendant — so each type's notes are cleaned under their own
  // exact `expectedType` (executeMigration groups field ops by exact type).
  describe("field-removal inheritance (declaring type + inheriting descendants)", () => {
    // objective declares `legacy` (and `phase`); task extends objective and
    // inherits both; standalone has its OWN `legacy` field (genuine, not
    // inherited from objective).
    const removalBase: BwrbSchemaType = {
      version: 2,
      schemaVersion: "1.0.0",
      types: {
        objective: {
          fields: {
            phase: { prompt: "select", options: ["planned", "active", "done"] },
            legacy: { prompt: "text" },
          },
        },
        task: {
          extends: "objective",
          fields: {
            title: { prompt: "text" },
          },
        },
        standalone: {
          fields: {
            // OWN genuine `legacy` field — NOT inherited from objective.
            legacy: { prompt: "text" },
          },
        },
      },
    };

    it("fans out remove-field to the declaring type AND every inheriting descendant", () => {
      // Remove objective.legacy. task INHERITS legacy → its notes hold `legacy`
      // and must be cleaned too.
      const newSchema: BwrbSchemaType = {
        ...removalBase,
        schemaVersion: "2.0.0",
        types: {
          ...removalBase.types,
          objective: {
            ...removalBase.types.objective,
            fields: {
              phase: removalBase.types.objective.fields!.phase,
              // legacy removed
            },
          },
        },
      };

      const plan = diffSchemas(removalBase, newSchema, "1.0.0", "2.0.0");

      const removeOps = plan.nonDeterministic.filter(
        (op) => op.op === "remove-field" && op.field === "legacy"
      );
      const targetedTypes = removeOps.map((op) =>
        op.op === "remove-field" ? op.targetType : ""
      );

      // Declaring type AND inheriting descendant are both targeted.
      expect(targetedTypes).toContain("objective");
      expect(targetedTypes).toContain("task");
      // The descendant op references the field under its OWN type so notes whose
      // expectedType is `task` get cleaned.
      expect(removeOps).toContainEqual({
        op: "remove-field",
        targetType: "task",
        field: "legacy",
      });
    });

    it("emits the declaring-type remove-field exactly once (no double-emit)", () => {
      const newSchema: BwrbSchemaType = {
        ...removalBase,
        schemaVersion: "2.0.0",
        types: {
          ...removalBase.types,
          objective: {
            ...removalBase.types.objective,
            fields: { phase: removalBase.types.objective.fields!.phase },
          },
        },
      };

      const plan = diffSchemas(removalBase, newSchema, "1.0.0", "2.0.0");

      const objectiveRemoveOps = plan.nonDeterministic.filter(
        (op) =>
          op.op === "remove-field" &&
          op.field === "legacy" &&
          op.targetType === "objective"
      );
      expect(objectiveRemoveOps).toHaveLength(1);
    });

    it("does NOT emit remove-field for a descendant that has its OWN same-named field when an unrelated parent field is removed", () => {
      // Remove objective.legacy. `standalone` has its OWN `legacy` (not inherited
      // from objective), so its effective `legacy` survives — it must NOT be
      // targeted.
      const newSchema: BwrbSchemaType = {
        ...removalBase,
        schemaVersion: "2.0.0",
        types: {
          ...removalBase.types,
          objective: {
            ...removalBase.types.objective,
            fields: { phase: removalBase.types.objective.fields!.phase },
          },
        },
      };

      const plan = diffSchemas(removalBase, newSchema, "1.0.0", "2.0.0");

      const removeOps = plan.nonDeterministic.filter(
        (op) => op.op === "remove-field" && op.field === "legacy"
      );
      const targetedTypes = removeOps.map((op) =>
        op.op === "remove-field" ? op.targetType : ""
      );
      expect(targetedTypes).not.toContain("standalone");
    });
  });

  // #731: field-changed ops are derived from the EFFECTIVE (resolved) schema,
  // not raw field entries. A subtype that edits its own structural override of
  // an INHERITED field now changes its effective schema, so migration should
  // produce the same cleanup op it would for any other select narrowing.
  describe("subtype structural override of an inherited field", () => {
    // objective declares `phase`; task extends objective and re-declares `phase`
    // with its OWN options. Resolution merges own keys over inherited keys, so
    // task's effective `phase` uses task's options.
    const base: BwrbSchemaType = {
      version: 2,
      schemaVersion: "1.0.0",
      types: {
        objective: {
          fields: {
            phase: {
              prompt: "select",
              options: ["planned", "active", "done", "abandoned"],
            },
          },
        },
        task: {
          extends: "objective",
          fields: {
            phase: {
              prompt: "select",
              options: ["todo", "doing", "done", "wontfix"],
            },
          },
        },
      },
    };

    it("emits clear-invalid-options when a subtype narrows its own inherited-field option fork", () => {
      // Parent's `phase` is unchanged; task narrows its own effective option set.
      const newSchema: BwrbSchemaType = {
        ...base,
        schemaVersion: "1.1.0",
        types: {
          ...base.types,
          task: {
            extends: "objective",
            fields: {
              // "wontfix" removed from task's effective override.
              phase: {
                prompt: "select",
                options: ["todo", "doing", "done"],
              },
            },
          },
        },
      };

      const plan = diffSchemas(base, newSchema, "1.0.0", "1.1.0");

      const allOps = [...plan.deterministic, ...plan.nonDeterministic];
      expect(allOps).toContainEqual({
        op: "clear-invalid-options",
        targetType: "task",
        field: "phase",
        allowedValues: ["todo", "doing", "done"],
      });
      expect(plan.hasChanges).toBe(true);
      expect(plan.schemaChanged).toBe(true);
    });
  });

  // #731 inverse: when a PARENT removes an option, a descendant with its own
  // structural fork is governed by that child effective field. The parent and
  // pure inheritors are cleaned; the forked child is not.
  describe("parent option removal does not clean a descendant with its own structural fork", () => {
    const base: BwrbSchemaType = {
      version: 2,
      schemaVersion: "1.0.0",
      types: {
        objective: {
          fields: {
            phase: {
              prompt: "select",
              options: ["planned", "active", "done", "abandoned"],
            },
          },
        },
        task: {
          extends: "objective",
          fields: {
            phase: { prompt: "select", options: ["x", "y", "z"] },
          },
        },
      },
    };

    it("targets the parent but not the structurally forked descendant", () => {
      // Remove "abandoned" from objective.phase.
      const newSchema: BwrbSchemaType = {
        ...base,
        schemaVersion: "1.1.0",
        types: {
          ...base.types,
          objective: {
            fields: {
              phase: {
                prompt: "select",
                options: ["planned", "active", "done"],
              },
            },
          },
        },
      };

      const plan = diffSchemas(base, newSchema, "1.0.0", "1.1.0");

      const targeted = plan.nonDeterministic
        .filter((op) => op.op === "clear-invalid-options" && op.field === "phase")
        .map((op) => (op.op === "clear-invalid-options" ? op.targetType : ""));

      // objective changed; task's effective option fork did not.
      expect(targeted).toContain("objective");
      expect(targeted).not.toContain("task");
    });
  });

  // A type with its OWN field (declared fresh, not inherited via `extends`) is
  // governed by its own options exactly as before. This is the control case
  // proving the effective-schema rework did not regress own-field handling.
  describe("a type's OWN (non-inherited) field is governed by its own options", () => {
    it("emits clear-invalid-options when an own field's options are narrowed", () => {
      const own: BwrbSchemaType = {
        version: 2,
        schemaVersion: "1.0.0",
        types: {
          ticket: {
            fields: {
              severity: {
                prompt: "select",
                options: ["low", "high", "critical"],
              },
            },
          },
        },
      };
      const newSchema: BwrbSchemaType = {
        ...own,
        schemaVersion: "1.1.0",
        types: {
          ticket: {
            fields: {
              severity: { prompt: "select", options: ["low", "high"] },
            },
          },
        },
      };

      const plan = diffSchemas(own, newSchema, "1.0.0", "1.1.0");

      expect(plan.nonDeterministic).toContainEqual({
        op: "clear-invalid-options",
        targetType: "ticket",
        field: "severity",
        allowedValues: ["low", "high"],
      });
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
      expect(plan.schemaChanged).toBe(false);
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

  // #728 effective-addition defect: a field can enter a concrete type's EFFECTIVE
  // schema through trait composition (a field added to a composed trait, or a
  // trait newly attached to a type) without appearing in `schema.types[T].fields`
  // (raw). The old raw add path missed these, so `diffSchemas` returned
  // schemaChanged:false and `migrate --execute` never refreshed the snapshot —
  // leaving a later removal of the now-populated field diffed against a stale
  // snapshot. Additions are now derived from the EFFECTIVE schema, the single
  // source of truth (mirroring changed/removed).
  describe("effective field additions (trait composition)", () => {
    // task composes the `tracked` trait; adding a field to that trait must be
    // detected even though task's raw fields never mention it.
    const traitBase: BwrbSchemaType = {
      version: 2,
      schemaVersion: "1.0.0",
      traits: {
        tracked: {
          fields: {
            status: { prompt: "select", options: ["open", "done"] },
          },
        },
      },
      types: {
        task: {
          traits: ["tracked"],
          fields: {
            title: { prompt: "text" },
          },
        },
      },
    };

    it("detects a field ADDED to an existing trait as schemaChanged with no note-mutating op (optional field)", () => {
      const newSchema: BwrbSchemaType = {
        ...traitBase,
        schemaVersion: "1.1.0",
        traits: {
          tracked: {
            fields: {
              status: { prompt: "select", options: ["open", "done"] },
              // New OPTIONAL trait field — enters task's effective schema only.
              assignee: { prompt: "text" },
            },
          },
        },
      };

      const plan = diffSchemas(traitBase, newSchema, "1.0.0", "1.1.0");

      // The snapshot must refresh on migrate so a later removal is diffed
      // correctly.
      expect(plan.schemaChanged).toBe(true);

      // An add-field op is emitted (deterministic), but for an OPTIONAL field
      // with no default it produces NO note mutation on execute (backfill only
      // fires when there is a default). So there must be no note-mutating op
      // beyond the bare add-field, and certainly no remove/clear/review.
      const addOps = plan.deterministic.filter(
        (op) => op.op === "add-field" && op.targetType === "task" && op.field === "assignee"
      );
      expect(addOps).toHaveLength(1);
      expect(addOps[0]).not.toHaveProperty("default");
      // No lossy / review ops for an optional addition.
      expect(plan.nonDeterministic).toHaveLength(0);
    });

    it("detects fields from a trait NEWLY ATTACHED to a type", () => {
      // A second type starts WITHOUT the trait and then composes it.
      const oldSchema: BwrbSchemaType = {
        version: 2,
        schemaVersion: "1.0.0",
        traits: {
          tracked: {
            fields: { status: { prompt: "select", options: ["open", "done"] } },
          },
        },
        types: {
          note: {
            fields: { title: { prompt: "text" } },
          },
        },
      };
      const newSchema: BwrbSchemaType = {
        ...oldSchema,
        schemaVersion: "1.1.0",
        types: {
          note: {
            traits: ["tracked"],
            fields: { title: { prompt: "text" } },
          },
        },
      };

      const plan = diffSchemas(oldSchema, newSchema, "1.0.0", "1.1.0");

      expect(plan.schemaChanged).toBe(true);
      expect(
        plan.deterministic.some(
          (op) => op.op === "add-field" && op.targetType === "note" && op.field === "status"
        )
      ).toBe(true);
    });

    it("does NOT flag a trait field that is unchanged in both old and new", () => {
      // Same trait, same fields — nothing added.
      const plan = diffSchemas(traitBase, { ...traitBase, schemaVersion: "1.0.1" }, "1.0.0", "1.0.1");
      expect(plan.schemaChanged).toBe(false);
      expect(plan.hasChanges).toBe(false);
    });

    it("detects exactly once (no double-count) for a genuinely new raw OWN field", () => {
      const newSchema: BwrbSchemaType = {
        ...traitBase,
        schemaVersion: "1.1.0",
        types: {
          task: {
            traits: ["tracked"],
            fields: {
              title: { prompt: "text" },
              // genuinely new own field
              estimate: { prompt: "number" },
            },
          },
        },
      };

      const plan = diffSchemas(traitBase, newSchema, "1.0.0", "1.1.0");

      const addOps = plan.deterministic.filter(
        (op) => op.op === "add-field" && op.field === "estimate"
      );
      expect(addOps).toHaveLength(1);
      expect(plan.hasChanges).toBe(true);
    });

    it("backfills a default that lives on a composed trait field (effective default honored)", () => {
      const newSchema: BwrbSchemaType = {
        ...traitBase,
        schemaVersion: "1.1.0",
        traits: {
          tracked: {
            fields: {
              status: { prompt: "select", options: ["open", "done"] },
              // Trait field carrying a default — the raw type entry never
              // mentions it, so the default must be read from the effective field.
              priority: { prompt: "select", options: ["low", "high"], default: "low" },
            },
          },
        },
      };

      const plan = diffSchemas(traitBase, newSchema, "1.0.0", "1.1.0");

      expect(plan.deterministic).toContainEqual({
        op: "add-field",
        targetType: "task",
        field: "priority",
        default: "low",
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

  it("should suggest a major bump for non-deterministic field re-validation ops", () => {
    const plan = {
      fromVersion: "1.2.0",
      toVersion: "1.2.0",
      hasChanges: true,
      deterministic: [],
      nonDeterministic: [
        {
          op: "clear-invalid-options" as const,
          targetType: "task",
          field: "status",
          allowedValues: ["active"],
        },
      ],
    };

    expect(suggestVersionBump("1.2.0", plan)).toBe("2.0.0");
  });

  it("should suggest a minor bump for a deterministic widen-to-multiple op", () => {
    const plan = {
      fromVersion: "1.2.0",
      toVersion: "1.2.0",
      hasChanges: true,
      deterministic: [
        { op: "widen-field-to-multiple" as const, targetType: "task", field: "status" },
      ],
      nonDeterministic: [],
    };

    expect(suggestVersionBump("1.2.0", plan)).toBe("1.3.0");
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

  it("should format clear-invalid-options and review-field operations", () => {
    const plan = {
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      hasChanges: true,
      deterministic: [
        { op: "widen-field-to-multiple" as const, targetType: "task", field: "tags" },
      ],
      nonDeterministic: [
        {
          op: "clear-invalid-options" as const,
          targetType: "task",
          field: "status",
          allowedValues: ["active"],
        },
        {
          op: "review-field" as const,
          targetType: "task",
          field: "priority",
          reason: "field is now required; notes missing a value need manual review",
        },
      ],
    };

    const output = formatDiffForDisplay(plan);
    expect(output).toContain("Clear invalid values");
    expect(output).toContain("status");
    expect(output).toContain("Widen field");
    expect(output).toContain("Review field");
    expect(output).toContain("now required");
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
