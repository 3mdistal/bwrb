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
    // Ignore build output, test fixtures, config files, and generated docs-site files
    ignores: ["dist/**", "tests/**", "*.config.js", "*.config.ts", "docs-site/.astro/**", "docs-site/.cache/**", "docs-site/dist/**"],
  }
);
