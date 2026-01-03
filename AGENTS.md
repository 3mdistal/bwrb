# Agent Instructions

## Project Overview

**Pika** is a CLI tool for schema-driven note creation and editing in markdown vaults. It enforces consistent frontmatter structure, enables dynamic field prompts, and provides batch operations for vault maintenance.

## Architecture

```
src/
├── index.ts           # CLI entry point (Commander.js)
├── commands/          # Command implementations
│   ├── new.ts         # Create notes with schema-driven prompts
│   ├── edit.ts        # Modify existing notes
│   ├── list.ts        # Query and filter notes
│   ├── open.ts        # Open notes in editor/Obsidian
│   ├── search.ts      # Search notes, generate wikilinks
│   ├── audit.ts       # Validate notes against schema
│   ├── bulk.ts        # Batch frontmatter operations
│   ├── schema.ts      # Schema inspection
│   └── template.ts    # Template management (list, show, new, edit, validate)
├── lib/               # Shared utilities
│   ├── schema.ts      # Schema loading & resolution
│   ├── template.ts    # Template discovery & parsing
│   ├── frontmatter.ts # YAML frontmatter parsing
│   ├── query.ts       # Filter expression evaluation
│   ├── vault.ts       # Vault discovery & file ops
│   ├── prompt.ts      # Interactive prompts (prompts library)
│   ├── validation.ts  # Frontmatter validation
│   ├── audit/         # Audit detection and fix logic
│   ├── bulk/          # Bulk operation utilities
│   └── migration/     # Schema migration (diff, execute, history)
└── types/
    └── schema.ts      # Zod schemas for type safety
```

## Key Concepts

- **Schema**: Each vault has `.pika/schema.json` defining types, enums, and dynamic sources
- **Types**: Hierarchical (e.g., `objective/task`) with frontmatter definitions
- **Templates**: Reusable note templates in `.pika/templates/{type}/{subtype}/*.md` with defaults and body structure
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

**Important**: When creating a git worktree, run `pnpm build` after `pnpm install`. The command tests (`tests/ts/commands/`) require the built `dist/` output to run correctly.

## Testing

Tests live in `tests/ts/` with fixtures in `tests/fixtures/vault/`. Run `pnpm test` before committing.

**Always use `pnpm test`** - this runs `vitest run` which exits after tests complete. Running `vitest` directly (without `run`) starts watch mode, which is interactive and not suitable for CI or scripting.

**PTY tests**: Tests in `tests/ts/**/*.pty.test.ts` use node-pty to spawn real terminal processes. These are slower (~1s each) but catch interactive UI bugs that unit tests miss. PTY tests automatically skip when node-pty is incompatible (e.g., Node.js 25+).

PTY test locations:
- `tests/ts/lib/*.pty.test.ts` - Prompt-level tests (input, confirm, select)
- `tests/ts/commands/*.pty.test.ts` - Full command flow tests (new, edit, audit, template)

## Issue Tracking

This project uses Beads for issue tracking. Load the `beads` skill for commands.

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
