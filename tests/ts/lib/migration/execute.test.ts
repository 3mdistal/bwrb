import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "path";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "fs/promises";
import { tmpdir } from "os";
import { executeMigration } from "../../../../src/lib/migration/execute.js";
import { diffSchemas } from "../../../../src/lib/migration/diff.js";
import { loadSchema } from "../../../../src/lib/schema.js";
import type { MigrationPlan } from "../../../../src/types/migration.js";

describe("executeMigration", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "bwrb-migrate-test-"));
    await mkdir(join(testDir, ".bwrb"));
    await mkdir(join(testDir, "Tasks"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("normalize-links operation", () => {
    it("should convert wikilink to markdown link", async () => {
      // Setup schema with markdown link format
      await writeFile(
        join(testDir, ".bwrb/schema.json"),
        JSON.stringify({
          version: 2,
          schemaVersion: "1.0.0",
          config: { link_format: "markdown" },
          types: {
            task: {
              output_dir: "Tasks",
              fields: {
                name: { prompt: "text", required: true },
                parent: { prompt: "relation", source: "task" },
              },
            },
          },
        })
      );

      // Create note with wikilink
      await writeFile(
        join(testDir, "Tasks/Task-1.md"),
        `---
type: task
name: Task One
parent: "[[Task Two]]"
---
# Task One
`
      );

      const schema = await loadSchema(testDir);
      const plan: MigrationPlan = {
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
        hasChanges: true,
        deterministic: [
          { op: "normalize-links", fromFormat: "wikilink", toFormat: "markdown" },
        ],
        nonDeterministic: [],
      };

      const result = await executeMigration({
        vaultDir: testDir,
        schema,
        plan,
        execute: true,
        backup: false,
      });

      expect(result.affectedFiles).toBe(1);
      expect(result.errors).toHaveLength(0);

      const content = await readFile(join(testDir, "Tasks/Task-1.md"), "utf-8");
      expect(content).toContain('parent: "[Task Two](Task Two.md)"');
    });

    it("should convert markdown link to wikilink", async () => {
      // Setup schema with wikilink format
      await writeFile(
        join(testDir, ".bwrb/schema.json"),
        JSON.stringify({
          version: 2,
          schemaVersion: "1.0.0",
          config: { link_format: "wikilink" },
          types: {
            task: {
              output_dir: "Tasks",
              fields: {
                name: { prompt: "text", required: true },
                parent: { prompt: "relation", source: "task" },
              },
            },
          },
        })
      );

      // Create note with markdown link
      await writeFile(
        join(testDir, "Tasks/Task-1.md"),
        `---
type: task
name: Task One
parent: "[Task Two](Task Two.md)"
---
# Task One
`
      );

      const schema = await loadSchema(testDir);
      const plan: MigrationPlan = {
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
        hasChanges: true,
        deterministic: [
          { op: "normalize-links", fromFormat: "markdown", toFormat: "wikilink" },
        ],
        nonDeterministic: [],
      };

      const result = await executeMigration({
        vaultDir: testDir,
        schema,
        plan,
        execute: true,
        backup: false,
      });

      expect(result.affectedFiles).toBe(1);
      expect(result.errors).toHaveLength(0);

      const content = await readFile(join(testDir, "Tasks/Task-1.md"), "utf-8");
      expect(content).toContain('parent: "[[Task Two]]"');
    });

    it("should handle array relation fields (multiple: true)", async () => {
      // Setup schema with array relation field
      await writeFile(
        join(testDir, ".bwrb/schema.json"),
        JSON.stringify({
          version: 2,
          schemaVersion: "1.0.0",
          config: { link_format: "markdown" },
          types: {
            task: {
              output_dir: "Tasks",
              fields: {
                name: { prompt: "text", required: true },
                related: { prompt: "relation", source: "task", multiple: true },
              },
            },
          },
        })
      );

      // Create note with array of wikilinks
      await writeFile(
        join(testDir, "Tasks/Task-1.md"),
        `---
type: task
name: Task One
related:
  - "[[Task Two]]"
  - "[[Task Three]]"
---
# Task One
`
      );

      const schema = await loadSchema(testDir);
      const plan: MigrationPlan = {
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
        hasChanges: true,
        deterministic: [
          { op: "normalize-links", fromFormat: "wikilink", toFormat: "markdown" },
        ],
        nonDeterministic: [],
      };

      const result = await executeMigration({
        vaultDir: testDir,
        schema,
        plan,
        execute: true,
        backup: false,
      });

      expect(result.affectedFiles).toBe(1);
      expect(result.errors).toHaveLength(0);

      const content = await readFile(join(testDir, "Tasks/Task-1.md"), "utf-8");
      expect(content).toContain("[Task Two](Task Two.md)");
      expect(content).toContain("[Task Three](Task Three.md)");
    });

    it("should not modify non-relation fields", async () => {
      // Setup schema
      await writeFile(
        join(testDir, ".bwrb/schema.json"),
        JSON.stringify({
          version: 2,
          schemaVersion: "1.0.0",
          config: { link_format: "markdown" },
          types: {
            task: {
              output_dir: "Tasks",
              fields: {
                name: { prompt: "text", required: true },
                description: { prompt: "text" },
                parent: { prompt: "relation", source: "task" },
              },
            },
          },
        })
      );

      // Create note with text field that looks like a wikilink
      await writeFile(
        join(testDir, "Tasks/Task-1.md"),
        `---
type: task
name: Task One
description: "See [[Other Note]] for details"
parent: "[[Task Two]]"
---
# Task One
`
      );

      const schema = await loadSchema(testDir);
      const plan: MigrationPlan = {
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
        hasChanges: true,
        deterministic: [
          { op: "normalize-links", fromFormat: "wikilink", toFormat: "markdown" },
        ],
        nonDeterministic: [],
      };

      const result = await executeMigration({
        vaultDir: testDir,
        schema,
        plan,
        execute: true,
        backup: false,
      });

      const content = await readFile(join(testDir, "Tasks/Task-1.md"), "utf-8");
      // Relation field should be converted
      expect(content).toContain("[Task Two](Task Two.md)");
      // Non-relation field should NOT be converted (wikilink preserved as-is)
      expect(content).toContain("See [[Other Note]] for details");
    });

    it("should not modify body content", async () => {
      // Setup schema
      await writeFile(
        join(testDir, ".bwrb/schema.json"),
        JSON.stringify({
          version: 2,
          schemaVersion: "1.0.0",
          config: { link_format: "markdown" },
          types: {
            task: {
              output_dir: "Tasks",
              fields: {
                name: { prompt: "text", required: true },
                parent: { prompt: "relation", source: "task" },
              },
            },
          },
        })
      );

      // Create note with wikilink in body
      await writeFile(
        join(testDir, "Tasks/Task-1.md"),
        `---
type: task
name: Task One
parent: "[[Task Two]]"
---
# Task One

See [[Related Task]] for more info.
`
      );

      const schema = await loadSchema(testDir);
      const plan: MigrationPlan = {
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
        hasChanges: true,
        deterministic: [
          { op: "normalize-links", fromFormat: "wikilink", toFormat: "markdown" },
        ],
        nonDeterministic: [],
      };

      const result = await executeMigration({
        vaultDir: testDir,
        schema,
        plan,
        execute: true,
        backup: false,
      });

      const content = await readFile(join(testDir, "Tasks/Task-1.md"), "utf-8");
      // Frontmatter relation should be converted
      expect(content).toContain('parent: "[Task Two](Task Two.md)"');
      // Body wikilink should NOT be converted
      expect(content).toContain("See [[Related Task]] for more info.");
    });

    it("should be idempotent (no change when already in target format)", async () => {
      // Setup schema with markdown format
      await writeFile(
        join(testDir, ".bwrb/schema.json"),
        JSON.stringify({
          version: 2,
          schemaVersion: "1.0.0",
          config: { link_format: "markdown" },
          types: {
            task: {
              output_dir: "Tasks",
              fields: {
                name: { prompt: "text", required: true },
                parent: { prompt: "relation", source: "task" },
              },
            },
          },
        })
      );

      // Create note already in markdown format
      await writeFile(
        join(testDir, "Tasks/Task-1.md"),
        `---
type: task
name: Task One
parent: "[Task Two](Task Two.md)"
---
# Task One
`
      );

      const schema = await loadSchema(testDir);
      const plan: MigrationPlan = {
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
        hasChanges: true,
        deterministic: [
          { op: "normalize-links", fromFormat: "wikilink", toFormat: "markdown" },
        ],
        nonDeterministic: [],
      };

      const result = await executeMigration({
        vaultDir: testDir,
        schema,
        plan,
        execute: true,
        backup: false,
      });

      // No files should be affected since value is already in target format
      expect(result.affectedFiles).toBe(0);
    });

    it("should return dry-run results without modifying files", async () => {
      // Setup schema
      await writeFile(
        join(testDir, ".bwrb/schema.json"),
        JSON.stringify({
          version: 2,
          schemaVersion: "1.0.0",
          config: { link_format: "markdown" },
          types: {
            task: {
              output_dir: "Tasks",
              fields: {
                name: { prompt: "text", required: true },
                parent: { prompt: "relation", source: "task" },
              },
            },
          },
        })
      );

      const originalContent = `---
type: task
name: Task One
parent: "[[Task Two]]"
---
# Task One
`;
      await writeFile(join(testDir, "Tasks/Task-1.md"), originalContent);

      const schema = await loadSchema(testDir);
      const plan: MigrationPlan = {
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
        hasChanges: true,
        deterministic: [
          { op: "normalize-links", fromFormat: "wikilink", toFormat: "markdown" },
        ],
        nonDeterministic: [],
      };

      const result = await executeMigration({
        vaultDir: testDir,
        schema,
        plan,
        execute: false, // Dry-run
        backup: false,
      });

      expect(result.dryRun).toBe(true);
      expect(result.affectedFiles).toBe(1);

      // File should NOT be modified
      const content = await readFile(join(testDir, "Tasks/Task-1.md"), "utf-8");
      expect(content).toBe(originalContent);
    });
  });

  describe("clear-invalid-options operation", () => {
    async function writeStatusSchema(): Promise<void> {
      await writeFile(
        join(testDir, ".bwrb/schema.json"),
        JSON.stringify({
          version: 2,
          schemaVersion: "1.0.0",
          types: {
            task: {
              output_dir: "Tasks",
              fields: {
                name: { prompt: "text", required: true },
                status: { prompt: "select", options: ["active", "completed"] },
              },
            },
          },
        })
      );
    }

    it("removes a scalar value that is no longer an allowed option", async () => {
      await writeStatusSchema();
      await writeFile(
        join(testDir, "Tasks/Task-1.md"),
        `---\ntype: task\nname: Task One\nstatus: archived\n---\n# Task One\n`
      );

      const schema = await loadSchema(testDir);
      const plan: MigrationPlan = {
        fromVersion: "1.0.0",
        toVersion: "2.0.0",
        hasChanges: true,
        deterministic: [],
        nonDeterministic: [
          {
            op: "clear-invalid-options",
            targetType: "task",
            field: "status",
            allowedValues: ["active", "completed"],
          },
        ],
      };

      const result = await executeMigration({
        vaultDir: testDir,
        schema,
        plan,
        execute: true,
        backup: false,
      });

      expect(result.affectedFiles).toBe(1);
      const content = await readFile(join(testDir, "Tasks/Task-1.md"), "utf-8");
      expect(content).not.toContain("status:");
      expect(content).not.toContain("archived");
    });

    it("leaves a still-valid scalar value untouched", async () => {
      await writeStatusSchema();
      await writeFile(
        join(testDir, "Tasks/Task-1.md"),
        `---\ntype: task\nname: Task One\nstatus: active\n---\n# Task One\n`
      );

      const schema = await loadSchema(testDir);
      const plan: MigrationPlan = {
        fromVersion: "1.0.0",
        toVersion: "2.0.0",
        hasChanges: true,
        deterministic: [],
        nonDeterministic: [
          {
            op: "clear-invalid-options",
            targetType: "task",
            field: "status",
            allowedValues: ["active", "completed"],
          },
        ],
      };

      const result = await executeMigration({
        vaultDir: testDir,
        schema,
        plan,
        execute: true,
        backup: false,
      });

      expect(result.affectedFiles).toBe(0);
      const content = await readFile(join(testDir, "Tasks/Task-1.md"), "utf-8");
      expect(content).toContain("status: active");
    });

    it("filters orphaned values out of an array, keeping valid ones", async () => {
      await writeStatusSchema();
      await writeFile(
        join(testDir, "Tasks/Task-1.md"),
        `---\ntype: task\nname: Task One\nstatus:\n  - active\n  - archived\n  - completed\n---\n# Task One\n`
      );

      const schema = await loadSchema(testDir);
      const plan: MigrationPlan = {
        fromVersion: "1.0.0",
        toVersion: "2.0.0",
        hasChanges: true,
        deterministic: [],
        nonDeterministic: [
          {
            op: "clear-invalid-options",
            targetType: "task",
            field: "status",
            allowedValues: ["active", "completed"],
          },
        ],
      };

      const result = await executeMigration({
        vaultDir: testDir,
        schema,
        plan,
        execute: true,
        backup: false,
      });

      expect(result.affectedFiles).toBe(1);
      const content = await readFile(join(testDir, "Tasks/Task-1.md"), "utf-8");
      expect(content).toContain("active");
      expect(content).toContain("completed");
      expect(content).not.toContain("archived");
    });
  });

  // Defect A (#728): a field-changed op on a PARENT-declared field must reach
  // notes of DESCENDANT types that inherit the field. Drives the real diff →
  // execute pipeline so the end-to-end data-loss fix is exercised, not just the
  // op-emission. (diffSchemas now emits one clear-invalid-options per affected
  // type; executeMigration matches by exact note type.)
  describe("inherited field-changed reaches descendant-type notes", () => {
    it("clears an orphaned option in a child-type note when a parent option is removed", async () => {
      // objective declares `phase`; task extends objective and inherits it.
      const oldSchema = {
        version: 2 as const,
        schemaVersion: "1.0.0",
        types: {
          objective: {
            output_dir: "Objectives",
            fields: {
              name: { prompt: "text", required: true },
              phase: {
                prompt: "select",
                options: ["planned", "active", "done", "abandoned"],
              },
            },
          },
          task: {
            extends: "objective",
            output_dir: "Tasks",
            fields: { name: { prompt: "text", required: true } },
          },
        },
      };
      // Remove "abandoned" from objective.phase.
      const newSchema = {
        ...oldSchema,
        schemaVersion: "1.1.0",
        types: {
          ...oldSchema.types,
          objective: {
            ...oldSchema.types.objective,
            fields: {
              name: { prompt: "text", required: true },
              phase: {
                prompt: "select",
                options: ["planned", "active", "done"],
              },
            },
          },
        },
      };

      // Live schema on disk is the NEW one (what the user just edited to).
      await writeFile(
        join(testDir, ".bwrb/schema.json"),
        JSON.stringify(newSchema)
      );
      await mkdir(join(testDir, "Tasks"), { recursive: true });
      // A TASK note (descendant type) holding the now-orphaned parent option.
      await writeFile(
        join(testDir, "Tasks/Task-1.md"),
        `---\ntype: task\nname: Task One\nphase: abandoned\n---\n# Task One\n`
      );

      const schema = await loadSchema(testDir);
      // Build the plan from the real diff engine (not a hand-written op).
      const plan = diffSchemas(oldSchema, newSchema, "1.0.0", "1.1.0");

      // The diff must have produced a clear-invalid-options op targeting `task`.
      expect(
        plan.nonDeterministic.some(
          (op) =>
            op.op === "clear-invalid-options" &&
            op.field === "phase" &&
            op.targetType === "task"
        )
      ).toBe(true);

      const result = await executeMigration({
        vaultDir: testDir,
        schema,
        plan,
        execute: true,
        backup: false,
      });

      expect(result.errors).toHaveLength(0);
      expect(result.affectedFiles).toBe(1);
      const content = await readFile(join(testDir, "Tasks/Task-1.md"), "utf-8");
      // The orphaned value is gone from the inheriting child-type note.
      expect(content).not.toContain("abandoned");
      expect(content).not.toContain("phase:");
    });
  });

  // #728 — a field that gains its FIRST options (unconstrained → constrained)
  // must clean note values now outside the new allowed set, keep in-set values,
  // filter arrays, and fan out to inheriting descendant-type notes.
  describe("newly-constrained field (gains first options) cleans out-of-set note values", () => {
    it("removes a scalar value not in the new option set; keeps one that is; filters arrays", async () => {
      // objective declares `phase` as UNCONSTRAINED text; task inherits it.
      const oldSchema = {
        version: 2 as const,
        schemaVersion: "1.0.0",
        types: {
          objective: {
            output_dir: "Objectives",
            fields: {
              name: { prompt: "text", required: true },
              phase: { prompt: "text" },
              labels: { prompt: "list", multiple: true },
            },
          },
          task: {
            extends: "objective",
            output_dir: "Tasks",
            fields: { name: { prompt: "text", required: true } },
          },
        },
      };
      // phase gains a constraining option set; labels becomes a multi-select.
      const newSchema = {
        ...oldSchema,
        schemaVersion: "1.1.0",
        types: {
          ...oldSchema.types,
          objective: {
            ...oldSchema.types.objective,
            fields: {
              name: { prompt: "text", required: true },
              phase: { prompt: "select", options: ["planned", "active", "done"] },
              labels: {
                prompt: "select",
                options: ["red", "green"],
                multiple: true,
              },
            },
          },
        },
      };

      await writeFile(
        join(testDir, ".bwrb/schema.json"),
        JSON.stringify(newSchema)
      );
      await mkdir(join(testDir, "Objectives"), { recursive: true });
      // An objective note: phase out of set (removed), labels mixed (filtered).
      await writeFile(
        join(testDir, "Objectives/Obj-1.md"),
        `---\ntype: objective\nname: Obj One\nphase: legacy-status\nlabels:\n  - red\n  - purple\n---\n# Obj One\n`
      );
      // An objective note whose phase IS in the new set → must be untouched.
      await writeFile(
        join(testDir, "Objectives/Obj-2.md"),
        `---\ntype: objective\nname: Obj Two\nphase: active\n---\n# Obj Two\n`
      );
      // A descendant TASK note inheriting phase, holding an out-of-set value.
      await writeFile(
        join(testDir, "Tasks/Task-1.md"),
        `---\ntype: task\nname: Task One\nphase: whatever\n---\n# Task One\n`
      );

      const schema = await loadSchema(testDir);
      const plan = diffSchemas(oldSchema, newSchema, "1.0.0", "1.1.0");

      // clear-invalid-options must target both the declaring type and descendant.
      const phaseTargets = plan.nonDeterministic
        .filter((op) => op.op === "clear-invalid-options" && op.field === "phase")
        .map((op) => (op.op === "clear-invalid-options" ? op.targetType : ""));
      expect(phaseTargets).toContain("objective");
      expect(phaseTargets).toContain("task");

      const result = await executeMigration({
        vaultDir: testDir,
        schema,
        plan,
        execute: true,
        backup: false,
      });
      expect(result.errors).toHaveLength(0);

      // Obj-1: out-of-set scalar removed; array filtered to the still-valid member.
      const obj1 = await readFile(join(testDir, "Objectives/Obj-1.md"), "utf-8");
      expect(obj1).not.toContain("legacy-status");
      expect(obj1).not.toContain("phase:");
      expect(obj1).toContain("red");
      expect(obj1).not.toContain("purple");

      // Obj-2: in-set value untouched.
      const obj2 = await readFile(join(testDir, "Objectives/Obj-2.md"), "utf-8");
      expect(obj2).toContain("phase: active");

      // Task-1 (descendant): out-of-set inherited value cleaned under its own type.
      const task1 = await readFile(join(testDir, "Tasks/Task-1.md"), "utf-8");
      expect(task1).not.toContain("whatever");
      expect(task1).not.toContain("phase:");
    });
  });

  // #728 (removal fan-out) — removing a field declared on a PARENT must clean the
  // inherited frontmatter from descendant-type notes too, under their OWN type.
  describe("inherited field-removal reaches descendant-type notes", () => {
    it("removes an inherited field from a child-type note when the parent field is removed", async () => {
      // objective declares `legacy`; task extends objective and inherits it.
      const oldSchema = {
        version: 2 as const,
        schemaVersion: "1.0.0",
        types: {
          objective: {
            output_dir: "Objectives",
            fields: {
              name: { prompt: "text", required: true },
              legacy: { prompt: "text" },
            },
          },
          task: {
            extends: "objective",
            output_dir: "Tasks",
            fields: { name: { prompt: "text", required: true } },
          },
        },
      };
      // Remove objective.legacy.
      const newSchema = {
        ...oldSchema,
        schemaVersion: "2.0.0",
        types: {
          ...oldSchema.types,
          objective: {
            ...oldSchema.types.objective,
            fields: { name: { prompt: "text", required: true } },
          },
        },
      };

      await writeFile(
        join(testDir, ".bwrb/schema.json"),
        JSON.stringify(newSchema)
      );
      await mkdir(join(testDir, "Tasks"), { recursive: true });
      // A TASK note (descendant type) carrying the inherited `legacy` field.
      await writeFile(
        join(testDir, "Tasks/Task-1.md"),
        `---\ntype: task\nname: Task One\nlegacy: stale value\n---\n# Task One\n`
      );

      const schema = await loadSchema(testDir);
      const plan = diffSchemas(oldSchema, newSchema, "1.0.0", "2.0.0");

      // The diff fans out remove-field to BOTH the declaring and inheriting type.
      const removeTargets = plan.nonDeterministic
        .filter((op) => op.op === "remove-field" && op.field === "legacy")
        .map((op) => (op.op === "remove-field" ? op.targetType : ""));
      expect(removeTargets).toContain("objective");
      expect(removeTargets).toContain("task");

      const result = await executeMigration({
        vaultDir: testDir,
        schema,
        plan,
        execute: true,
        backup: false,
      });

      expect(result.errors).toHaveLength(0);
      expect(result.affectedFiles).toBe(1);
      const content = await readFile(join(testDir, "Tasks/Task-1.md"), "utf-8");
      // The inherited field is gone from the child-type note.
      expect(content).not.toContain("legacy:");
      expect(content).not.toContain("stale value");
    });
  });

  // P1 (#728, fourth review) — data-loss guard. A subtype that edits its OWN raw
  // structural override of an INHERITED field changes nothing EFFECTIVELY (the
  // resolver drops the child's structural keys for an inherited field). The diff
  // must emit NO op, so a valid child-note value survives migration. End-to-end:
  // a stale heuristic here would emit clear-invalid-options from the IGNORED raw
  // override and silently delete the note's value.
  describe("subtype raw-override of inherited field does not delete child-note data (P1)", () => {
    it("keeps a valid child-note value when only the subtype's ignored raw options change", async () => {
      // objective declares `phase`; task re-declares it with its OWN options,
      // which resolution IGNORES — task's effective `phase` == objective's.
      const oldSchema = {
        version: 2 as const,
        schemaVersion: "1.0.0",
        types: {
          objective: {
            output_dir: "Objectives",
            fields: {
              name: { prompt: "text", required: true },
              phase: {
                prompt: "select",
                options: ["planned", "active", "done", "abandoned"],
              },
            },
          },
          task: {
            extends: "objective",
            output_dir: "Tasks",
            fields: {
              name: { prompt: "text", required: true },
              // Raw structural override DROPPED by the resolver. Editing these
              // must not touch notes.
              phase: {
                prompt: "select",
                options: ["todo", "doing", "done", "wontfix"],
              },
            },
          },
        },
      };
      // Parent UNCHANGED; only task's ignored raw override narrows (drop "wontfix").
      const newSchema = {
        ...oldSchema,
        schemaVersion: "1.1.0",
        types: {
          ...oldSchema.types,
          task: {
            ...oldSchema.types.task,
            fields: {
              name: { prompt: "text", required: true },
              phase: {
                prompt: "select",
                options: ["todo", "doing", "done"],
              },
            },
          },
        },
      };

      await writeFile(
        join(testDir, ".bwrb/schema.json"),
        JSON.stringify(newSchema)
      );
      await mkdir(join(testDir, "Tasks"), { recursive: true });
      // A task note carrying a value valid under the EFFECTIVE (parent) options.
      await writeFile(
        join(testDir, "Tasks/Task-1.md"),
        `---\ntype: task\nname: Task One\nphase: abandoned\n---\n# Task One\n`
      );

      const schema = await loadSchema(testDir);
      const plan = diffSchemas(oldSchema, newSchema, "1.0.0", "1.1.0");

      // No op may be emitted: the effective schema did not change.
      const allOps = [...plan.deterministic, ...plan.nonDeterministic];
      expect(allOps.some((op) => op.op === "clear-invalid-options")).toBe(false);
      expect(plan.hasChanges).toBe(false);

      const result = await executeMigration({
        vaultDir: testDir,
        schema,
        plan,
        execute: true,
        backup: false,
      });

      expect(result.errors).toHaveLength(0);
      expect(result.affectedFiles).toBe(0);
      const content = await readFile(join(testDir, "Tasks/Task-1.md"), "utf-8");
      // The child note's value SURVIVES — no silent data loss.
      expect(content).toContain("phase: abandoned");
    });
  });

  describe("widen-field-to-multiple operation", () => {
    it("wraps a scalar value into a single-element array", async () => {
      await writeFile(
        join(testDir, ".bwrb/schema.json"),
        JSON.stringify({
          version: 2,
          schemaVersion: "1.0.0",
          types: {
            task: {
              output_dir: "Tasks",
              fields: {
                name: { prompt: "text", required: true },
                tags: { prompt: "list", multiple: true },
              },
            },
          },
        })
      );
      await writeFile(
        join(testDir, "Tasks/Task-1.md"),
        `---\ntype: task\nname: Task One\ntags: urgent\n---\n# Task One\n`
      );

      const schema = await loadSchema(testDir);
      const plan: MigrationPlan = {
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
        hasChanges: true,
        deterministic: [
          { op: "widen-field-to-multiple", targetType: "task", field: "tags" },
        ],
        nonDeterministic: [],
      };

      const result = await executeMigration({
        vaultDir: testDir,
        schema,
        plan,
        execute: true,
        backup: false,
      });

      expect(result.affectedFiles).toBe(1);
      const content = await readFile(join(testDir, "Tasks/Task-1.md"), "utf-8");
      expect(content).toContain("- urgent");
    });

    it("leaves an existing array untouched (idempotent)", async () => {
      await writeFile(
        join(testDir, ".bwrb/schema.json"),
        JSON.stringify({
          version: 2,
          schemaVersion: "1.0.0",
          types: {
            task: {
              output_dir: "Tasks",
              fields: {
                name: { prompt: "text", required: true },
                tags: { prompt: "list", multiple: true },
              },
            },
          },
        })
      );
      await writeFile(
        join(testDir, "Tasks/Task-1.md"),
        `---\ntype: task\nname: Task One\ntags:\n  - urgent\n---\n# Task One\n`
      );

      const schema = await loadSchema(testDir);
      const plan: MigrationPlan = {
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
        hasChanges: true,
        deterministic: [
          { op: "widen-field-to-multiple", targetType: "task", field: "tags" },
        ],
        nonDeterministic: [],
      };

      const result = await executeMigration({
        vaultDir: testDir,
        schema,
        plan,
        execute: true,
        backup: false,
      });

      expect(result.affectedFiles).toBe(0);
    });

    // Defect A (#728): a BLANK scalar (`tags: ""`) is treated as ABSENT by
    // validation (`hasValue` is false) and by `clear-invalid-options`. Widening
    // must NOT wrap it into `['']`, which would be a real (invalid) array element
    // for a multi-select with options. A blank/absent scalar is left as-is.
    it("leaves a blank scalar ('') unwrapped (does not produce [''])", async () => {
      await writeFile(
        join(testDir, ".bwrb/schema.json"),
        JSON.stringify({
          version: 2,
          schemaVersion: "1.0.0",
          types: {
            task: {
              output_dir: "Tasks",
              fields: {
                name: { prompt: "text", required: true },
                tags: { prompt: "list", multiple: true },
              },
            },
          },
        })
      );
      await writeFile(
        join(testDir, "Tasks/Task-1.md"),
        `---\ntype: task\nname: Task One\ntags: ""\n---\n# Task One\n`
      );

      const schema = await loadSchema(testDir);
      const plan: MigrationPlan = {
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
        hasChanges: true,
        deterministic: [
          { op: "widen-field-to-multiple", targetType: "task", field: "tags" },
        ],
        nonDeterministic: [],
      };

      const result = await executeMigration({
        vaultDir: testDir,
        schema,
        plan,
        execute: true,
        backup: false,
      });

      // No change: the blank scalar is left as-is rather than wrapped.
      expect(result.affectedFiles).toBe(0);
      const content = await readFile(join(testDir, "Tasks/Task-1.md"), "utf-8");
      expect(content).not.toContain("- ''");
      expect(content).not.toContain('- ""');
    });
  });

  describe("review-field operation", () => {
    it("is informational and does not modify notes", async () => {
      await writeFile(
        join(testDir, ".bwrb/schema.json"),
        JSON.stringify({
          version: 2,
          schemaVersion: "1.0.0",
          types: {
            task: {
              output_dir: "Tasks",
              fields: {
                name: { prompt: "text", required: true },
                priority: { prompt: "select", options: ["low", "high"], required: true },
              },
            },
          },
        })
      );
      const original = `---\ntype: task\nname: Task One\n---\n# Task One\n`;
      await writeFile(join(testDir, "Tasks/Task-1.md"), original);

      const schema = await loadSchema(testDir);
      const plan: MigrationPlan = {
        fromVersion: "1.0.0",
        toVersion: "2.0.0",
        hasChanges: true,
        deterministic: [],
        nonDeterministic: [
          {
            op: "review-field",
            targetType: "task",
            field: "priority",
            reason: "field is now required; notes missing a value need manual review",
          },
        ],
      };

      const result = await executeMigration({
        vaultDir: testDir,
        schema,
        plan,
        execute: true,
        backup: false,
      });

      expect(result.affectedFiles).toBe(0);
      const content = await readFile(join(testDir, "Tasks/Task-1.md"), "utf-8");
      expect(content).toBe(original);
    });
  });
});
