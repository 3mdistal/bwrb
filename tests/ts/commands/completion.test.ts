import { describe, it, expect } from "vitest";
import path from "path";
import { execFileSync } from "child_process";
import { runCLI, PROJECT_ROOT } from "../fixtures/setup.js";

const VAULT_DIR = path.join(PROJECT_ROOT, "tests/fixtures/vault");

async function runCompletionCLI(args: string[], cwd: string = VAULT_DIR): Promise<string> {
  const result = await runCLI(args, {
    cwd,
    vaultDir: cwd,
    env: { NO_COLOR: "1" },
  });
  return result.stdout;
}

describe("bwrb completion command", () => {
  describe("completion bash", () => {
    it("should output a valid bash completion script", async () => {
      const output = await runCompletionCLI(["completion", "bash"]);

      // Should contain bash-specific completion setup
      expect(output).toContain("_bwrb_completions()");
      expect(output).toContain("complete -F _bwrb_completions bwrb");
      expect(output).toContain("COMPREPLY");
      expect(output).toContain("--completions");
    });

    it("should be valid bash syntax", async () => {
      const script = await runCompletionCLI(["completion", "bash"]);
      // Use bash -n to check syntax without executing
      expect(() => {
        execFileSync("bash", ["-n"], { input: script, encoding: "utf-8" });
      }).not.toThrow();
    });
  });

  describe("completion zsh", () => {
    it("should output a valid zsh completion script", async () => {
      const output = await runCompletionCLI(["completion", "zsh"]);

      // Should contain zsh-specific completion setup
      expect(output).toContain("#compdef bwrb");
      expect(output).toContain("_bwrb()");
      expect(output).toContain("compdef _bwrb bwrb");
      expect(output).toContain("--completions");
    });
  });

  describe("completion fish", () => {
    it("should output a valid fish completion script", async () => {
      const output = await runCompletionCLI(["completion", "fish"]);

      // Should contain fish-specific completion setup
      expect(output).toContain("complete -c bwrb");
      expect(output).toContain("--completions");
    });
  });

  describe("--completions flag", () => {
    it("should return type completions after --type", async () => {
      const output = await runCompletionCLI(["--completions", "bwrb", "list", "--type", ""]);
      const completions = output.split("\n").filter((l) => l.trim());

      // Should include types from the test vault schema
      expect(completions).toContain("task");
      expect(completions).toContain("idea");
    });

    it("should filter type completions by prefix", async () => {
      const output = await runCompletionCLI(["--completions", "bwrb", "list", "--type", "ta"]);
      const completions = output.split("\n").filter((l) => l.trim());

      expect(completions).toContain("task");
      expect(completions).not.toContain("idea");
    });

    it("should return path completions after --path", async () => {
      const output = await runCompletionCLI(["--completions", "bwrb", "list", "--path", ""]);
      const completions = output.split("\n").filter((l) => l.trim());

      // Should include directories from the test vault
      expect(completions.some((c) => c.includes("Ideas"))).toBe(true);
      expect(completions.some((c) => c.includes("Objectives"))).toBe(true);
    });

    it("should return command completions for bare bwrb", async () => {
      const output = await runCompletionCLI(["--completions", "bwrb", ""]);
      const completions = output.split("\n").filter((l) => l.trim());

      // Should include available commands
      expect(completions).toContain("list");
      expect(completions).toContain("new");
      expect(completions).toContain("edit");
      expect(completions).toContain("completion");
    });

    it("should return option completions when current word starts with -", async () => {
      const output = await runCompletionCLI(["--completions", "bwrb", "list", "--"]);
      const completions = output.split("\n").filter((l) => l.trim());

      // Should include targeting options for list command
      expect(completions).toContain("--type");
      expect(completions).toContain("--path");
      expect(completions).toContain("--where");
    });

    it("should fail silently outside a vault", async () => {
      // Run from a non-vault directory
      const output = await runCompletionCLI(["--completions", "bwrb", "list", "--type", ""], "/tmp");

      // Should return empty or just not crash
      expect(output).toBeDefined();
    });
  });
});
