import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Allow unused variables that start with underscore
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    // path.relative() spells paths with backslashes on Windows. These files
    // normalize the result themselves, don't deal in vault paths, or import all
    // of path without calling relative().
    files: ["src/**/*.ts"],
    ignores: [
      "src/lib/vault-relative-path.ts",
      "src/lib/bulk/move.ts",
      "src/lib/discovery.ts",
      "src/lib/docs-site/conceptsSidebarGuard.ts",
      "src/lib/lock-git-exclude.ts",
      "src/lib/migration/history.ts",
      "src/lib/migration/snapshot.ts",
      "src/lib/vaultSelection.ts",
      "src/tools/health/retry-zero-aggregate.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: ["path", "node:path"].map((name) => ({
            name,
            importNames: ["relative"],
            message: "Use vaultRelativePath so vault paths read the same on every platform.",
          })),
        },
      ],
    },
  },
  {
    // Ignore build output, test fixtures, config files, and generated docs-site files
    ignores: ["dist/**", "tests/**", "*.config.js", "*.config.ts", ".claude/**", "docs-site/.astro/**", "docs-site/.cache/**", "docs-site/dist/**"],
  }
);
