# Agent Instructions

## Project Overview

**Bowerbird** is a CLI tool for schema-driven note creation and editing in markdown vaults. It enforces consistent frontmatter structure, enables dynamic field prompts, and provides batch operations for vault maintenance.

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
│   └── template.ts    # Template management (list, new, edit, delete, validate)
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

- **Schema**: Each vault has `.bwrb/schema.json` defining types, enums, and field definitions
- **Types**: Hierarchical (e.g., `objective/task`) with frontmatter definitions
- **Templates**: Reusable note templates in `.bwrb/templates/{type}/{subtype}/*.md` with defaults and body structure
- **Wikilinks**: `[[Note]]` or `"[[Note]]"` format for Obsidian linking

## Documentation Policy

- User-facing CLI behavior docs are canonical in `docs-site/src/content/docs/` (published at https://bwrb.dev).
- `docs/product/` is for rationale/internal notes and should link to canonical docs-site pages for behavior contracts.
- Source-of-truth policy: `docs/product/canonical-docs-policy.md`

## Agent Skill

An OpenCode agent skill for programmatic bwrb usage is maintained at `docs/skill/SKILL.md`. Update this file when adding new commands or changing CLI patterns for automation.

## Development

```sh
pnpm install          # Install dependencies
pnpm dev -- <cmd>     # Run without building
pnpm build            # Build to dist/
pnpm test             # Run vitest tests
pnpm typecheck        # Type checking
```

## Local CI parity

Source of truth: `.github/workflows/ci.yml`.
If docs and CI differ, follow CI.

### Full CI parity (matches CI)

Run these commands in this exact order:

```sh
pnpm build
pnpm verify:pack
pnpm typecheck
pnpm lint
pnpm knip
pnpm test -- --exclude='**/*.pty.test.ts'
```

CI runs Node 22, and this repo pins `pnpm@10.11.0` in `package.json`.

### Recommended pre-push subset (faster, not full parity)

Recommended (optional) quick check before pushing:

```sh
pnpm typecheck && pnpm lint && pnpm knip
```

### Optional local pre-push hook (opt-in, local only)

If you want to automate local checks, you can create a local Git hook (not committed to the repo):

```sh
cat > .git/hooks/pre-push <<'EOF'
#!/usr/bin/env sh
set -eu

pnpm typecheck
pnpm lint
pnpm knip
EOF
chmod +x .git/hooks/pre-push
```

This can slow down pushes, so keep it opt-in per contributor preference.

### Knip notes

Common failures are unused exports, including stale barrel exports. Prefer removing or adjusting exports first. Use `knip.jsonc` ignores only when an export is intentionally retained.

**Important**: When creating a git worktree, run `pnpm build` after `pnpm install`. The command tests (`tests/ts/commands/`) require the built `dist/` output to run correctly.

## Worktrees: Agent Review Input

When working in a git worktree, review agents may not be able to read changed files directly from the worktree filesystem.

Include your diff in the review prompt:

```bash
git fetch origin main --quiet
git diff --no-color origin/main...HEAD > /tmp/bwrb-review.diff
wc -l /tmp/bwrb-review.diff
# Paste the contents of /tmp/bwrb-review.diff into the review prompt
```

If `origin/main` is unavailable, use `main...HEAD` as the diff base.

## Testing

Tests live in `tests/ts/` with fixtures in `tests/fixtures/vault/`. Run `pnpm test` before committing.

**Always use `pnpm test`** - this runs `vitest run` which exits after tests complete. Running `vitest` directly (without `run`) starts watch mode, which is interactive and not suitable for CI or scripting.

**PTY tests**: Tests in `tests/ts/**/*.pty.test.ts` use node-pty to spawn real terminal processes. These are slower (~1s each) but catch interactive UI bugs that unit tests miss. PTY tests automatically skip when node-pty is incompatible (e.g., Node.js 25+).

For a CI-like PTY run with deterministic output, use `pnpm test:pty:ci`. This writes `artifacts/pty-results.json` for structured results (the CI workflow also captures `artifacts/pty.log` for raw output).

PTY test locations:
- `tests/ts/lib/*.pty.test.ts` - Prompt-level tests (input, confirm, select)
- `tests/ts/commands/*.pty.test.ts` - Full command flow tests (new, edit, audit, template)

## Issue Tracking

This project uses GitHub Issues. Use the `gh` CLI for issue management:

```bash
gh issue list                    # List open issues
gh issue view <number>           # View issue details
gh issue create                  # Create new issue
gh issue close <number>          # Close an issue
gh issue edit <number>           # Edit issue
```

### Dependencies

Track blocking relationships in issue bodies using task lists:

```markdown
## Blocked by
- [ ] #12 Schema validation refactor
- [ ] #15 Add enum support
```

Use the `blocked` label for issues that cannot proceed. When closing an issue, check if it unblocks others.

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
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
