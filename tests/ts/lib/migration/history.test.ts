import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  loadMigrationHistory,
  recordMigration,
} from "../../../../src/lib/migration/history.js";
import type { MigrationPlan, MigrationResult } from "../../../../src/types/migration.js";

describe("history", () => {
  let tempDir: string;
  let pikaDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pika-history-test-"));
    pikaDir = join(tempDir, ".pika");
    await mkdir(pikaDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("loadMigrationHistory", () => {
    it("should return empty history when no file exists", async () => {
      const history = await loadMigrationHistory(tempDir);
      expect(history.applied).toEqual([]);
    });
  });

  describe("recordMigration", () => {
    it("should create history file and record migration", async () => {
      const plan: MigrationPlan = {
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
        hasChanges: true,
        deterministic: [{ op: "add-field", targetType: "task", field: "assignee" }],
        nonDeterministic: [],
      };

      const result: MigrationResult = {
        dryRun: false,
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
        totalFiles: 10,
        affectedFiles: 5,
        fileResults: [],
        errors: [],
      };

      await recordMigration(tempDir, plan, result);

      const historyPath = join(pikaDir, "migrations.json");
      const content = await readFile(historyPath, "utf-8");
      const history = JSON.parse(content);

      expect(history.applied).toHaveLength(1);
      expect(history.applied[0].version).toBe("1.1.0");
      expect(history.applied[0].notesAffected).toBe(5);
      expect(history.applied[0].operations).toHaveLength(1);
    });

    it("should append to existing history", async () => {
      const plan1: MigrationPlan = {
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
        hasChanges: true,
        deterministic: [{ op: "add-field", targetType: "task", field: "assignee" }],
        nonDeterministic: [],
      };

      const plan2: MigrationPlan = {
        fromVersion: "1.1.0",
        toVersion: "1.2.0",
        hasChanges: true,
        deterministic: [{ op: "add-enum-value", enum: "status", value: "pending" }],
        nonDeterministic: [],
      };

      const result1: MigrationResult = {
        dryRun: false,
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
        totalFiles: 10,
        affectedFiles: 5,
        fileResults: [],
        errors: [],
      };

      const result2: MigrationResult = {
        dryRun: false,
        fromVersion: "1.1.0",
        toVersion: "1.2.0",
        totalFiles: 10,
        affectedFiles: 3,
        fileResults: [],
        errors: [],
      };

      await recordMigration(tempDir, plan1, result1);
      await recordMigration(tempDir, plan2, result2);

      const history = await loadMigrationHistory(tempDir);
      expect(history.applied).toHaveLength(2);
      expect(history.applied[0].version).toBe("1.1.0");
      expect(history.applied[1].version).toBe("1.2.0");
    });
  });
});
