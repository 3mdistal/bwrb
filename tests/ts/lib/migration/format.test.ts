import { describe, it, expect } from "vitest";
import {
  formatMigrationResult,
  formatPerNoteChanges,
} from "../../../../src/lib/migration/execute.js";
import type {
  AppliedChange,
  FileMigrationResult,
  MigrationResult,
} from "../../../../src/types/migration.js";

/**
 * Tests for the migration change-preview formatter (#595).
 *
 * Null-ish values (`null`, `undefined`, missing) must render consistently as
 * the single `(empty)` placeholder across every change branch (set / delete /
 * rename), matching the bulk change preview. Previously `null` fell through to
 * the literal string `"null"`.
 */

function resultWith(changes: AppliedChange[]): MigrationResult {
  return {
    dryRun: true,
    fromVersion: "1.0.0",
    toVersion: "1.1.0",
    totalFiles: 1,
    affectedFiles: 1,
    fileResults: [
      {
        filePath: "/vault/Note.md",
        relativePath: "Note.md",
        changes,
        applied: false,
      },
    ],
    errors: [],
  };
}

/** Extract just the change line for a single-change result. */
function changeLine(change: AppliedChange): string {
  const out = formatMigrationResult(resultWith([change]));
  const line = out.split("\n").find((l) => l.trim().startsWith(change.field));
  if (!line) throw new Error(`No change line found in:\n${out}`);
  return line.trim();
}

describe("formatMigrationResult - null/empty rendering", () => {
  describe("adding a field (no prior value)", () => {
    it("renders undefined oldValue as (empty)", () => {
      expect(
        changeLine({
          kind: "set",
          field: "status",
          oldValue: undefined,
          newValue: "todo",
        })
      ).toBe("status: (empty) → todo");
    });

    it("renders null oldValue as (empty), not the literal 'null'", () => {
      expect(
        changeLine({
          kind: "set",
          field: "status",
          oldValue: null,
          newValue: "todo",
        })
      ).toBe("status: (empty) → todo");
    });
  });

  describe("removing a field (no new value)", () => {
    it("renders a value being removed", () => {
      expect(
        changeLine({
          kind: "delete",
          field: "legacy",
          oldValue: "x",
          newValue: undefined,
        })
      ).toBe("legacy: x → (removed)");
    });

    it("renders an explicit-null oldValue as (empty) on delete", () => {
      expect(
        changeLine({
          kind: "delete",
          field: "legacy",
          oldValue: null,
          newValue: undefined,
        })
      ).toBe("legacy: (empty) → (removed)");
    });
  });

  describe("changing a value", () => {
    it("value → null renders newValue as (empty)", () => {
      expect(
        changeLine({
          kind: "set",
          field: "owner",
          oldValue: "alice",
          newValue: null,
        })
      ).toBe("owner: alice → (empty)");
    });

    it("null → value renders oldValue as (empty)", () => {
      expect(
        changeLine({
          kind: "set",
          field: "owner",
          oldValue: null,
          newValue: "bob",
        })
      ).toBe("owner: (empty) → bob");
    });

    it("value → value renders both", () => {
      expect(
        changeLine({
          kind: "set",
          field: "owner",
          oldValue: "alice",
          newValue: "bob",
        })
      ).toBe("owner: alice → bob");
    });

    it("null and undefined render identically (consistency)", () => {
      const fromNull = changeLine({
        kind: "set",
        field: "f",
        oldValue: null,
        newValue: "v",
      });
      const fromUndefined = changeLine({
        kind: "set",
        field: "f",
        oldValue: undefined,
        newValue: "v",
      });
      expect(fromNull).toBe(fromUndefined);
    });
  });

  describe("renaming a field", () => {
    it("carries the value across the rename", () => {
      expect(
        changeLine({
          kind: "rename",
          field: "old_name",
          newField: "new_name",
          oldValue: "v",
          newValue: "v",
        })
      ).toBe("old_name → new_name: v");
    });

    it("renders a null carried value as (empty)", () => {
      expect(
        changeLine({
          kind: "rename",
          field: "old_name",
          newField: "new_name",
          oldValue: null,
          newValue: null,
        })
      ).toBe("old_name → new_name: (empty)");
    });
  });

  describe("array values", () => {
    it("renders arrays in bracketed style", () => {
      expect(
        changeLine({
          kind: "set",
          field: "tags",
          oldValue: ["a", "b"],
          newValue: [],
        })
      ).toBe("tags: [a, b] → []");
    });
  });
});

describe("formatPerNoteChanges", () => {
  function fileResult(
    relativePath: string,
    changes: AppliedChange[]
  ): FileMigrationResult {
    return {
      filePath: `/vault/${relativePath}`,
      relativePath,
      changes,
      applied: false,
    };
  }

  const setChange = (field: string, n: number): AppliedChange => ({
    kind: "set",
    field,
    oldValue: undefined,
    newValue: String(n),
  });

  it("returns an empty string when there are no changes", () => {
    expect(formatPerNoteChanges([])).toBe("");
    expect(formatPerNoteChanges([fileResult("Empty.md", [])])).toBe("");
  });

  it("renders a block per affected note with indented change lines", () => {
    const out = formatPerNoteChanges([
      fileResult("Work/Task.md", [
        { kind: "set", field: "deadline", oldValue: null, newValue: "2026-01-07" },
        {
          kind: "rename",
          field: "owner",
          newField: "assignee",
          oldValue: "alice",
          newValue: "alice",
        },
      ]),
    ]);
    expect(out).toBe(
      [
        "  Work/Task.md:",
        "    deadline: (empty) → 2026-01-07",
        "    owner → assignee: alice",
      ].join("\n")
    );
  });

  it("caps output and appends a '+N more' summary", () => {
    const changes = Array.from({ length: 5 }, (_, i) => setChange(`f${i}`, i));
    const out = formatPerNoteChanges([fileResult("Big.md", changes)], {
      cap: 3,
    });
    const lines = out.split("\n");
    // 1 header + 3 change lines + 1 summary line
    expect(lines).toHaveLength(5);
    expect(lines[lines.length - 1]).toBe("  ... and 2 more changes");
  });

  it("uses singular 'change' when exactly one is truncated", () => {
    const changes = Array.from({ length: 3 }, (_, i) => setChange(`f${i}`, i));
    const out = formatPerNoteChanges([fileResult("Big.md", changes)], {
      cap: 2,
    });
    expect(out.split("\n").pop()).toBe("  ... and 1 more change");
  });

  it("does not truncate when cap is Infinity", () => {
    const changes = Array.from({ length: 50 }, (_, i) => setChange(`f${i}`, i));
    const out = formatPerNoteChanges([fileResult("Big.md", changes)], {
      cap: Infinity,
    });
    expect(out).not.toContain("more change");
    // 1 header + 50 change lines
    expect(out.split("\n")).toHaveLength(51);
  });
});
