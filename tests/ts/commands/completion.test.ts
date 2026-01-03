import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "child_process";
import path from "path";

const VAULT_DIR = path.join(__dirname, "../../fixtures/vault");
const CLI_PATH = path.join(__dirname, "../../../dist/index.js");

function runCli(args: string, cwd: string = VAULT_DIR): string {
  try {
    return execSync(`node ${CLI_PATH} ${args}`, {
      cwd,
      encoding: "utf-8",
      env: { ...process.env, NO_COLOR: "1", PIKA_VAULT: cwd },
    }).trim();
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string };
    // Return stdout even on error (some commands exit non-zero but produce output)
    if (execError.stdout) return execError.stdout.toString().trim();
    throw error;
  }
}

describe("pika completion command", () => {
  beforeAll(() => {
    // Ensure the CLI is built
    execSync("pnpm build", {
      cwd: path.join(__dirname, "../../.."),
      stdio: "ignore",
    });
  });

  describe("completion bash", () => {
    it("should output a valid bash completion script", () => {
      const output = runCli("completion bash");

      // Should contain bash-specific completion setup
      expect(output).toContain("_pika_completions()");
      expect(output).toContain("complete -F _pika_completions pika");
      expect(output).toContain("COMPREPLY");
      expect(output).toContain("--completions");
    });

    it("should be valid bash syntax", () => {
      const script = runCli("completion bash");
      // Use bash -n to check syntax without executing
      expect(() => {
        execSync(`bash -n`, { input: script, encoding: "utf-8" });
      }).not.toThrow();
    });
  });

  describe("completion zsh", () => {
    it("should output a valid zsh completion script", () => {
      const output = runCli("completion zsh");

      // Should contain zsh-specific completion setup
      expect(output).toContain("#compdef pika");
      expect(output).toContain("_pika()");
      expect(output).toContain("compdef _pika pika");
      expect(output).toContain("--completions");
    });
  });

  describe("completion fish", () => {
    it("should output a valid fish completion script", () => {
      const output = runCli("completion fish");

      // Should contain fish-specific completion setup
      expect(output).toContain("complete -c pika");
      expect(output).toContain("--completions");
    });
  });

  describe("--completions flag", () => {
    it("should return type completions after --type", () => {
      const output = runCli("--completions pika list --type ''");
      const completions = output.split("\n").filter((l) => l.trim());

      // Should include types from the test vault schema
      expect(completions).toContain("task");
      expect(completions).toContain("idea");
    });

    it("should filter type completions by prefix", () => {
      const output = runCli("--completions pika list --type ta");
      const completions = output.split("\n").filter((l) => l.trim());

      expect(completions).toContain("task");
      expect(completions).not.toContain("idea");
    });

    it("should return path completions after --path", () => {
      const output = runCli("--completions pika list --path ''");
      const completions = output.split("\n").filter((l) => l.trim());

      // Should include directories from the test vault
      expect(completions.some((c) => c.includes("Ideas"))).toBe(true);
      expect(completions.some((c) => c.includes("Objectives"))).toBe(true);
    });

    it("should return command completions for bare pika", () => {
      const output = runCli("--completions pika ''");
      const completions = output.split("\n").filter((l) => l.trim());

      // Should include available commands
      expect(completions).toContain("list");
      expect(completions).toContain("new");
      expect(completions).toContain("edit");
      expect(completions).toContain("completion");
    });

    it("should return option completions when current word starts with -", () => {
      const output = runCli("--completions pika list --");
      const completions = output.split("\n").filter((l) => l.trim());

      // Should include targeting options for list command
      expect(completions).toContain("--type");
      expect(completions).toContain("--path");
      expect(completions).toContain("--where");
    });

    it("should fail silently outside a vault", () => {
      // Run from a non-vault directory
      const output = runCli("--completions pika list --type ''", "/tmp");

      // Should return empty or just not crash
      expect(output).toBeDefined();
    });
  });
});
