# Agent Instructions

## Project Overview

**ovault** is a CLI tool for schema-driven note creation and editing in Obsidian vaults. It enforces consistent frontmatter structure, enables dynamic field prompts, and provides batch operations for vault maintenance.

## Architecture

```
src/
├── index.ts           # CLI entry point (Commander.js)
├── commands/          # Command implementations
│   ├── new.ts         # Create notes with schema-driven prompts
│   ├── edit.ts        # Modify existing notes
│   ├── list.ts        # Query and filter notes
│   ├── open.ts        # Open notes in editor/Obsidian
│   ├── link.ts        # Generate wikilinks
│   ├── audit.ts       # Validate notes against schema
│   ├── bulk.ts        # Batch frontmatter operations
│   └── schema.ts      # Schema inspection
├── lib/               # Shared utilities
│   ├── schema.ts      # Schema loading & resolution
│   ├── frontmatter.ts # YAML frontmatter parsing
│   ├── query.ts       # Filter expression evaluation
│   ├── vault.ts       # Vault discovery & file ops
│   ├── prompt.ts      # Interactive prompts (prompts library)
│   ├── validation.ts  # Frontmatter validation
│   ├── audit/         # Audit detection and fix logic
│   └── bulk/          # Bulk operation utilities
└── types/
    └── schema.ts      # Zod schemas for type safety
```

## Key Concepts

- **Schema**: Each vault has `.ovault/schema.json` defining types, enums, and dynamic sources
- **Types**: Hierarchical (e.g., `objective/task`) with frontmatter definitions
- **Dynamic sources**: Query vault files for field values (e.g., active milestones)
- **Wikilinks**: `[[Note]]` or `"[[Note]]"` format for Obsidian linking

## Development

```sh
pnpm install          # Install dependencies
pnpm dev -- <cmd>     # Run without building
pnpm build            # Build to dist/
pnpm test             # Run vitest tests
pnpm typecheck        # Type checking
```

## Testing

Tests live in `tests/ts/` with fixtures in `tests/fixtures/vault/`. Run `pnpm test` before committing.

## Issue Tracking

This project uses Beads for issue tracking. Load the `beads` skill for commands.
