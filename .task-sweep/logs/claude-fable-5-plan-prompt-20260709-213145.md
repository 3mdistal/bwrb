You are advising on a repository documentation-parity task before implementation.

## Task

Bring Bowerbird's documentation fully into line with the shipped product from v0.2.0 through current main, publish the corrections as a thoroughly verified draft pull request, and hand it off green and review-ready without merging.

This is a documentation backlog/audit across several weeks of merged product work, not a cosmetic prose pass. Reconstruct shipped behavior from Git/GitHub, current source, generated contracts, built CLI help, and disposable-vault workflows. Preserve release history, describe current behavior in evergreen docs, and exclude unmerged behavior (especially a separate lineage-adoption command thread). Product bugs should become deduplicated follow-ups rather than hidden implementation changes.

## Repository facts

- Repo: `3mdistal/bwrb`
- Default branch: `main`
- Initial current commit: `7b741c632805554dff77cf4cae8d42005cea6e3b` (`v0.2.3`, release PR #808)
- Package manager: `pnpm@10.11.0`
- Required GitHub checks: strict/up-to-date `Test`, `PTY Tests`, and `Vercel`
- Working branch: `codex/docs-v020-current-parity`
- Delivery boundary: draft PR only; do not mark ready, merge, enable auto-merge, or bypass policy
- Canonical user docs: `docs-site/src/content/docs/`
- Other required surfaces: `README.md`, `CHANGELOG.md`, docs-site changelog, all `docs/**`, command references/examples, schema reference, `docs/skill/SKILL.md`, shell completion/help contract, `schema.schema.json` and generated artifacts
- Full local CI parity in order: `pnpm build`; `pnpm verify:pack`; `pnpm typecheck`; `pnpm lint`; `pnpm knip`; `pnpm test -- --exclude='**/*.pty.test.ts'`
- Additional documentation/contracts: `pnpm schema:check`; `pnpm docs:lint`; `pnpm docs:doctor`; `pnpm docs:check`; `pnpm docs:build`; `pnpm test:pty:ci`

## Normalized shipped inventory

### v0.2.0 boundary

- PRs #741, #744, #745 and release #747: scalar whitespace validation, positional mode parity, multi-relation template defaults, plus the full v0.2.0 release inventory (traits, hierarchical scope and `under()`, partial dates, aliases, fuzzy search, recent, generic tree output, audit ingest safety, recurrence, schema discovery/migration/schema generation, template date offsets, nested discovery, multi-select defaults, and correctness hardening).

### v0.2.1

- #751, #753, #763: init/global/relative vault resolution
- #755, #757: documented schema output aliases
- #758, #766: structural/common-heading mention suppression
- #760: path-qualified edit relation refs
- #762: short vault completion handling
- #764: relation validation coverage
- #768: clean relation writes
- #769: non-interactive schema migrations with `--yes` and `--set-version`
- #770, #771: required defaults and list write/audit parity
- #772: hierarchy path keying
- #773, #774, #775: migration diffs for prompt/date granularity, inherited structural overrides, and relation-source descendant coverage
- release #776 and post-release docs #777 for template instance scaffolding

### v0.2.2

- #778, #786: mention precision/noise reduction
- #779: `mention_exclude_types` and `mention_exclude_paths`
- #781: type-aware relation resolution
- #787: `mention_link_once` configuration and audit override
- release #788

### v0.2.3 / initial current main

- #789: relative-date fields with query-time resolution
- #792: custom calendars
- #794, #797, #798, #800: JSON/prompt-mode exit and coherent open metadata
- #801: `list` consolidation; `search`/`open` hidden compatibility commands
- #802: lineage foundation and system-frontmatter/audit contracts
- #803: `new --fork`
- #804: `list --lineage`
- #806: fork-safe delete
- release #808

## Read-only repository context

- `src/index.ts` registers visible root help in this order: `new`, `edit`, `delete`, `list`, `recent`, `schema`, `audit`, `bulk`, `template`, `dashboard`, `init`, `config`, `completion`. It registers `open` and `search` as hidden compatibility commands.
- Current `list` owns `--body`, `--name`, `--fuzzy`, `--matches`, `--lineage`, outputs `text|paths|tree|link|content|json`, and `--open`/`--app`.
- Current `delete` owns lineage safety and `--force` bypass.
- Root and docs-site changelogs already contain 0.2.0-0.2.3 sections, but must be checked against exact tags/releases and current behavior.
- Relative-date and custom-calendar concept pages already exist.
- Command pages for `open` and `search` still exist for compatibility, but completion/reference language must distinguish hidden compatibility from canonical discovery.
- `docs/skill/SKILL.md` already includes custom calendars, relative dates, system `id`/`name`/`forked-from`, fork creation, lineage inspection, and deletion safety, but its complete command/safety contract needs verification against the built CLI.
- `docs/product/roadmap.md` visibly contains stale unchecked items such as `list --fuzzy` and dashboard implementation even though these features shipped; this surface needs shipped-vs-planned correction without rewriting historical rationale into a release note.
- The only current branch diff is the new `.task-sweep/ledger.md`; documentation files are not yet edited.

## Required verification

- Build the CLI and compare command spelling, flags, output shapes, examples, help, completion, and schema generation to maintained docs.
- Use at most three independent evidence lanes; serialize overlapping command/reference/changelog edits.
- A fresh tester must validate disposable-vault workflows for command/help parity, list consolidation, relative dates, custom calendars, native forks/lineage/delete safety, and representative JSON shapes.
- Rebase/refresh against current main before PR and before handoff; re-audit newly merged PRs.
- Run exact-model final review after implementation and testing, then fix-loop on blockers, tester failures, CI, conflicts, and actionable review/bot feedback.

Give a concise implementation and audit plan with:

- likely highest-risk documentation drift and surfaces to inspect first,
- a normalized release-to-surface comparison strategy,
- safe lane boundaries and overlap cautions,
- representative built-CLI and disposable-vault tests,
- historical-changelog versus evergreen-doc handling,
- generated/schema/help/completion parity checks,
- likely product-follow-up boundaries,
- final-review risks and questions.

You have no tools. Do not claim to inspect anything outside this packet. Do not propose mutations beyond the stated documentation-focused task. Treat this as planning advice for another agent.
