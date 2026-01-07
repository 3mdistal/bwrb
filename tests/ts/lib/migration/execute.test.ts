import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "path";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "fs/promises";
import { tmpdir } from "os";
import { executeMigration } from "../../../../src/lib/migration/execute.js";
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
});
