import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  loadSchemaSnapshot,
  saveSchemaSnapshot,
  snapshotExists,
} from "../../../../src/lib/migration/snapshot.js";

describe("snapshot", () => {
  let tempDir: string;
  let pikaDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pika-snapshot-test-"));
    pikaDir = join(tempDir, ".pika");
    await mkdir(pikaDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("snapshotExists", () => {
    it("should return false when no snapshot exists", async () => {
      const exists = await snapshotExists(tempDir);
      expect(exists).toBe(false);
    });

    it("should return true when snapshot exists", async () => {
      const snapshotPath = join(pikaDir, "schema.applied.json");
      await writeFile(
        snapshotPath,
        JSON.stringify({
          schemaVersion: "1.0.0",
          snapshotAt: new Date().toISOString(),
          schema: { version: 2, types: {}, enums: {} },
        })
      );

      const exists = await snapshotExists(tempDir);
      expect(exists).toBe(true);
    });
  });

  describe("saveSchemaSnapshot", () => {
    it("should create a snapshot file", async () => {
      const schema = {
        version: 2,
        schemaVersion: "1.0.0",
        types: { task: { output_dir: "Tasks" } },
        enums: { status: ["active", "done"] },
      };

      await saveSchemaSnapshot(tempDir, schema, "1.0.0");

      const snapshotPath = join(pikaDir, "schema.applied.json");
      const content = await readFile(snapshotPath, "utf-8");
      const snapshot = JSON.parse(content);

      expect(snapshot.schemaVersion).toBe("1.0.0");
      expect(snapshot.schema).toEqual(schema);
      expect(snapshot.snapshotAt).toBeDefined();
    });

    it("should overwrite existing snapshot", async () => {
      const schema1 = { version: 2, types: {}, enums: {} };
      const schema2 = {
        version: 2,
        types: { note: { output_dir: "Notes" } },
        enums: {},
      };

      await saveSchemaSnapshot(tempDir, schema1, "1.0.0");
      await saveSchemaSnapshot(tempDir, schema2, "1.1.0");

      const snapshot = await loadSchemaSnapshot(tempDir);
      expect(snapshot?.schemaVersion).toBe("1.1.0");
      expect(snapshot?.schema).toEqual(schema2);
    });
  });

  describe("loadSchemaSnapshot", () => {
    it("should return undefined when no snapshot exists", async () => {
      const snapshot = await loadSchemaSnapshot(tempDir);
      expect(snapshot).toBeUndefined();
    });

    it("should load existing snapshot", async () => {
      const schema = {
        version: 2,
        types: { task: { output_dir: "Tasks" } },
        enums: {},
      };
      await saveSchemaSnapshot(tempDir, schema, "1.0.0");

      const snapshot = await loadSchemaSnapshot(tempDir);

      expect(snapshot).toBeDefined();
      expect(snapshot?.schemaVersion).toBe("1.0.0");
      expect(snapshot?.schema).toEqual(schema);
    });
  });
});
