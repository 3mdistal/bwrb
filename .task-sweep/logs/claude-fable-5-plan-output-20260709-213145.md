# Bowerbird Docs Parity Plan (v0.2.0 → current main)

## 1. Highest-risk drift — inspect first

Ordered by blast radius (user confusion × surface count):

1. **`list` consolidation (#801) + hidden `search`/`open`.** This is a command-topology change: every doc example, README quickstart, SKILL.md, completion contract, and command reference that mentions `search` or `open` as first-class commands is suspect. The existing `open`/`search` pages must be reframed as compatibility shims pointing at `list --open`/`list --fuzzy`/`--body`/`--matches`, and completion docs must reflect hidden-command behavior.
2. **Lineage/fork/delete-safety suite (#802–#806).** New system frontmatter (`id`, `name`, `forked-from`), `new --fork`, `list --lineage`, delete safety + `--force`. High risk of docs describing pre-lineage delete semantics and audit contracts lacking system-frontmatter rules. Also the #1 place where the **unmerged lineage-adoption thread must be excluded** — verify nothing on the branch or in drafted prose references adoption behavior.
3. **`docs/product/roadmap.md`.** Confirmed stale (`list --fuzzy`, dashboard shown unshipped). Shipped items need checkbox/status correction without retroactively rewriting rationale — this is the "shipped vs. planned" hygiene surface reviewers will spot instantly.
4. **Non-interactive schema migration (`--yes`, `--set-version`, #769) and migration diff coverage (#773–#775).** CI/automation docs and schema reference likely omit these; migration docs may describe interactive-only flows.
5. **v0.2.1 vault-resolution changes (#751/#753/#763)** — init/global/relative resolution affects README quickstart, init docs, and config docs; easy to have stale "vault must be…" claims.
6. **Mention-control config (#758/#766, #778/#786, #779, #787)** — `mention_exclude_types`, `mention_exclude_paths`, `mention_link_once` + audit override must appear in schema reference, config docs, and `schema.schema.json` parity.
7. **Relative dates + custom calendars (#789, #792)** — concept pages exist, but check cross-links from field-type/schema reference, query docs (query-time resolution semantics), and SKILL.md coverage of edge cases.
8. **Exit codes / JSON-prompt-mode contracts (#794/#797/#798/#800)** — scripting docs and JSON shape examples are a classic silent-drift zone.

## 2. Normalized release-to-surface comparison strategy

Build a **traceability matrix**: rows = each PR in the shipped inventory; columns = surfaces (README, canonical docs-site pages, command reference, schema reference, SKILL.md, root CHANGELOG, docs-site changelog, `docs/**`, completion/help contract, generated schema artifacts, roadmap). For each cell mark: *documented-correct*, *documented-stale*, *missing*, or *N/A*.

Sources of truth, in priority order:

1. **Built CLI** (`pnpm build`, then invoke help/completion) — canonical for spelling, flags, hidden-command status, output modes.
2. **Current source + generated contracts** (`src/index.ts` registration order, `schema.schema.json`, generated schema output).
3. **Git/GitHub history** (tags v0.2.0–v0.2.3, release PRs #747/#776/#788/#808, per-PR diffs) — canonical for *which version* a behavior landed in, feeding changelog accuracy.
4. Disposable-vault behavior — canonical for output shapes and workflow examples.

Reconcile changelogs against exact tags: root and docs-site changelogs already have 0.2.0–0.2.3 sections; diff each entry against the PR inventory above, correcting attribution (right version, right wording), not rewriting history.

## 3. Lane boundaries and overlap cautions

Three lanes maximum; serialize where files overlap:

- **Lane A — Command surface:** CLI help/completion audit, command reference pages, `open`/`search` compatibility reframing, README examples. Owns `docs-site` command pages + completion docs.
- **Lane B — Concepts/schema/config:** schema reference, mention config keys, migration flags, relative dates/calendars, lineage/system-frontmatter/audit contracts, SKILL.md, roadmap correction.
- **Lane C — History/verification:** changelog reconciliation (both changelogs), release-note accuracy, disposable-vault test scripting, follow-up issue drafting.

**Overlap cautions:** SKILL.md touches both A and B content — assign to B, but B waits for A's built-CLI findings before finalizing the SKILL command/safety contract. Changelog edits (C) must land after A/B settle behavior descriptions, since changelog wording should match evergreen docs. `list` reference edits and `search`/`open` page edits must be one serialized change (same conceptual diff). Roadmap is single-file — one owner only.

## 4. Representative built-CLI and disposable-vault tests

Built CLI (post-`pnpm build`):

- Root `--help`: exact visible order `new, edit, delete, list, recent, schema, audit, bulk, template, dashboard, init, config, completion`; confirm `open`/`search` absent from visible help but still executable.
- `list --help`: confirm `--body --name --fuzzy --matches --lineage`, output modes `text|paths|tree|link|content|json`, `--open`/`--app`.
- `delete --help`: lineage safety language + `--force`.
- `schema migrate --help`: `--yes`, `--set-version`.
- Completion output: hidden commands excluded (or documented behavior), short-vault completion (#762).
- Schema generation output vs. schema reference docs and `schema.schema.json`.

Disposable vault (fresh tester, scripted):

1. Init a vault (test global/relative resolution paths per #751/#763).
2. Create notes with relative-date fields; run a query and confirm query-time resolution.
3. Define a custom calendar; create/query dated notes.
4. `new --fork` a note; verify `id`/`name`/`forked-from` system frontmatter; `list --lineage`; attempt delete of a fork parent (expect safety refusal), then `--force`.
5. `list` with `--fuzzy`, `--body`, `--matches`, each output mode; capture representative JSON for docs examples; verify JSON/prompt-mode exit codes.
6. Run `search`/`open` compatibility commands and confirm parity with `list` equivalents.
7. Mention config exercise: `mention_exclude_types/paths`, `mention_link_once`, audit override; run audit and confirm ingest safety + system-frontmatter contract.
8. Non-interactive migration with `--yes --set-version` including a prompt/date-granularity diff.

## 5. Historical changelog vs. evergreen docs

- **Changelogs are append-only history:** correct factual errors (wrong flag names, wrong version attribution, missing shipped items) within the correct version section; never move behavior descriptions to "current" framing or delete rationale.
- **Evergreen docs describe only current main:** no "as of v0.2.1…" narration; `search`/`open` described as compatibility shims, not per-version deltas.
- **Roadmap:** mark shipped items shipped (checkbox/status), preserving original planning prose; do not convert it into a release note.
- **Exclusion rule:** unmerged lineage-adoption content appears nowhere — not in changelog "unreleased," not in evergreen docs, not in follow-up issue text beyond a neutral reference if needed.

## 6. Generated/schema/help/completion parity checks

Run full contract suite in order after edits and again after final rebase: `pnpm schema:check`, `docs:lint`, `docs:doctor`, `docs:check`, `docs:build`, plus full CI parity chain (`build`, `verify:pack`, `typecheck`, `lint`, `knip`, non-PTY tests) and `pnpm test:pty:ci`. Specific parity assertions:

- `schema.schema.json` includes mention config keys, relative-date field type, calendar config — and schema reference docs match key names exactly.
- Help text quoted in docs matches built help byte-for-byte where docs claim to quote it.
- Completion contract doc matches actual completion script output (hidden commands, short-vault handling).
- If any generated artifact is stale in-repo, regenerating it is in-scope only if the generator is the documented mechanism; if regeneration reveals a generator bug, that's a follow-up (see §7).

## 7. Product follow-up boundaries

File deduplicated issues, do **not** fix in this PR, when:

- Built CLI behavior contradicts its own help text or completion (help bug vs. docs bug — docs describe actual behavior, issue tracks the mismatch).
- Disposable-vault testing reveals broken behavior (e.g., fork-delete safety hole, JSON exit-code inconsistency, migration diff omission).
- Generated schema disagrees with source-of-truth schema types.
- Hidden compatibility commands behave differently from their `list` equivalents.

Dedup discipline: search existing issues first; one issue per root cause; link the doc section that documents observed (buggy) behavior with a note. Never paper over a bug by documenting intended-but-unshipped behavior.

## 8. Final-review risks and open questions

**Risks:**

- **Mid-audit main movement:** new PRs merged during the work invalidate the matrix — the rebase-and-re-audit step before PR and before handoff is mandatory, and the traceability matrix should be re-scanned against any newly merged PRs.
- **Scope creep into product changes:** the temptation to "fix" help text or a generated file inconsistency inline. Delivery boundary is docs + generated-doc artifacts only.
- **Leakage of the lineage-adoption thread** via copied prose, examples, or changelog "unreleased" sections.
- **PTY/Vercel check flakiness** — required strict checks; budget fix-loop time; keep the docs-site build (`docs:build`) green locally before pushing.
- **Changelog "correction vs. rewrite" judgment calls** — reviewers may object to any edit of released sections; keep edits minimal, factual, and justified in the PR description.
- **Draft-only discipline:** no ready-for-review, no auto-merge, no policy bypass.

**Questions to resolve early:**

1. What is the canonical style for documenting hidden compatibility commands — dedicated pages with a deprecation banner, or redirects into `list`? (Affects Lane A structure.)
2. Are changelog edits to already-released sections acceptable per repo convention, or should corrections go only into evergreen docs plus an errata note?
3. Is `docs/skill/SKILL.md` expected to enumerate the *complete* command contract (including hidden commands) or only the canonical surface?
4. Should representative JSON examples in docs be captured verbatim from the disposable vault (with normalized IDs) or hand-authored? Verbatim-with-normalization is safer for parity.
5. What is the dedup key for follow-up issues (labels, title convention) in this repo?

**Suggested execution order:** build + help/completion capture → traceability matrix → Lane A → Lane B (SKILL last) → Lane C changelogs/roadmap → disposable-vault tester pass → contract suite → rebase/re-audit → draft PR → exact-model final review → fix loop → hand off green as draft.