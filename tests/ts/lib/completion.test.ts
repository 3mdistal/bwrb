import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

    it("excludes .pika directory", async () => {
      const paths = await getPathCompletions(vaultDir, "");

      expect(paths).not.toContain(".pika/");
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
});
