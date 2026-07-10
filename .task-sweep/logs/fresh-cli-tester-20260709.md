# Fresh independent CLI tester

VERDICT: PASS

## What was tested

- Built CLI help topology, including hidden-but-callable `search`/`open`, `init`, schema migration flags, and root completion candidates with known #810 drift.
- Quick Start schema verbatim in disposable vaults; schema validation, JSON and PTY creation, filtering, listing, and output shapes.
- Canonical list name/fuzzy/body/matches/content/JSON/open-print flows and compatibility search/open mappings.
- Fork creation, fresh IDs, immediate provenance, `reset_on_fork`, lineage tree/JSON, guarded deletion, forced deletion, and dangling-provenance audit.
- Gregorian relative-date resolution/sort/query/JSON and custom-calendar validation/sort/comparison/JSON.
- Migration initial snapshot, diff, preview, deterministic execution with `--set-version`, nondeterministic execution with `--set-version --yes`, and history.
- Reserved `id`/`forked-from` rejection through JSON creation, edit, and template defaults.
- Config `date_format` limitation and supported `open_with` editing.
- README schema and relation-filter examples.
- Mention exclusion/link-once behavior through focused tests.
- Init positional/global precedence and existing-directory requirement.
- Cleanup through `delete --all --execute --force`, followed by removal of the disposable root.

## Evidence

- `pnpm build`: passed.
- Focused mention/config tests: 109 passed.
- `pnpm schema:check`, `pnpm docs:lint`, `pnpm docs:doctor`, `git diff --check`: passed.
- Clean-cache `pnpm docs:build`: passed, 41 pages built without duplicate-ID warnings.
- Calendar example produced `AR 3019-02-02 266:50` with linear value `4057466.8333333335`.
- All temporary vault notes were deleted through the CLI; `/tmp/bwrb-docs-independent-tester` was removed.

## Failures and fix loop

- Initial custom-calendar snippets referenced an undefined calendar and invalid month. Corrected and retested.
- Runnable calendar type omitted `output_dir`; docs now declare it and disclose #811.
- `--body` whole-file behavior, interactive/JSON `name` persistence, and init's existing-directory requirement were made explicit and retested.
- No unresolved documentation blocker remains.

## Risk left

- Mention behavior used focused existing tests rather than reconstructing the full audit corpus manually.
- This was a representative matrix, not the complete repository CI or full PTY suite; those remain final orchestration gates.
