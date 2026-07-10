# Bowerbird follow-up sweep: #809-#813

## Sweep policy

- Source: product gaps found by the v0.2.0-current documentation audit and linked from merged PR #814.
- Repository: `3mdistal/bwrb`; default branch `main`.
- Refreshed base: `cc04b6ed4fd0b38378424d01cd6086e419249894` (merge commit for PR #814).
- Package/runtime: Node 22; `pnpm@10.11.0`.
- Required checks: strict/up-to-date `Test`, `PTY Tests`, and `Vercel`; zero required approvals; admin enforcement on.
- Delivery: follow-up PRs stay draft, are not marked ready, and are not merged or auto-merged without a new explicit request.
- Full lane contract: exact `anthropic/claude-fable-5` planning and final review with durable prompt/output/metadata logs; isolated implementation; fresh real-use tester; local gates; green CI; successful-user-story handoff.
- Main-worktree preservation: `/Users/alicemoore/Developer/bwrb` has unrelated untracked plans and will not be modified.
- Concurrency: three active child lanes. `#811` and `#813` are bundled because they overlap the `new` command, creation frontmatter, CLI tests, and documentation.

## Task CONFIG-809

- source: GitHub issue #809
- source anchor: https://github.com/3mdistal/bwrb/issues/809
- title: Expose schema-supported date settings through `config`
- problem: `ConfigSchema` accepts `date_format`, `date_granularity`, and `calendars`, while the command's independent allowlist rejects them.
- desired outcome: validated read/write behavior for safe scalar date settings and a deliberate, tested contract for calendar objects that does not duplicate #790 ambiguously.
- acceptance checks: built CLI list/edit behavior; schema validation; text/JSON output; invalid values; docs/skill parity; no regression to existing options.
- manual successful user story: As a vault owner, I can inspect and change supported date configuration through `bwrb config` and receive clear validation for invalid input.
- likely areas: `src/commands/config.ts`, config tests, command/schema docs, `docs/skill/SKILL.md`.
- parallel safety: independent from completion/list; no overlap with `new` lane except shared docs checks.
- status: handoff-ready draft
- child: `/root/config_809`
- branch/PR: `codex/809-config-date-settings`; draft PR [#816](https://github.com/3mdistal/bwrb/pull/816)
- verification: full 2,979 tests passed / 3 skipped; focused source and dist config 38/38 each; PTY 9/9; schema/docs/build gates and disposable built-CLI flow passed
- Fable: exact-model plan `809-*075132`; first review `BLOCKERS` at `080919` caught missing invalid-string/no-write coverage; fixed; follow-up `081350` verdict `NO BLOCKERS`, finish reason `stop`
- fix verification: 2,986 non-PTY tests passed / 3 skipped; focused 174 source + 39 dist config + 9 PTY; schema/docs checks and 41-page build passed
- fix Fable: exact-model final2 `085259` verdict `NO BLOCKERS`, finish reason `stop`; earlier blocker passes preserved in logs
- handoff: first tester FAIL at `b925582` drove strict configured-format parsing; updated head `a47af43`; different retester `/root/test_pr818` PASS with 176 source + 176 dist + 9 PTY and built-CLI round-trip/strict-order/low-year matrix. All CI green; quiet recheck clean; no reviews/threads. Nested calendars remain schema-only / issue #790.

## Task COMPLETION-810

- source: GitHub issue #810
- source anchor: https://github.com/3mdistal/bwrb/issues/810
- title: Synchronize completion candidates with the registered CLI
- problem: root, schema, template, and recent completion tables drift from built Commander help.
- desired outcome: visible commands/subcommands/options complete accurately; hidden compatibility commands remain excluded; contract tests prevent drift.
- acceptance checks: built help-versus-completion matrix; shell scripts; prefix/vault behavior; root/subcommand/option parity; docs updated.
- manual successful user story: As a shell user, tab completion offers every supported visible command and relevant option without suggesting nonexistent commands.
- likely areas: `src/lib/completion.ts`, completion tests, completion docs.
- parallel safety: independent.
- status: handoff-ready draft
- child: `/root/completion_810`
- branch/PR: `codex/810-completion-parity`; draft PR [#815](https://github.com/3mdistal/bwrb/pull/815)
- verification: focused 71/71; full CI-parity build/pack/typecheck/lint/knip and 2,979 tests passed / 3 skipped; schema/docs checks and 41-page docs build passed; built CLI smoke passed
- Fable: exact-model planning logs under `.task-sweep/logs/810-plan-*`; final `.task-sweep/logs/810-final-review-*` verdict `NO BLOCKERS`, finish reason `stop`
- handoff: fresh tester PASS at `f4ad656`; all CI green; quiet recheck clean; no reviews/threads. Fish syntax has generation/unit coverage but local `fish -n` was unavailable; Node 22 CI is runtime authority.

## Task BODY-812

- source: GitHub issue #812
- source anchor: https://github.com/3mdistal/bwrb/issues/812
- title: Make `list --body` search Markdown body content only
- problem: current matching scans serialized Markdown including YAML frontmatter despite a body-only help contract.
- desired outcome: mask frontmatter for `--body`/`--matches` while preserving intended whole-file compatibility only where explicitly named.
- acceptance checks: frontmatter-only false-positive regression; body match/context/line output; case/regex/fuzzy behavior; list/search compatibility; built CLI disposable-vault test; docs/help parity.
- manual successful user story: As a user searching note bodies, frontmatter values no longer appear as body matches, while real Markdown body text and match locations still work.
- likely areas: targeting/search utilities, `src/commands/list.ts`, list/search tests, targeting/command docs.
- parallel safety: independent from config/completion; no overlap with `new` lane.
- status: handoff-ready draft
- child: `/root/body_812`
- branch/PR: `codex/812-body-only-search`; draft PR [#818](https://github.com/3mdistal/bwrb/pull/818)
- verification: full 2,979 tests passed / 3 skipped; 176 PTY passed / 1 skipped; full build/pack/type/lint/knip/schema/docs gates; focused 235 plus final 23; disposable built-CLI story passed
- Fable: exact-model plan plus three review packets under `.task-sweep/logs/812-*`; first review prompted lazy-loading/context/limit fixes; actual-final verdict `NO BLOCKERS`
- handoff: fresh tester PASS at `ac53a26`: 235 focused tests plus built-CLI body/fallback/CRLF/limit matrix; sparse 405-file no-match completed in 444 ms. All CI green; quiet recheck clean; no reviews/threads. Optional fallback-only matched-file double-read is negligible and deferred.

## Task NEW-811-813

- source: GitHub issues #811 and #813
- source anchors: https://github.com/3mdistal/bwrb/issues/811 and https://github.com/3mdistal/bwrb/issues/813
- title: Align note creation with computed output directories and consistent built-in `name`
- problem: schema validation advertises computed `output_dir` that ordinary creation rejects; interactive and JSON creation disagree on persisted `name`.
- desired outcome: creation honors the schema's computed directory contract and persists system-managed `name` consistently across supported creation modes without regressing templates, forks, ownership, filename patterns, or field order.
- acceptance checks: interactive/PTTY and JSON creation; explicit/computed output directories; name collision/filename transformation; templates/scaffolding/ownership/fork boundaries; exact frontmatter order and JSON output; docs/skill parity.
- manual successful user story: As a user creating notes interactively or through automation, the same schema chooses the same directory and records the same built-in identity fields.
- likely areas: `src/commands/new/**`, schema output helpers, new/PTY tests, system-frontmatter and command docs.
- parallel safety: bundled must-serialize lane because both issues touch the same command contract.
- status: handoff-ready draft
- child: `/root/new_811_813`
- branch/PR: `codex/811-813-new-creation-parity`; draft PR [#819](https://github.com/3mdistal/bwrb/pull/819), head `650e7df`
- verification: 2,981 non-PTY passed / 3 skipped; 178 PTY passed / 1 skipped; focused 115 non-PTY + 22 PTY; full build/pack/type/lint/knip/schema/docs and 41-page build passed
- Fable: exact-model plan stop; first review invalid length preserved then retry `NON-BLOCKING`; triage fixes applied; actual-final verdict `NO BLOCKERS`, finish reason `stop`
- handoff: fresh tester PASS at `650e7df`: 188 source + 188 dist + 22 PTY and built-CLI computed/direct/ancestor/identity/order/error/ownership/fork matrix; all CI green; quiet recheck clean; no reviews/threads; no known product risk

## Queue

| Order | Lane | Status | Child | Branch/PR |
| --- | --- | --- | --- | --- |
| 1 | CONFIG-809 | handoff-ready draft | `/root/test_pr818` | [#816](https://github.com/3mdistal/bwrb/pull/816) |
| 1 | COMPLETION-810 | handoff-ready draft | `/root/test_pr815` | [#815](https://github.com/3mdistal/bwrb/pull/815) |
| 1 | BODY-812 | handoff-ready draft | `/root/test_pr818` | [#818](https://github.com/3mdistal/bwrb/pull/818) |
| 2 | NEW-811-813 | handoff-ready draft | `/root/test_pr816` | [#819](https://github.com/3mdistal/bwrb/pull/819) |

## Merge log

- PR #814 merged at `cc04b6ed4fd0b38378424d01cd6086e419249894` after all required checks, zero unresolved review threads, and the babysit quiet-period recheck.
- Final follow-up recheck: `origin/main` remained `cc04b6ed4fd0b38378424d01cd6086e419249894`; PRs #815, #816, #818, and #819 were open/draft, mergeable, `CLEAN`, fully green, feedback-free, and based on current main after the shared three-minute quiet period.
- PR #817 (lineage adoption) remained open/draft and unmerged, so it was intentionally excluded from all shipped-contract assumptions.
- Follow-up delivery stopped at handoff-ready drafts. No follow-up PR was marked ready, merged, or given auto-merge authorization.
