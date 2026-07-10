# Bowerbird documentation parity sweep

## Objective

Bring Bowerbird's documentation fully into line with the shipped product from `v0.2.0` through current `main`, publish the corrections as a thoroughly verified draft pull request, and hand it off green and review-ready without merging.

## Repository and policy facts

- Repository: `3mdistal/bwrb`
- Default branch: `main`
- Working branch: `codex/docs-v020-current-parity`
- Initial refreshed base: `7b741c632805554dff77cf4cae8d42005cea6e3b` (`v0.2.3`, PR #808)
- Package manager: `pnpm@10.11.0`
- Required checks: `Test`, `PTY Tests`, `Vercel`
- Branch protection: strict/up-to-date checks, admin enforcement, pull request required, zero required approvals
- Delivery policy: draft PR only; do not mark ready, merge, enable auto-merge, or bypass policy
- Local tag note: local `v0.1.4` differs from the remote tag, but all tags in the audited range (`v0.2.0` through `v0.2.3`) match their remote refs.

## Normalized task record

- id: `DOCS-V020-CURRENT`
- source: delegated documentation backlog/audit
- source anchor: source task `019f4989-97cf-7ef2-9ab7-c785a9c965a3`
- title: Reconcile maintained documentation with shipped Bowerbird behavior from `v0.2.0` through current `main`
- repo/workspace: `/Users/alicemoore/.codex/worktrees/b18b/bwrb`
- base branch/commit: `origin/main` at `7b741c632805554dff77cf4cae8d42005cea6e3b`
- problem: maintained user and agent documentation may omit, misname, misplace, or misstate shipped behavior across four releases and the merged PRs between them
- desired outcome: every maintained documentation surface describes current behavior, release history stays historically accurate, examples match the built CLI, generated contracts remain in parity, and unmerged behavior is excluded
- acceptance checks: normalized Git/GitHub inventory; surface-by-surface ledger; built-CLI help and representative disposable-vault workflows; docs/schema/full CI-parity gates; independent tester PASS; exact Fable planning/review logs; green conflict-free draft PR
- manual successful user story: As a new or returning Bowerbird user reading any maintained documentation surface, I can understand and correctly use the product that exists from `v0.2.0` through current `main`. Command examples run against the current CLI, release history remains accurate, agent guidance matches the real safety contracts, and I do not encounter stale names, missing major features, or documentation for behavior that never shipped.
- dependencies/blockers: exact `anthropic/claude-fable-5` availability; GitHub auth; local dependencies; required CI; moving `main`
- parallel safety: evidence gathering may use up to three independent lanes; overlapping command/reference/changelog edits must serialize
- status: implementation, fresh tester PASS, all local gates, and final Fable review complete; publication pending
- branch/PR: `codex/docs-v020-current-parity`; PR pending

## Shipped release and PR range

### `v0.2.0` release boundary

- PRs #741, #744, #745 and release PR #747 were merged on the `v0.2.0` boundary and remain in scope for historical/evergreen parity.
- Release tag: `c9b99343ffad08106b842e46e649485a07667ec1`

### `v0.2.0` to `v0.2.1`

- #751 init global vault target
- #753 and #763 relative vault path resolution
- #755 and #757 schema command output aliases
- #758 and #766 structural/common-heading mention suppression
- #760 path-qualified relation refs in edit
- #762 short vault option in completion handling
- #764 relation validation coverage
- #768 clean relation links on new
- #769 non-interactive schema migration
- #770 required-default audit parity
- #771 scalar rejection for list fields
- #772 hierarchy path keying
- #773 migration diffs for prompt and date granularity
- #774 inherited-field structural overrides
- #775 relation-source descendant coverage
- release PR #776, followed by documentation PR #777
- Release tag: `18aa3e3378a7e44190c311d043e3d44c0b7dca3a`

### `v0.2.1` to `v0.2.2`

- #778 mention-noise precision
- #779 mention exclusion configuration
- #781 type-aware relation resolution
- #786 corpus/sentence-position precision guards
- #787 link-once behavior
- release PR #788
- Release tag: `213195ed2ba408b323d7c953ce912bdc6d9db6b2`

### `v0.2.2` to `v0.2.3` / initial current main

- #789 relative-date fields
- #792 custom calendars
- #794 and #797 JSON/prompt-mode exit reliability
- #798 and #800 coherent edit/open JSON metadata
- #801 list/search/open consolidation
- #802 lineage foundations
- #803 native document forks
- #804 list lineage inspection
- #806 fork-safe deletion
- release PR #808
- Release tag and initial current main: `7b741c632805554dff77cf4cae8d42005cea6e3b`

## Audit lanes

| Lane | Independent evidence surface | Ownership | Status | Output |
| --- | --- | --- | --- | --- |
| A | Release/PR inventory and changelog history | history agent | complete | normalized release matrix and findings below |
| B | Current CLI command/help/completion/schema contract | CLI-contract agent | complete | built CLI findings below |
| C | Maintained docs-site, README, `docs/**`, and agent skill coverage | docs-surface agent | complete | surface findings below |

Edits remain serialized on the orchestrator branch after all lane reports, because command reference, changelog, README, and skill language overlap semantically even when their files do not.

## Surface verification matrix

| Surface | Inventory compared | Runtime/help checked | Edited | Gate | Status/findings |
| --- | --- | --- | --- | --- | --- |
| `README.md` | complete | complete | complete | tester PASS | current schema, modern feature overview, completion and runtime limitations |
| root `CHANGELOG.md` | complete | n/a | complete | all local gates PASS | corrected release counts, boundaries, summaries, and legacy heading |
| docs-site changelog | complete | n/a | complete | all local gates PASS | #802 lineage foundation added |
| `docs-site/src/content/docs/**` | complete | complete | complete | tester/docs build PASS | current onboarding, init, completion, config/schema, targeting, roadmaps, JSON, runtime limits |
| `docs/**` product/technical docs | complete | complete | complete | all local gates PASS | current inheritance/migration/targeting/output/roadmap/vision contracts |
| command references/examples | complete | complete | complete | tester PASS | visible init documented; compatibility topology and flags verified |
| schema/reference docs | complete | complete | complete | schema check and tester PASS | calendar/type/config keys and canonical list prose current |
| `docs/skill/SKILL.md` | complete | complete | complete | tester PASS | current vault/schema/config/instance/system-field/list safety guidance |
| shell completion/help contract | complete | complete | complete | tester PASS | actual candidates documented; runtime drift remains #810 |
| `schema.schema.json` / generated artifacts | complete | complete | complete | `pnpm schema:check` PASS | root/public differ only by intentional `$id` |

## Actionable audit findings

### History and releases

- `v0.1.9..v0.2.0` contains 80 non-release PR merges plus release PR #747, not 78.
- The v0.2.0 changelog omitted boundary PRs #741 (optional scalar whitespace parity), #744 (positional app mode parity), and #745 (multi-relation template defaults).
- The v0.2.3 root changelog summary understates the release and both changelogs omit #802 lineage foundations (`reset_on_fork`, immutable provenance, audit integrity contracts).
- The current `v0.2.1` tag points to docs-only PR #777, merged after release PR #776. Record the anomaly without attributing product behavior to #777.
- Root `CHANGELOG.md` also contains an older untagged/pre-publish `0.2.0` section dated 2025-12-29; disambiguate it from the tagged 2026 release.
- GitHub's external v0.2.0 release body still says 78 PRs and omits #744/#745. This metadata is outside the draft docs PR and will be reported as an intentional external erratum.

### Current behavior and maintained surfaces

- README and canonical Quick Start use legacy nested `subtypes` / `frontmatter` / `frontmatter_order` schema syntax; replace with current flat `types`, `extends`, `fields`, and `field_order` examples.
- Current source explicitly key-merges child overrides onto inherited fields, including structural keys. Four migration/inheritance pages still claim structural keys are ignored and must change together.
- Completion docs include hidden `search`/`open`, omit `recent`, and contradict built output.
- Schema reference omits `calendar_default`, field `calendar`, `calendars`, `default_dashboard`, `excluded_directories`, and mention settings.
- Config command docs omit several actually editable keys; agent guidance also recommends unsupported `config edit date_format`.
- Both roadmaps and product vision label numerous shipped features as future/incomplete.
- Targeting docs reverse the `edit`/compatibility-search relationship, misstate `-o`, and omit `list --output content`.
- `docs/technical/inheritance.md` is a legacy behavior mirror with removed flags/schema constructs; replace it with a concise current technical note and canonical links.
- `docs/product/architecture/bwrb-new-command-flow.md` claims exhaustive typed flows but omits the early native-fork path.
- Hierarchical-scope examples use removed per-field `format` rather than `config.link_format`.
- JSON automation/docs overstate uniform envelopes and universal `--output json`; document command-specific shapes and option support.
- Visible `init` has no command-reference page.
- Generated schema prose points to compatibility `search` docs instead of canonical `list` resolution.
- No lineage-adoption command or behavior was found in Git, GitHub, source, help, completion, or docs.

## Fable artifacts

- Planning prompt: `.task-sweep/logs/claude-fable-5-plan-prompt-20260709-213145.md`
- Planning output: `.task-sweep/logs/claude-fable-5-plan-output-20260709-213145.md`
- Planning metadata log: `.task-sweep/logs/claude-fable-5-plan-20260709-213145.log`
- Planning model requested: `anthropic/claude-fable-5`
- Planning backend returned: `anthropic/claude-5-fable-20260609`
- Planning finish reason: `stop`
- Final review prompt: `.task-sweep/logs/claude-fable-5-review-prompt-20260709-221500.md`
- First final review output: `.task-sweep/logs/claude-fable-5-review-output-20260709-221500.md`
- First final review metadata: `.task-sweep/logs/claude-fable-5-review-20260709-221500.log`
- First final review verdict: `NON-BLOCKING`
- Incomplete first-call metadata: `.task-sweep/logs/claude-fable-5-review-attempt-20260709-221500.log` (`finish_reason: length`, no content; rerun preserved rather than hidden)
- Final follow-up prompt: `.task-sweep/logs/claude-fable-5-final-followup-prompt-20260709-221900.md`
- Final follow-up output: `.task-sweep/logs/claude-fable-5-final-followup-output-20260709-221900.md`
- Final follow-up metadata: `.task-sweep/logs/claude-fable-5-final-followup-20260709-221900.log`
- Final follow-up model requested: `anthropic/claude-fable-5`
- Final follow-up backend returned: `anthropic/claude-5-fable-20260609`
- Final follow-up finish reason: `stop`
- Final follow-up verdict: `NO BLOCKERS`
- Review fix-loop: verified 80 non-release PRs; verified #794/#797/#801 in the v0.2.3 window; restored the `audit --fix --auto` exit nuance; confirmed calendar values, Quick Start serialization order, and `JsonError.data`; corrected command-dependent `-o` semantics and the post-`init` schema instruction.

## Independent tester

- Agent: fresh independent tester lane
- Matrix: command spelling; flags; text/JSON shapes; documented examples; list consolidation; relative dates; custom calendars; fork creation/lineage/delete safety; help/reference parity
- Disposable vault evidence: `.task-sweep/logs/fresh-cli-tester-20260709.md`
- Verdict: PASS after fix-loop

## Gates and CI

- Install/build prerequisite: `pnpm install --frozen-lockfile` passed on Node 22.21.1 / pnpm 10.11.0
- `pnpm build`: PASS
- `pnpm verify:pack`: PASS
- `pnpm typecheck`: PASS
- `pnpm lint`: PASS
- `pnpm knip`: PASS
- `pnpm test -- --exclude='**/*.pty.test.ts'`: PASS, 111 files / 2,974 tests passed / 3 skipped
- `pnpm test:pty:ci`: PASS, 94 suites / 176 tests passed / 1 skipped
- `pnpm schema:check`: PASS, generated JSON Schema is current
- `pnpm docs:lint`: PASS
- `pnpm docs:doctor`: PASS
- `pnpm docs:check`: PASS
- `pnpm docs:build`: PASS from a clean Astro cache, 41 pages built and 53 HTML files indexed
- `git diff --check`: PASS
- GitHub required checks: pending

## Moving-main refresh

- Initial refresh: `2026-07-09`, `origin/main` = `7b741c632805554dff77cf4cae8d42005cea6e3b`
- Pre-PR refresh: `2026-07-09`, `origin/main` unchanged at `7b741c632805554dff77cf4cae8d42005cea6e3b`; no newly merged PRs to add
- Pre-handoff refresh/re-audit: pending

## Product follow-ups

- [#809](https://github.com/3mdistal/bwrb/issues/809): schema supports date settings that `config list/edit` rejects. Docs will describe current behavior; no runtime fix in this PR.
- [#810](https://github.com/3mdistal/bwrb/issues/810): root/subcommand/option completion tables drift from registered CLI. Docs will describe current root candidates; no runtime fix in this PR.
- [#811](https://github.com/3mdistal/bwrb/issues/811): schema computes missing `output_dir`, but `new` requires an explicit value. Docs disclose the creation boundary.
- [#812](https://github.com/3mdistal/bwrb/issues/812): historical `--body` matching includes YAML frontmatter. Docs disclose current whole-file behavior.
- [#813](https://github.com/3mdistal/bwrb/issues/813): interactive and JSON creation differ on persisted `name`. Docs and Quick Start describe the shipped split.
- External v0.2.0 GitHub release-body erratum (78 vs 80 PRs and boundary omissions): intentionally deferred because the draft docs PR cannot version that metadata.

## Handoff

- Status: active
- Draft PR: pending
- Conflict state: pending
- CI state: pending
- Review/bot feedback: pending
- Final user-story evidence: pending
