import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import {
  parseCompletionRequest,
  getTypeCompletions,
  getPathCompletions,
  getCommandCompletions,
  getOptionCompletions,
  handleCompletionRequest,
  filterByPrefix,
} from "../../../src/lib/completion.js";
import { loadSchema } from "../../../src/lib/schema.js";
import { createTestVault, cleanupTestVault } from "../fixtures/setup.js";

describe("completion", () => {
  describe("parseCompletionRequest", () => {
    it("parses simple command being completed", () => {
      // When completing "list", command is undefined because we're still typing it
      const ctx = parseCompletionRequest(["list"]);
      expect(ctx.words).toEqual(["list"]);
      expect(ctx.current).toBe("list");
      expect(ctx.command).toBeUndefined(); // Still typing the command
    });

    it("parses completed command with option value", () => {
      const ctx = parseCompletionRequest(["list", "--type", "task"]);
      expect(ctx.command).toBe("list");
      expect(ctx.current).toBe("task");
      expect(ctx.previous).toBe("--type");
    });

    it("parses empty current word after option", () => {
      const ctx = parseCompletionRequest(["list", "--type", ""]);
      expect(ctx.command).toBe("list");
      expect(ctx.current).toBe("");
      expect(ctx.previous).toBe("--type");
    });

    it("handles empty array", () => {
      const ctx = parseCompletionRequest([]);
      expect(ctx.command).toBeUndefined();
      expect(ctx.current).toBe("");
    });

    it("handles partial command being typed", () => {
      // When completing a partial command, command is undefined
      const ctx = parseCompletionRequest(["li"]);
      expect(ctx.command).toBeUndefined(); // Still typing the command
      expect(ctx.current).toBe("li");
    });

    it("identifies command when completing next word", () => {
      // When we've typed "list " and are completing the next word
      const ctx = parseCompletionRequest(["list", ""]);
      expect(ctx.command).toBe("list");
      expect(ctx.current).toBe("");
      expect(ctx.previous).toBe("list");
    });
  });

  describe("getTypeCompletions", () => {
    let vaultDir: string;

    beforeEach(async () => {
      vaultDir = await createTestVault();
    });

    afterEach(async () => {
      await cleanupTestVault(vaultDir);
    });

    it("returns all type names from schema", async () => {
      const schema = await loadSchema(vaultDir);
      const types = getTypeCompletions(schema);

      expect(types).toContain("task");
      expect(types).toContain("idea");
      expect(types).toContain("milestone");
      expect(types).toContain("objective");
    });

    it("can be filtered by prefix", async () => {
      const schema = await loadSchema(vaultDir);
      const types = filterByPrefix(getTypeCompletions(schema), "ta");

      expect(types).toContain("task");
      expect(types).not.toContain("idea");
    });
  });

  describe("getPathCompletions", () => {
    let vaultDir: string;

    beforeEach(async () => {
      vaultDir = await createTestVault();
    });

    afterEach(async () => {
      await cleanupTestVault(vaultDir);
    });

    it("returns directories in vault", async () => {
      const paths = await getPathCompletions(vaultDir, "");

      expect(paths).toContain("Ideas/");
      expect(paths).toContain("Objectives/");
    });

    it("excludes .bwrb directory", async () => {
      const paths = await getPathCompletions(vaultDir, "");

      expect(paths).not.toContain(".bwrb/");
    });

    it("filters by prefix", async () => {
      const paths = await getPathCompletions(vaultDir, "Id");

      expect(paths).toContain("Ideas/");
      expect(paths).not.toContain("Objectives/");
    });

    it("handles nested paths", async () => {
      const paths = await getPathCompletions(vaultDir, "Objectives/");

      expect(paths).toContain("Objectives/Milestones/");
      expect(paths).toContain("Objectives/Tasks/");
    });
  });

  describe("getCommandCompletions", () => {
    it("returns all commands", () => {
      const commands = getCommandCompletions();

      expect(commands).toContain("new");
      expect(commands).toContain("edit");
      expect(commands).toContain("list");
      expect(commands).toContain("open");
      expect(commands).toContain("search");
      expect(commands).toContain("audit");
      expect(commands).toContain("bulk");
      expect(commands).toContain("schema");
      expect(commands).toContain("template");
      expect(commands).toContain("delete");
      expect(commands).toContain("completion");
    });

    it("can be filtered by prefix", () => {
      const commands = filterByPrefix(getCommandCompletions(), "li");

      expect(commands).toContain("list");
      expect(commands).not.toContain("new");
    });
  });

  describe("getOptionCompletions", () => {
    it("returns options for list command", () => {
      const options = getOptionCompletions("list");

      expect(options).toContain("--type");
      expect(options).toContain("-t");
      expect(options).toContain("--path");
      expect(options).toContain("-p");
      expect(options).toContain("--where");
      expect(options).toContain("-w");
    });

    it("returns options for new command", () => {
      const options = getOptionCompletions("new");

      expect(options).toContain("--type");
      expect(options).toContain("-t");
    });

    it("can be filtered by prefix", () => {
      const options = filterByPrefix(getOptionCompletions("list"), "--t");

      expect(options).toContain("--type");
      expect(options).toContain("--text");
      expect(options).not.toContain("--path");
    });

    it("returns empty for unknown command", () => {
      const options = getOptionCompletions("unknown");

      expect(options).toEqual([]);
    });
  });

  describe("handleCompletionRequest", () => {
    let vaultDir: string;

    beforeEach(async () => {
      vaultDir = await createTestVault();
    });

    afterEach(async () => {
      await cleanupTestVault(vaultDir);
    });

    it("completes commands when no command given", async () => {
      const completions = await handleCompletionRequest([""], { vault: vaultDir });

      expect(completions).toContain("list");
      expect(completions).toContain("new");
    });

    it("completes partial commands", async () => {
      const completions = await handleCompletionRequest(["li"], { vault: vaultDir });

      expect(completions).toContain("list");
      expect(completions).not.toContain("new");
    });

    it("completes --type values", async () => {
      const completions = await handleCompletionRequest(
        ["list", "--type", ""],
        { vault: vaultDir }
      );

      expect(completions).toContain("task");
      expect(completions).toContain("idea");
    });

    it("completes -t values (short form)", async () => {
      const completions = await handleCompletionRequest(
        ["list", "-t", ""],
        { vault: vaultDir }
      );

      expect(completions).toContain("task");
    });

    it("completes --path values", async () => {
      const completions = await handleCompletionRequest(
        ["list", "--path", ""],
        { vault: vaultDir }
      );

      expect(completions).toContain("Ideas/");
      expect(completions).toContain("Objectives/");
    });

    it("completes nested --path values", async () => {
      const completions = await handleCompletionRequest(
        ["list", "--path", "Objectives/"],
        { vault: vaultDir }
      );

      expect(completions).toContain("Objectives/Milestones/");
      expect(completions).toContain("Objectives/Tasks/");
    });

    it("completes options when current word starts with dash", async () => {
      const completions = await handleCompletionRequest(
        ["list", "--"],
        { vault: vaultDir }
      );

      expect(completions).toContain("--type");
      expect(completions).toContain("--path");
    });

    it("returns empty array when vault not found", async () => {
      const completions = await handleCompletionRequest(
        ["list", "--type", ""],
        { vault: "/nonexistent/path" }
      );

      expect(completions).toEqual([]);
    });

    it("completes completion subcommands", async () => {
      const completions = await handleCompletionRequest(
        ["completion", ""],
        { vault: vaultDir }
      );

      expect(completions).toContain("bash");
      expect(completions).toContain("zsh");
      expect(completions).toContain("fish");
    });
  });

  describe("parseCompletionRequest - subcommand and positional", () => {
    it("identifies subcommand for dashboard command", () => {
      const ctx = parseCompletionRequest(["dashboard", "edit", ""]);
      expect(ctx.command).toBe("dashboard");
      expect(ctx.subcommand).toBe("edit");
      expect(ctx.positionalIndex).toBe(0);
    });

    it("identifies subcommand for template command", () => {
      const ctx = parseCompletionRequest(["template", "delete", "task", ""]);
      expect(ctx.command).toBe("template");
      expect(ctx.subcommand).toBe("delete");
      expect(ctx.positionalIndex).toBe(1); // "task" is first positional, completing second
    });

    it("calculates positionalIndex correctly skipping options", () => {
      // bwrb template edit --vault /path task <completing>
      const ctx = parseCompletionRequest(["template", "edit", "--vault", "/path", "task", ""]);
      expect(ctx.command).toBe("template");
      expect(ctx.subcommand).toBe("edit");
      expect(ctx.positionalIndex).toBe(1); // "task" is pos 0, completing pos 1
    });

    it("has undefined subcommand when not recognized", () => {
      // "unknown" is not a valid dashboard subcommand
      const ctx = parseCompletionRequest(["dashboard", "unknown", ""]);
      expect(ctx.command).toBe("dashboard");
      expect(ctx.subcommand).toBeUndefined();
    });

    it("has undefined subcommand for commands without subcommands", () => {
      const ctx = parseCompletionRequest(["list", "--type", "task", ""]);
      expect(ctx.command).toBe("list");
      expect(ctx.subcommand).toBeUndefined();
    });
  });

  describe("dashboard command completion", () => {
    let vaultDir: string;

    beforeEach(async () => {
      vaultDir = await createTestVault();
    });

    afterEach(async () => {
      await cleanupTestVault(vaultDir);
    });

    it("includes dashboard in command list", () => {
      const commands = getCommandCompletions();
      expect(commands).toContain("dashboard");
    });

    it("returns options for dashboard command", () => {
      const options = getOptionCompletions("dashboard");
      expect(options).toContain("--output");
      expect(options).toContain("-o");
      expect(options).toContain("--json");
    });

    it("completes dashboard subcommands", async () => {
      const completions = await handleCompletionRequest(
        ["dashboard", ""],
        { vault: vaultDir }
      );

      expect(completions).toContain("list");
      expect(completions).toContain("new");
      expect(completions).toContain("edit");
      expect(completions).toContain("delete");
    });

    it("completes dashboard names for positional argument", async () => {
      // Create dashboards file
      await writeFile(
        join(vaultDir, ".bwrb", "dashboards.json"),
        JSON.stringify({
          dashboards: {
            "my-tasks": { type: "task" },
            "active-ideas": { type: "idea", where: ["status == 'active'"] },
          },
        })
      );

      const completions = await handleCompletionRequest(
        ["dashboard", ""],
        { vault: vaultDir }
      );

      // Should include both subcommands and dashboard names
      expect(completions).toContain("list");
      expect(completions).toContain("my-tasks");
      expect(completions).toContain("active-ideas");
    });

    it("completes dashboard names after edit subcommand", async () => {
      await writeFile(
        join(vaultDir, ".bwrb", "dashboards.json"),
        JSON.stringify({
          dashboards: {
            "alpha": { type: "task" },
            "beta": { type: "idea" },
          },
        })
      );

      const completions = await handleCompletionRequest(
        ["dashboard", "edit", ""],
        { vault: vaultDir }
      );

      expect(completions).toContain("alpha");
      expect(completions).toContain("beta");
      expect(completions).not.toContain("list"); // No subcommands here
    });

    it("completes dashboard names after delete subcommand", async () => {
      await writeFile(
        join(vaultDir, ".bwrb", "dashboards.json"),
        JSON.stringify({
          dashboards: {
            "to-delete": { type: "task" },
          },
        })
      );

      const completions = await handleCompletionRequest(
        ["dashboard", "delete", ""],
        { vault: vaultDir }
      );

      expect(completions).toContain("to-delete");
    });

    it("filters dashboard names by prefix", async () => {
      await writeFile(
        join(vaultDir, ".bwrb", "dashboards.json"),
        JSON.stringify({
          dashboards: {
            "task-board": { type: "task" },
            "idea-board": { type: "idea" },
          },
        })
      );

      const completions = await handleCompletionRequest(
        ["dashboard", "edit", "task"],
        { vault: vaultDir }
      );

      expect(completions).toContain("task-board");
      expect(completions).not.toContain("idea-board");
    });
  });

  describe("template command completion", () => {
    let vaultDir: string;

    beforeEach(async () => {
      vaultDir = await createTestVault();
    });

    afterEach(async () => {
      await cleanupTestVault(vaultDir);
    });

    it("completes template subcommands including delete", async () => {
      const completions = await handleCompletionRequest(
        ["template", ""],
        { vault: vaultDir }
      );

      expect(completions).toContain("list");
      expect(completions).toContain("show");
      expect(completions).toContain("new");
      expect(completions).toContain("edit");
      expect(completions).toContain("delete");
      expect(completions).toContain("validate");
    });

    it("completes type names for template edit first positional", async () => {
      const completions = await handleCompletionRequest(
        ["template", "edit", ""],
        { vault: vaultDir }
      );

      expect(completions).toContain("task");
      expect(completions).toContain("idea");
    });

    it("completes template names for template edit second positional", async () => {
      // Create a template
      await mkdir(join(vaultDir, ".bwrb", "templates", "task"), { recursive: true });
      await writeFile(
        join(vaultDir, ".bwrb", "templates", "task", "daily.md"),
        `---
type: template
template-for: task
---
Daily task template
`
      );
      await writeFile(
        join(vaultDir, ".bwrb", "templates", "task", "weekly.md"),
        `---
type: template
template-for: task
---
Weekly task template
`
      );

      const completions = await handleCompletionRequest(
        ["template", "edit", "task", ""],
        { vault: vaultDir }
      );

      expect(completions).toContain("daily");
      expect(completions).toContain("weekly");
    });

    it("completes type names for template show first positional", async () => {
      const completions = await handleCompletionRequest(
        ["template", "show", ""],
        { vault: vaultDir }
      );

      expect(completions).toContain("task");
      expect(completions).toContain("idea");
    });

    it("completes type names for template delete first positional", async () => {
      const completions = await handleCompletionRequest(
        ["template", "delete", ""],
        { vault: vaultDir }
      );

      expect(completions).toContain("task");
      expect(completions).toContain("idea");
    });

    it("completes type names for template list first positional", async () => {
      const completions = await handleCompletionRequest(
        ["template", "list", ""],
        { vault: vaultDir }
      );

      expect(completions).toContain("task");
      expect(completions).toContain("idea");
    });

    it("completes type names for template validate first positional", async () => {
      const completions = await handleCompletionRequest(
        ["template", "validate", ""],
        { vault: vaultDir }
      );

      expect(completions).toContain("task");
    });

    it("handles options interleaved with positionals", async () => {
      await mkdir(join(vaultDir, ".bwrb", "templates", "idea"), { recursive: true });
      await writeFile(
        join(vaultDir, ".bwrb", "templates", "idea", "research.md"),
        `---
type: template
template-for: idea
---
Research template
`
      );

      // bwrb template edit --vault /path idea <completing>
      const completions = await handleCompletionRequest(
        ["template", "edit", "--vault", vaultDir, "idea", ""],
        { vault: vaultDir }
      );

      expect(completions).toContain("research");
    });
  });

  describe("schema command completion", () => {
    let vaultDir: string;

    beforeEach(async () => {
      vaultDir = await createTestVault();
    });

    afterEach(async () => {
      await cleanupTestVault(vaultDir);
    });

    it("completes schema subcommands", async () => {
      const completions = await handleCompletionRequest(
        ["schema", ""],
        { vault: vaultDir }
      );

      expect(completions).toContain("list");
      expect(completions).toContain("new");
      expect(completions).toContain("edit");
      expect(completions).toContain("delete");
      expect(completions).toContain("validate");
      expect(completions).toContain("diff");
      expect(completions).toContain("migrate");
      expect(completions).toContain("history");
    });

    it("completes 'type' and 'field' for schema edit first positional", async () => {
      const completions = await handleCompletionRequest(
        ["schema", "edit", ""],
        { vault: vaultDir }
      );

      expect(completions).toContain("type");
      expect(completions).toContain("field");
    });

    it("completes 'type' and 'field' for schema delete first positional", async () => {
      const completions = await handleCompletionRequest(
        ["schema", "delete", ""],
        { vault: vaultDir }
      );

      expect(completions).toContain("type");
      expect(completions).toContain("field");
    });

    it("completes 'type' and 'field' for schema new first positional", async () => {
      const completions = await handleCompletionRequest(
        ["schema", "new", ""],
        { vault: vaultDir }
      );

      expect(completions).toContain("type");
      expect(completions).toContain("field");
    });

    it("completes type names for schema edit type second positional", async () => {
      const completions = await handleCompletionRequest(
        ["schema", "edit", "type", ""],
        { vault: vaultDir }
      );

      expect(completions).toContain("task");
      expect(completions).toContain("idea");
    });

    it("completes type names for schema delete type second positional", async () => {
      const completions = await handleCompletionRequest(
        ["schema", "delete", "type", ""],
        { vault: vaultDir }
      );

      expect(completions).toContain("task");
      expect(completions).toContain("idea");
    });
  });
});
