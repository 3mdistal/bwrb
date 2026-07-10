You are reviewing an embedded pull request diff for correctness bugs, missed edge cases, security or data-loss issues, concurrency failures, test gaps, documentation drift, runtime risk, and release risk.

Constraints:
- Review only the embedded diff below.
- Do not use tools.
- Do not edit files.
- Do not stage, commit, push, open/update PRs, mark ready, merge, enable auto-merge, run migrations, or install dependencies.
- Treat this as a PR readiness gate.
- Cite file paths and diff line numbers where possible.
- Start with exactly one verdict label: BLOCKERS, NON-BLOCKING, or NO BLOCKERS.
- Separate blockers from non-blocking suggestions. Only correctness, safety, concurrency, data-integrity, missing-contract, or materially inadequate-test findings should be blockers.
- Review docs against implementation, not just prose style.
- Keep the response short: verdict, blockers if any, non-blocking notes if any.
- The first line must be exactly one of: BLOCKERS, NON-BLOCKING, NO BLOCKERS.

Task contract to assess:
- Add one guarded, dry-run-first `bwrb lineage adopt <child> --from <parent>` edge for existing notes.
- Exact UUID/path/name/alias resolution only; same resolved type; one edge; no force/bulk.
- Refuse self, ambiguity, existing child provenance, missing/invalid types, duplicate/invalid IDs, unsafe/cyclic graphs, and prospective cycles.
- Preserve valid IDs; safely backfill missing parent/child IDs; coordinate adopt/fork/delete through ownership-safe locks.
- Change only missing system IDs and child `forked-from`; preserve bodies, filenames, ordinary metadata, aliases, provider data, and byte-sensitive YAML.
- Stable JSON with planned/applied changes, paths/IDs, warnings, and body-invariance hashes.
- Ordinary new/edit/templates/schema/audit remain unable to mutate `forked-from`.
- Tests must meaningfully cover rollback and races.
- The original implementation introduced a confirmed stale-lock ownership race; the final diff includes a fix using the existing token/inode/heartbeat/recovery primitive plus regression tests. Scrutinize that fix closely.

BEGIN DIFF
diff --git a/.task-sweep/logs/claude-fable-5-plan-20260709-212938.log b/.task-sweep/logs/claude-fable-5-plan-20260709-212938.log
new file mode 100644
index 0000000..79da7c7
--- /dev/null
+++ b/.task-sweep/logs/claude-fable-5-plan-20260709-212938.log
@@ -0,0 +1,6 @@
+model_requested: anthropic/claude-fable-5
+model_returned: anthropic/claude-5-fable-20260609
+finish_reason: stop
+output: .task-sweep/logs/claude-fable-5-plan-output-20260709-212938.md
+chars: 9605 words: 1290
+preview: # Planning advice: `bwrb lineage adopt`\n\n## 1. Namespace answer\n\nKeep `bwerb lineage adopt` as a new top-level `lineage` command group. Rationale: `new` semantics are "create a note" (fork creates the child); `edit` is explicitly forbidden from touching `forked-from` by policy, and grafting an escape hatch into `edit` weakens the immutability story the audit/system-field policy depends on. A dedicated `lineage` namespace also gives a natural home for future read subcommands. Register it in `src/index.ts` in the schema/management or utility block — decide by looking at where `audit`/lock-adjacent commands sit; do not disturb the documented registration order for existing commands.\n\n## Root cause and files to inspect\n\n- **Root cause:** immutability of `forked-from` is enforced across all mut
diff --git a/.task-sweep/logs/claude-fable-5-plan-output-20260709-212938.md b/.task-sweep/logs/claude-fable-5-plan-output-20260709-212938.md
new file mode 100644
index 0000000..ba056ea
--- /dev/null
+++ b/.task-sweep/logs/claude-fable-5-plan-output-20260709-212938.md
@@ -0,0 +1,101 @@
+# Planning advice: `bwrb lineage adopt`
+
+## 1. Namespace answer
+
+Keep `bwerb lineage adopt` as a new top-level `lineage` command group. Rationale: `new` semantics are "create a note" (fork creates the child); `edit` is explicitly forbidden from touching `forked-from` by policy, and grafting an escape hatch into `edit` weakens the immutability story the audit/system-field policy depends on. A dedicated `lineage` namespace also gives a natural home for future read subcommands. Register it in `src/index.ts` in the schema/management or utility block — decide by looking at where `audit`/lock-adjacent commands sit; do not disturb the documented registration order for existing commands.
+
+## Root cause and files to inspect
+
+- **Root cause:** immutability of `forked-from` is enforced across all mutation paths, so historically-known lineage cannot be attached; the fix is a single narrowly-scoped, heavily-validated write path that coexists with existing locks.
+- **Inspect before writing code:**
+  - `src/commands/new/fork.ts` — the canonical lock/backfill/revalidate pattern to mirror.
+  - `src/lib/exact-note-target.ts` — extend `purpose` union (e.g. `'adopt-child' | 'adopt-parent'`) so error nouns distinguish the two targets.
+  - `src/lib/lineage-lock.ts`, `src/lib/lineage.ts`, `src/lib/note-id.ts`, `src/lib/frontmatter.ts` — reuse, don't reimplement.
+  - Delete's lineage guard (per #806) — confirm which paths it locks so adopt's lock set actually collides with it.
+  - `list --lineage` / `new --fork` JSON output for key-naming conventions (snake_case).
+  - `docs/skill/SKILL.md`, `docs-site/src/content/docs/`, completions source, changelog(s).
+
+## Minimal command and library design
+
+- `src/commands/lineage/adopt.ts` (handler) + `src/commands/lineage/index.ts` (subcommand registration). Flags: `--from <parent>` (required), `--execute`, `--output json|text`, and accept `--dry-run` as an explicit no-op alias of the default so scripts can be self-documenting. Do **not** use Commander negated flags.
+- One small new library function, e.g. `validateProspectiveEdge(maps, childId?, parentId?, childPath, parentPath)` in `src/lib/lineage.ts` or adjacent: rejects self-edge, existing `forked-from` on child, duplicate IDs anywhere in the connected components, and the prospective cycle (proposed parent must not have the proposed child as an ancestor; walk parent's ancestor chain with the maps' cycle detection). Fail closed on any malformed/dangling/duplicate state touching either family.
+- Reuse `insertFrontmatterScalarPreservingBytes` for all three possible writes (parent ID backfill, child ID backfill, child `forked-from`). Note it **refuses an existing key** — that property is your safety net against double-writing `forked-from`.
+
+## Precise validation/mutation ordering
+
+**Dry-run (default):**
+1. Resolve child and parent via `resolveExactNoteTarget` with distinct purposes; reject absent/ambiguous.
+2. Same resolved type check; self-edge check (same canonical path or same ID).
+3. Build lineage maps from one fresh snapshot; run prospective-edge validation.
+4. Emit plan JSON (fields that *would* be written, whether IDs would be generated, warnings). No lock acquisition needed for dry-run, but state clearly in JSON that it's advisory (`"mode": "dry-run"`).
+
+**Execute:**
+1. Same pre-lock resolution (cheap fail-fast only; treat results as untrusted).
+2. `withLineageMutationLocks(vaultDir, [childPath, parentPath], ...)` — the helper already dedupes/sorts, so deadlock ordering is handled. If legacy ID backfill needs the `fork-source-id.lock`, acquire it the same way fork does, consistently ordered relative to the lineage locks (mirror fork exactly).
+3. **Inside the lock:** re-read both notes (`parseNote`), re-resolve types, rebuild a fresh snapshot and lineage maps, and rerun *all* validations, including duplicate-ID scan across current notes (as fork does) — never trust pre-lock state.
+4. Ensure parent ID: if missing, `generateUniqueNoteId`, write parent atomically, `registerIssuedNoteId`.
+5. Ensure child ID: same.
+6. Write child `forked-from: <parentId>` via byte-preserving insert + `writeFileAtomic`.
+7. **Rollback contract:** there is no cross-file transaction. Order writes so partial failure is benign: ID backfills alone are harmless (audit-clean, no edge). Only the final child write creates the edge, and it's a single atomic rename. If registry append fails after a backfill, restore original raw bytes as fork does (capture pre-write bytes for both files before touching them). Document in JSON output that ID backfills may persist even if the edge write fails — that's honest and safe.
+
+## JSON schema
+
+Snake_case, matching fork/list conventions:
+
+```json
+{
+  "mode": "dry-run" | "execute",
+  "child": { "path": "...", "id": "...", "id_generated": false },
+  "parent": { "path": "...", "id": "...", "id_generated": true },
+  "changes": [
+    { "path": "...", "field": "id", "value": "...", "status": "planned" | "applied" },
+    { "path": "...", "field": "forked-from", "value": "...", "status": "applied" }
+  ],
+  "body_invariance": { "child_body_unchanged": true, "parent_body_unchanged": true },
+  "warnings": []
+}
+```
+
+For body-invariance evidence, compare pre/post body bytes (or hash) around the frontmatter insert and assert equality in the handler — report the check result, not a promise of transactionality. Errors via `jsonError(..., ExitCodes.VALIDATION_ERROR)`.
+
+## Tests and real CLI checks
+
+Unit/integration (`tests/ts/commands/lineage-adopt.test.ts` modeled on `new-fork.test.ts`):
+- Resolution: UUID/path/basename/name/alias exact matches; ambiguity and absence refusals for **both** child and parent; distinct error nouns.
+- Validation refusals: type mismatch, self-edge (path and ID variants), child already has `forked-from`, duplicate IDs, prospective cycle (adopting an ancestor under a descendant), malformed graph state → fail closed.
+- Mutation: all four ID states (both present / both missing / one missing each way); byte preservation with CRLF, BOM, comments, anchors, block scalars; body hash unchanged; registry updated; audit clean; `list --lineage` shows the family.
+- Dry-run writes nothing (byte-identical vault, no registry append).
+- JSON shape snapshot for both modes.
+
+Concurrency races (real-CLI style like `delete-lineage.test.ts`):
+- **adopt vs adopt:** same child, two parents concurrently → exactly one wins (the loser hits the existing-`forked-from` recheck inside the lock).
+- **adopt vs fork:** fork of the parent while adopt backfills parent ID → no duplicate IDs, registry consistent (exercises `fork-source-id.lock` interaction).
+- **adopt vs delete:** delete parent while adopt executes → adopt either completes before delete's guard sees the edge, or fails cleanly; no dangling edge silently written. Confirm delete's lock set actually overlaps adopt's — if delete only locks certain paths, this is the highest-risk gap.
+
+Built-CLI smoke: disposable vault, dry-run then execute, then `list --lineage` and `audit` proof. Add a PTY test only if interactive output is added (prefer none).
+
+Run full CI parity in exact order: `pnpm build; pnpm verify:pack; pnpm typecheck; pnpm lint; pnpm knip; pnpm test -- --exclude='**/*.pty.test.ts'`. Knip will flag any newly-exported-but-unused helpers — keep the surface minimal.
+
+## Docs/release/completions
+
+- Reference doc page under `docs-site/src/content/docs/` for `lineage adopt` (default dry-run semantics prominent).
+- Update `docs/skill/SKILL.md` with the agent-facing JSON contract.
+- Changelog + docs changelog entries; update system-field policy doc to note the single sanctioned `forked-from` write path.
+- Shell completions for the new `lineage` group and flags.
+- Cross-link from `new --fork` and `list --lineage` docs.
+
+## Risks, edge cases, likely-missed traps
+
+- **Lock coverage gap with delete:** verify adopt's locked paths intersect delete's guard locks; otherwise the adopt/delete race is only probabilistically safe.
+- **Purpose-noun extension:** changing `resolveExactNoteTarget`'s purpose union touches fork's error messages — keep `'fork'`/`'lineage'` behavior byte-identical; add new purposes rather than repurposing.
+- **`insertFrontmatterScalarPreservingBytes` refuses existing keys:** an inside-lock re-read that finds `forked-from` must produce a validation error, not an unhandled throw.
+- **Notes with no frontmatter or invalid YAML:** confirm the insert helper's contract ("valid top-level mapping frontmatter"); refuse cleanly otherwise.
+- **Dangling/duplicate graph state near either note:** fail closed rather than "adopt anyway"; audit is the remediation path.
+- **Scope traps:** no bulk/force mode, no re-parenting, no removal of edges, no vault migration, no schema changes — all explicitly out of scope; resist adding `--force`.
+- **Case-folded path identity:** self-edge check must use the same canonicalization the lock module uses, or case-variant paths could slip a self-edge past validation while still deadlocking or double-locking.
+
+## Parallel/conflict cautions
+
+- PRs #802–#806 established this surface recently; rebase on `origin/main@7b741c6` and watch for in-flight lineage PRs touching `lineage-lock.ts`, `lineage.ts`, or delete guards — coordinate rather than fork behavior.
+- Required checks are `Test`, `PTY Tests`, `Vercel`; the docs-site change will exercise Vercel — keep docs edits in the same PR so the deployment preview validates them.
+- Don't refactor fork's backfill logic into shared helpers unless trivial; behavioral drift in fork is the easiest way to break its extensive existing test suite.
\ No newline at end of file
diff --git a/.task-sweep/logs/claude-fable-5-plan-prompt-20260709-212938.md b/.task-sweep/logs/claude-fable-5-plan-prompt-20260709-212938.md
new file mode 100644
index 0000000..daf9daf
--- /dev/null
+++ b/.task-sweep/logs/claude-fable-5-plan-prompt-20260709-212938.md
@@ -0,0 +1,145 @@
+# TaskSweep early planning packet
+
+You are advising on a repository task before implementation. You have no tools. Do not claim to inspect anything outside this packet. Give advice for another agent; do not propose mutations beyond the stated task.
+
+## Normalized task record
+
+- ID: bwrb-lineage-adopt-2026-07-09
+- Source: `/Users/alicemoore/Developer/teenylilthoughts/briefs/Bowerbird native document lineage migration 2026-07-09.md`
+- Repository: `3mdistal/bwrb`
+- Base: `origin/main` at `7b741c632805554dff77cf4cae8d42005cea6e3b` (`v0.2.3`)
+- Branch: `codex/lineage-adopt` in an isolated worktree
+- Problem: Existing notes whose true historical derivation is known cannot be safely attached to immutable native document lineage. Ordinary edit/create/template/audit paths must stay unable to set or mutate `forked-from`.
+- Desired command (validate against repo conventions):
+  - `bwrb lineage adopt "Child note" --from "Parent note" --dry-run --output json`
+  - `bwrb lineage adopt "Child note" --from "Parent note" --execute --output json`
+- Scope: One parent-to-child edge per invocation. Default dry-run. Explicit `--execute` required for writes. No force/bulk mode.
+- Resolution: child and parent only via existing exact path/name/alias/UUID machinery; reject ambiguous or absent targets.
+- Validation: same resolved type; refuse self-edge, invalid/missing type, existing `forked-from`, duplicate stable IDs anywhere relevant, and any new cycle.
+- Mutation: preserve valid existing IDs; atomically backfill missing parent/child IDs; assign child `forked-from` to parent ID; coordinate with existing fork/delete/adopt locks; preserve bodies, filenames, ordinary frontmatter, aliases, provider fields, and all other bytes.
+- JSON: stable agent-oriented result containing mode, parent/child paths and IDs, planned/applied field changes, warnings, and body-invariance evidence.
+- Docs/release surface: reference docs, changelog/docs changelog, completions, bundled agent skill, system-field policy as appropriate.
+- Testing: focused unit/integration/CLI tests, disposable-vault built CLI smoke, audit/list lineage proof, and fork/delete/adopt race coverage.
+- Out of scope: any migration of the user's teenylilthoughts vault or schema changes described later in the source brief.
+- Successful user story: A vault owner previews and explicitly adopts an existing child under an existing parent without changing prose or ordinary metadata; both gain stable identity if needed; `list --lineage` shows the family; audit stays clean; dishonest/cyclic adoption is refused; concurrent lineage mutations remain safe.
+
+## Repository and policy facts
+
+- TypeScript ESM CLI built with Commander 12, Node 22, `pnpm@10.11.0`.
+- Root command registration order in `src/index.ts`: CRUD, query, schema/management, saved queries, utility.
+- Top-level `lineage` would be new. Current lineage read surface is `list --lineage`; mutation surface is `new --fork`.
+- Full local CI parity, exact order: `pnpm build`; `pnpm verify:pack`; `pnpm typecheck`; `pnpm lint`; `pnpm knip`; `pnpm test -- --exclude='**/*.pty.test.ts'`.
+- Branch protection is strict and current required checks are `Test`, `PTY Tests`, and `Vercel`; required review count is zero; admins are enforced.
+- Canonical user docs are under `docs-site/src/content/docs/`; bundled programmatic skill is `docs/skill/SKILL.md`.
+- Existing lineage feature PRs: #802 foundation/immutability/audit, #803 `new --fork`, #804 `list --lineage`, #806 delete protection and lineage locks.
+
+## Read-only repo context
+
+### Exact note resolution
+
+`src/lib/exact-note-target.ts` exports `resolveExactNoteTarget(schema, vaultDir, target, { purpose })` and returns `{ file, frontmatter, body, typeName, snapshot }`. For `purpose: 'lineage'` it builds one `VaultNoteSnapshot`, constructs maps, and resolves in this strict precedence:
+
+1. case-insensitive UUID (error if duplicates),
+2. absolute/relative path inside the vault,
+3. basename (error if ambiguous),
+4. frontmatter `name` (error if ambiguous),
+5. schema-declared aliases (error if ambiguous).
+
+It never performs fuzzy matching. It rejects a selected note without a valid resolved schema type. Current purpose values are `'fork' | 'lineage'`, so error nouns may need extending to distinguish parent/child adoption targets cleanly.
+
+### Byte-preserving mutation and atomic file write
+
+`src/lib/frontmatter.ts` has:
+
+```ts
+export function insertFrontmatterScalarPreservingBytes(
+  content: string,
+  key: string,
+  value: string
+): string
+```
+
+It inserts one plain scalar into valid top-level mapping frontmatter without reserializing existing YAML. It preserves BOM, EOL, comments, anchors, quotes, block scalars, and body. It refuses an existing key.
+
+```ts
+export async function writeFileAtomic(filePath: string, content: string): Promise<void>
+```
+
+It writes/fsyncs a same-directory exclusive temp file and atomically renames it over one target. There is no obvious cross-file transaction primitive. `new --fork` backfills a source ID, then appends the ID registry; if registry append fails it restores the source's original raw bytes.
+
+### Stable IDs
+
+`src/lib/note-id.ts` exposes `isValidNoteId`, `normalizeNoteId`, `generateUniqueNoteId`, `registerIssuedNoteId`, and `unregisterIssuedNotePath`. Issued IDs are append-only JSONL at `.bwrb/ids.jsonl`; generation avoids IDs already registered. `new --fork` additionally scans current notes for collisions before accepting/backfilling a source ID.
+
+### Existing fork critical section
+
+`src/commands/new/fork.ts` resolves the source, checks an existing ID for uniqueness, then calls:
+
+```ts
+return withLineageMutationLocks(vaultDir, [source.file.path], async () => {
+  const sourceId = await ensureSourceId(schema, vaultDir, source.file.path);
+  const current = await parseNote(source.file.path);
+  // revalidate type, create child exclusively, register child ID
+});
+```
+
+It re-reads after locking. A separate `.bwrb/locks/fork-source-id.lock` serializes legacy source ID backfill. This suggests adoption must acquire locks for both parent and child paths in deterministic order and re-resolve/revalidate all graph invariants inside the critical section, not trust pre-lock state.
+
+### Existing lineage mutation locks
+
+`src/lib/lineage-lock.ts` exports:
+
+```ts
+export async function withLineageMutationLocks<T>(
+  vaultDir: string,
+  sourcePaths: string[],
+  task: () => Promise<T>,
+  optionOverrides: Partial<LineageLockOptions> = {}
+): Promise<T>
+```
+
+It derives a case-folded SHA-256 lock per canonical vault-relative source path, deduplicates and sorts lock paths to avoid deadlock, uses exclusive lock files with ownership tokens/heartbeats, and safely recovers stale locks. `new --fork` locks its source path; non-force delete locks paths whose outgoing/child relationships might be affected.
+
+### Lineage graph
+
+`src/lib/lineage.ts` exposes `buildLineageMaps(snapshot)` with `notesById` and `childrenByParentId`, normalizing UUID identity. `collectLineage(target, maps)` detects duplicate IDs while traversing, warns on invalid/dangling edges and missing child IDs, and deterministically detects cycles. Audit separately detects invalid/missing/dangling/duplicate/cyclic lineage. The adopter needs a narrow prospective-edge cycle predicate; likely equivalent to rejecting when the proposed child is already an ancestor of the proposed parent, while malformed/duplicate graph state should fail closed.
+
+### Current JSON and errors
+
+`list --lineage --output json` returns:
+
+```json
+{
+  "target": { "path": "...", "id": "..." },
+  "nodes": [{ "path": "...", "id": "...", "forked_from": "...", "depth": 0, "relationship": "target" }],
+  "warnings": []
+}
+```
+
+Command handlers use `jsonError(message, { code: ExitCodes.VALIDATION_ERROR })` and exit code 1 for validation failures. `new --fork` returns snake_case keys such as `forked_from`.
+
+### Tests and known contracts
+
+- `tests/ts/commands/new-fork.test.ts`: exact UUID/path/name/alias resolution, ambiguity/fuzzy refusal, concurrent missing-source-ID backfill, byte preservation including CRLF/comments, invalid/duplicate ID refusal, path collision, incompatible flags, ownership rules, and audit-clean lineage.
+- `tests/ts/commands/delete-lineage.test.ts`: non-force delete guards and a sequential real-CLI fork-vs-delete race test.
+- `tests/ts/lib/lineage-lock.test.ts`: deterministic multi-lock acquisition, ownership/heartbeat/stale recovery, and timeout behavior.
+- `tests/ts/commands/list-lineage.test.ts` and `tests/ts/commands/audit-lineage.test.ts`: connected family rendering plus malformed/dangling/duplicate/cycle behavior.
+- Commander negated flag contract: `.option('--no-foo')` sets `options.foo === false`. Avoid a negated flag here if a positive `--execute` is sufficient.
+
+## Questions for the planning review
+
+1. Is `bwrb lineage adopt <child> --from <parent>` the clearest repository-consistent namespace, or is there a strong reason to keep it under `new`/`edit` despite immutability boundaries?
+2. What is the safest minimal algorithm for dry-run and execute, especially lock scope, fresh snapshot timing, duplicate-ID validation, cycle validation, and rollback across two notes plus `.bwrb/ids.jsonl`?
+3. What JSON schema makes planned versus applied changes and byte/body invariance clear and stable without promising impossible filesystem transaction semantics?
+4. Which concurrency races must be tested among adopt/adopt, adopt/fork, and adopt/delete?
+5. Which failure modes or scope traps are most likely to be missed?
+
+Give a concise implementation plan with:
+
+- root-cause and files to inspect,
+- minimal command and library design,
+- precise validation/mutation ordering,
+- tests and real CLI checks,
+- docs/release/completion updates,
+- risks and edge cases,
+- parallel/conflict cautions.
diff --git a/CHANGELOG.md b/CHANGELOG.md
index 058c59c..ebb2e7b 100644
--- a/CHANGELOG.md
+++ b/CHANGELOG.md
@@ -4,6 +4,10 @@ All notable changes to Bowerbird are documented in this file.
 
 ## [Unreleased]
 
+### Added
+
+- **Existing-note lineage adoption** — `bwrb lineage adopt <child> --from <parent>` previews by default and requires `--execute` to attach one exact, same-type existing note under another. It safely backfills missing IDs, refuses ambiguous, duplicate, malformed, dishonest, or cyclic edges, coordinates with fork/delete lineage locks, preserves bodies and ordinary metadata byte-for-byte, and returns agent-friendly change and body-hash evidence in JSON.
+
 ## [0.2.3] - 2026-07-09
 
 Patch release for relative dates and custom calendars, canonical list/search/open
diff --git a/README.md b/README.md
index d0029ae..b67c708 100644
--- a/README.md
+++ b/README.md
@@ -115,6 +115,10 @@ bwrb list --id "<uuid>" --open --app print
 bwrb new --fork "Briefs/Launch Brief" --label concise --output json
 bwrb list --lineage "Briefs/Launch Brief" --output tree
 
+# Adopt two existing same-type notes after previewing the exact guarded change
+bwrb lineage adopt "Launch Brief v2" --from "Launch Brief" --dry-run --output json
+bwrb lineage adopt "Launch Brief v2" --from "Launch Brief" --execute --output json
+
 # Help
 bwrb --help
 bwrb list --help
@@ -603,7 +607,7 @@ bwrb completion fish > ~/.config/fish/completions/bwrb.fish
 ### What Gets Completed
 
 - **Commands**: `bwrb <TAB>` shows `new`, `edit`, `list`, `recent`, `audit`,
-  `bulk`, `schema`, `template`, `dashboard`, `delete`, `completion`, and `config`.
+  `bulk`, `schema`, `template`, `lineage`, `dashboard`, `delete`, `completion`, and `config`.
   `init` appears in `bwrb --help` but is currently missing from generated root
   completion candidates ([#810](https://github.com/3mdistal/bwrb/issues/810)).
 - **Options**: `bwrb list -<TAB>` shows `--type`, `--path`, `--where`, etc.
diff --git a/docs-site/astro.config.mjs b/docs-site/astro.config.mjs
index 8c8b540..63b4784 100644
--- a/docs-site/astro.config.mjs
+++ b/docs-site/astro.config.mjs
@@ -77,6 +77,7 @@ export default defineConfig({
 								{ slug: 'reference/commands/audit' },
 								{ slug: 'reference/commands/bulk' },
 								{ slug: 'reference/commands/template' },
+								{ slug: 'reference/commands/lineage' },
 								{ slug: 'reference/commands/dashboard' },
 								{ slug: 'reference/commands/init' },
 								{ slug: 'reference/commands/config' },
diff --git a/docs-site/src/content/docs/automation/json-mode.md b/docs-site/src/content/docs/automation/json-mode.md
index b80bb6c..822bdec 100644
--- a/docs-site/src/content/docs/automation/json-mode.md
+++ b/docs-site/src/content/docs/automation/json-mode.md
@@ -30,6 +30,7 @@ complete JSON value, but success shapes differ by workflow:
 | `list --body ... --matches --output json` | Match report with `success`, `data`, `totalMatches`, and `truncated` |
 | `list --lineage ... --output json` | Raw `{ "target", "nodes", "warnings" }` object |
 | `new --fork ... --output json` | `{ "success": true, "path", "id", "forked_from", "warnings" }` |
+| `lineage adopt ... --output json` | `{ "success": true, "mode", "child", "parent", "changes", "warnings", "body_invariance" }` |
 
 Normal list output is intentionally a raw array:
 
@@ -50,6 +51,12 @@ Lineage output is a raw graph object, not a `data` envelope:
 bwrb list --lineage "Briefs/Launch Brief" --output json | jq '.nodes[]'
 ```
 
+Adoption output uses a success envelope because it describes a planned or
+applied mutation. Preview is the default; require `mode == "dry-run"`, review
+the paths and changes, and then rerun with `--execute`. Generated preview IDs
+are provisional. Both `body_invariance.child.unchanged` and
+`body_invariance.parent.unchanged` should be `true`.
+
 ## JSON input
 
 `new` and `edit` accept frontmatter payloads directly:
diff --git a/docs-site/src/content/docs/automation/shell-completion.md b/docs-site/src/content/docs/automation/shell-completion.md
index f4672be..c9f91ea 100644
--- a/docs-site/src/content/docs/automation/shell-completion.md
+++ b/docs-site/src/content/docs/automation/shell-completion.md
@@ -35,7 +35,7 @@ bwrb completion fish > ~/.config/fish/completions/bwrb.fish
 
 | Context | Completion |
 |---------|------------|
-| `bwrb <TAB>` | Commands: `new`, `edit`, `list`, `recent`, `audit`, `bulk`, `schema`, `template`, `dashboard`, `delete`, `completion`, `config` |
+| `bwrb <TAB>` | Commands: `new`, `edit`, `list`, `recent`, `audit`, `bulk`, `schema`, `template`, `lineage`, `dashboard`, `delete`, `completion`, `config` |
 | `bwrb list -<TAB>` | Options: `--type`, `--path`, `--where`... |
 | `bwrb new <TAB>` | Types from schema: `task`, `idea`... |
 | `bwrb list --path <TAB>` | Directories: `Ideas/`, `Projects/`... |
diff --git a/docs-site/src/content/docs/changelog.md b/docs-site/src/content/docs/changelog.md
index 585cdd5..59fd1ea 100644
--- a/docs-site/src/content/docs/changelog.md
+++ b/docs-site/src/content/docs/changelog.md
@@ -9,6 +9,10 @@ For the complete changelog with all details, see [CHANGELOG.md](https://github.c
 
 ## Recent Highlights
 
+### Unreleased
+
+- **Existing-note lineage adoption** — `bwrb lineage adopt <child> --from <parent>` adds a dry-run-first, lock-coordinated path for recording known derivation between existing same-type notes without rewriting their bodies or ordinary metadata
+
 ### 0.2.3
 
 - **Relative-date fields** — position notes before, after, or equal to other notes, with query-time resolution and audit warnings for invalid chains
diff --git a/docs-site/src/content/docs/getting-started/installation.md b/docs-site/src/content/docs/getting-started/installation.md
index 5230142..0e05c5a 100644
--- a/docs-site/src/content/docs/getting-started/installation.md
+++ b/docs-site/src/content/docs/getting-started/installation.md
@@ -85,7 +85,7 @@ bwrb completion fish > ~/.config/fish/completions/bwrb.fish
 ### What Gets Completed
 
 - **Commands**: `bwrb <TAB>` shows `new`, `edit`, `list`, `recent`, `audit`,
-  `bulk`, `schema`, `template`, `dashboard`, `delete`, `completion`, and
+  `bulk`, `schema`, `template`, `lineage`, `dashboard`, `delete`, `completion`, and
   `config`. `init` is visible in help but currently missing from completion
   candidates ([#810](https://github.com/3mdistal/bwrb/issues/810)).
 - **Options**: `bwrb list -<TAB>` shows `--type`, `--path`, `--where`, etc.
diff --git a/docs-site/src/content/docs/reference/commands/audit.md b/docs-site/src/content/docs/reference/commands/audit.md
index 9a0e70a..9204f0a 100644
--- a/docs-site/src/content/docs/reference/commands/audit.md
+++ b/docs-site/src/content/docs/reference/commands/audit.md
@@ -107,7 +107,7 @@ Delete semantics in repair mode:
 | `missing-successor` | A [recurring](/automation/task-system/) note satisfies its trigger (e.g. `status = done`) but its chain field (`next`) is empty — a successor was never spawned (e.g. completed outside bwrb). Warning; **auto-fixable** (`--fix` spawns it, identical to the fast path) |
 | `invalid-recurrence` | A [recurrence](/automation/task-system/) rule is broken at the config level — a malformed trigger, a non-date offset base, or a template that doesn't exist (error; **never auto-fixable** — a config error gets the same safety net as data) |
 
-Note: built-in fields (`id`, `name`, and reserved provenance field `forked-from`) are always allowed and do not produce `unknown-field` issues. Ordinary `bwrb new --json`, `bwrb edit`, and template input cannot mutate reserved fields. Hand-authored `forked-from` metadata remains supported and receives the lineage checks above.
+Note: built-in fields (`id`, `name`, and reserved provenance field `forked-from`) are always allowed and do not produce `unknown-field` issues. Ordinary `bwrb new --json`, `bwrb edit`, template input, schema defaults, and audit fixes cannot mutate reserved fields. Use `bwrb new --fork` for a new child or guarded [`bwrb lineage adopt`](/reference/commands/lineage/) for known derivation between two existing notes; all stored provenance receives the lineage checks above.
 Invalid option values inside list fields are reported as `invalid-option` with `listIndex` metadata, not a separate issue code.
 For a [`date`](/reference/schema/) field with `multiple: true` (a list of dates), each element is validated against the field's granularity and an invalid element is reported as `invalid-date-format` with `listIndex` metadata identifying the offending value. An invalid date *string* element is reported for manual correction (not auto-fixed); scalar date values are auto-normalized.
 
diff --git a/docs-site/src/content/docs/reference/commands/lineage.md b/docs-site/src/content/docs/reference/commands/lineage.md
new file mode 100644
index 0000000..3f36e49
--- /dev/null
+++ b/docs-site/src/content/docs/reference/commands/lineage.md
@@ -0,0 +1,114 @@
+---
+title: bwrb lineage
+description: Safely adopt existing notes into document lineage
+---
+
+`lineage adopt` records one known immediate-source edge between two existing
+Markdown notes. It is the only supported in-place way to add `forked-from`
+provenance; ordinary creation, editing, templates, schema defaults, and audit
+fixes remain unable to set or change that reserved field.
+
+## Synopsis
+
+```bash
+bwrb lineage adopt <child> --from <parent> [--dry-run | --execute] [--output text|json]
+```
+
+## Options
+
+| Option | Description |
+| --- | --- |
+| `--from <parent>` | Required exact immediate-source target |
+| `--dry-run` | Preview only (also the default when neither mode flag is present) |
+| `-x, --execute` | Revalidate under mutation locks and apply one edge |
+| `--output <text\|json>` | Output format (default: `text`) |
+
+There is deliberately no bulk or force mode. Adopt one edge at a time, inspect
+the preview, then execute it explicitly.
+
+## Target resolution
+
+Both targets use exact Bowerbird identity surfaces: a vault-relative or
+absolute managed path (with or without `.md`), basename, frontmatter `name`, a
+schema-declared alias, or a case-insensitive UUID. Fuzzy substitution is never
+used. Ambiguous targets are rejected with their candidate paths.
+
+The child and parent must resolve to the same valid note type, but they do not
+need to live in the same directory.
+
+## Guardrails
+
+Before previewing or writing, adoption refuses:
+
+- a note adopted under itself;
+- an existing `forked-from` key on the child (including malformed provenance);
+- a missing or invalid resolved type on either note, or a type mismatch;
+- a malformed existing ID on either note or a duplicate stable ID in the vault;
+- malformed, dangling, duplicate, or cyclic existing lineage;
+- a proposed edge that would create a cycle.
+
+Valid existing IDs are preserved. If either target is an older note without an
+ID, execute mode assigns a fresh UUID and records it in `.bwrb/ids.jsonl` as
+part of the guarded operation. Parent and child paths are locked together, the
+notes and graph are re-read under those locks, and ID assignment shares the
+same lock used by `new --fork`. Concurrent fork, non-force delete, and adoption
+operations therefore serialize on every path they share.
+
+Only the missing `id` fields and the child's new `forked-from` field may change.
+The writer inserts plain scalars without reserializing YAML, and verifies that
+the parsed bodies and all ordinary frontmatter remain unchanged. Filenames,
+aliases, provider metadata, bodies, and other frontmatter are not rewritten.
+If the two-note write or registry update fails, changed note bytes are rolled
+back before the command reports failure.
+
+## Examples
+
+```bash
+# Preview is the default
+bwrb lineage adopt "Child note" --from "Parent note" --output json
+
+# An explicit preview can make an automation's intent clearer
+bwrb lineage adopt "Child note" --from "Parent note" --dry-run --output json
+
+# Apply after reviewing the plan
+bwrb lineage adopt "Child note" --from "Parent note" --execute --output json
+
+# Inspect the resulting family
+bwrb list --lineage "Child note" --output tree
+```
+
+## JSON output
+
+Success uses one stable envelope. `changes[].status` is `planned` in dry-run
+mode and `applied` in execute mode:
+
+```json
+{
+  "success": true,
+  "mode": "dry-run",
+  "child": { "path": "Drafts/Child note.md", "id": "...", "id_generated": true },
+  "parent": { "path": "Briefs/Parent note.md", "id": "...", "id_generated": false },
+  "changes": [
+    { "path": "Drafts/Child note.md", "field": "id", "value": "...", "status": "planned" },
+    { "path": "Drafts/Child note.md", "field": "forked-from", "value": "...", "status": "planned" }
+  ],
+  "warnings": [
+    "Generated IDs in a dry run are provisional; execute revalidates and assigns fresh UUIDs."
+  ],
+  "body_invariance": {
+    "child": { "before_sha256": "...", "after_sha256": "...", "unchanged": true },
+    "parent": { "before_sha256": "...", "after_sha256": "...", "unchanged": true }
+  }
+}
+```
+
+A dry-run-generated ID is evidence for the planned field, not a reservation;
+execute mode assigns a fresh UUID after locked revalidation. Existing IDs are
+stable across preview and execution.
+
+## See also
+
+- [bwrb new](/reference/commands/new/#document-forks) — create a new child from an existing document
+- [bwrb list](/reference/commands/list/#fork-lineage) — inspect a complete lineage family
+- [bwrb audit](/reference/commands/audit/) — validate lineage integrity
+- [bwrb delete](/reference/commands/delete/#fork-lineage-safety) — lineage-aware deletion guards
diff --git a/docs-site/src/content/docs/reference/commands/list.md b/docs-site/src/content/docs/reference/commands/list.md
index ecfc846..769db30 100644
--- a/docs-site/src/content/docs/reference/commands/list.md
+++ b/docs-site/src/content/docs/reference/commands/list.md
@@ -379,6 +379,7 @@ bwrb list --type task --where '!isEmpty(deadline)'
 
 - [CLI Safety and Flags](/concepts/cli-safety-and-flags/) — When to use `--force`
 - [Targeting Model](/reference/targeting/) — Full selector reference
+- [bwrb lineage](/reference/commands/lineage/) — Adopt known existing revisions into lineage
 - [bwrb dashboard](/reference/commands/dashboard/) — Run saved queries
 - [`search` compatibility command](/reference/commands/search/) — Legacy invocation mappings
 - [`open` compatibility command](/reference/commands/open/) — Legacy invocation mappings
diff --git a/docs-site/src/content/docs/reference/commands/new.md b/docs-site/src/content/docs/reference/commands/new.md
index a1665f9..dbb88d2 100644
--- a/docs-site/src/content/docs/reference/commands/new.md
+++ b/docs-site/src/content/docs/reference/commands/new.md
@@ -207,8 +207,9 @@ only be forked when its owner's field permits multiple children.
    from the filename without writing that key
    ([#813](https://github.com/3mdistal/bwrb/issues/813)). The reserved
    `forked-from` provenance field cannot be supplied through `--json`, templates,
-   or schema fields/defaults; `new --fork` is the lineage-aware workflow that
-   injects it
+   or schema fields/defaults; `new --fork` creates new lineage, while
+   [`lineage adopt`](/reference/commands/lineage/) is the guarded in-place path
+   for two existing documents
 6. **Output**: Returns path to created file
 
 ## Template Discovery
@@ -223,3 +224,4 @@ Templates are stored in `.bwrb/templates/{type}/{subtype}/*.md`:
 - [Templates Overview](/templates/overview/) — Template system concepts
 - [bwrb template](/reference/commands/template/) — Template management
 - [Schema](/concepts/schema/) — Schema structure and field types
+- [bwrb lineage](/reference/commands/lineage/) — Adopt existing notes into lineage
diff --git a/docs-site/src/content/docs/reference/schema.md b/docs-site/src/content/docs/reference/schema.md
index 72f6ab2..d79bf93 100644
--- a/docs-site/src/content/docs/reference/schema.md
+++ b/docs-site/src/content/docs/reference/schema.md
@@ -720,13 +720,14 @@ editing are unchanged by this marker.
 ### Built-in lineage metadata
 
 `forked-from` is a reserved built-in frontmatter field containing the UUID of a
-note's immediate source. It is a UUID string, never a wikilink. Hand-authored
-lineage is allowed and audited, but normal JSON creation, edit, and template
-input cannot set or modify this system-managed field. Do not declare
+note's immediate source. It is a UUID string, never a wikilink. Existing
+lineage is audited, but normal JSON creation, edit, template input, schema
+defaults, and audit fixes cannot set or modify this system-managed field. Use
+`bwrb new --fork` for a newly created child or guarded
+[`bwrb lineage adopt`](/reference/commands/lineage/) for two existing notes. Do not declare
 `forked-from` in a type or trait's `fields`: schema loading and schema field
 creation reject the reserved name, including declarations with `default` or
-static `value` entries. A native fork workflow injects provenance after ordinary
-creation defaults have been resolved.
+static `value` entries.
 
 ---
 
diff --git a/docs/product/system-frontmatter.md b/docs/product/system-frontmatter.md
index c504172..f567dfa 100644
--- a/docs/product/system-frontmatter.md
+++ b/docs/product/system-frontmatter.md
@@ -10,7 +10,8 @@ These fields are recognized by bwrb and are always allowed in frontmatter:
 - `name` (persisted from JSON creation when supplied; interactive creation
   currently derives the effective name from the filename without writing the
   key, tracked in [#813](https://github.com/3mdistal/bwrb/issues/813))
-- `forked-from` (immediate source note UUID, written by `bwrb new --fork`)
+- `forked-from` (immediate source note UUID, written by `bwrb new --fork` or the
+  guarded `bwrb lineage adopt` operation)
 
 Audit/validation behavior:
 
@@ -30,6 +31,10 @@ Reserved fields cannot be supplied through ordinary JSON creation, JSON or
 interactive edit, or template defaults/prompt fields. Audit fixes also leave
 them untouched. Schema defaults and static values cannot author
 `forked-from`; `bwrb new --fork` injects it after ordinary defaults are resolved.
+The only in-place exception is `bwrb lineage adopt`, which revalidates two exact
+existing notes under lineage locks, refuses reparenting, cycles, and unsafe
+graph state, and can add only missing `id` fields plus the child's
+`forked-from` value.
 
 ## Policy
 
diff --git a/docs/skill/SKILL.md b/docs/skill/SKILL.md
index dc56114..af0220a 100644
--- a/docs/skill/SKILL.md
+++ b/docs/skill/SKILL.md
@@ -179,7 +179,7 @@ Some fields are recognized by bwrb regardless of schema:
 
 - `id`: reserved/system-managed UUID created by `bwrb new` and should not be edited.
 - `name`: always allowed and used as an explicit identity when present. JSON creation persists the input `name`; interactive creation currently derives `_name` from the filename without persisting this key ([#813](https://github.com/3mdistal/bwrb/issues/813)).
-- `forked-from`: reserved immediate-source UUID for document lineage. It is not a wikilink. Agents may encounter hand-authored values, but must not set or modify it through ordinary `new --json`, `edit`, or template input.
+- `forked-from`: reserved immediate-source UUID for document lineage. It is not a wikilink. Agents must not set or modify it through ordinary `new --json`, `edit`, template input, schema defaults, or audit fixes. Use guarded `lineage adopt` for known historical derivation between existing notes.
 
 Create a document fork when preserving an earlier draft matters:
 
@@ -194,6 +194,23 @@ always provide `--name` or `--label` and use `--output json`; the result contain
 fork mode with a type, template, `--json`, instance, or ownership-selection
 flag. The child is a normal note beside its source, not a hidden snapshot.
 
+Adopt two existing notes only when their immediate derivation is known. Always
+preview first and inspect the exact paths, IDs, changes, warnings, and body
+hashes before executing:
+
+```bash
+bwrb lineage adopt "Child note" --from "Parent note" --dry-run --output json
+bwrb lineage adopt "Child note" --from "Parent note" --execute --output json
+```
+
+Targets are exact UUID, path, basename, name, or alias matches and must have the
+same resolved type. Adoption has no force or bulk mode, refuses an existing
+child edge and unsafe/cyclic graph state, and changes only missing target IDs
+plus the child's `forked-from`. A successful JSON result has `mode`, `child`,
+`parent`, `changes`, `warnings`, and `body_invariance`; require both
+`body_invariance.*.unchanged` values to be `true`. IDs shown as generated in a
+dry run are provisional until execute revalidates under locks.
+
 Deleting a document with direct fork children refuses unless `--force` is
 supplied. With `--force`, bwrb deletes only the selected document: children keep
 their `forked-from` value, which surfaces as `dangling-forked-from` in
diff --git a/src/commands/lineage/adopt.ts b/src/commands/lineage/adopt.ts
new file mode 100644
index 0000000..57621b1
--- /dev/null
+++ b/src/commands/lineage/adopt.ts
@@ -0,0 +1,432 @@
+import { createHash } from 'crypto';
+import { isDeepStrictEqual } from 'util';
+import { readFile } from 'fs/promises';
+import { resolve } from 'path';
+import type { LoadedSchema } from '../../types/schema.js';
+import {
+  insertFrontmatterScalarPreservingBytes,
+  parseNoteContent,
+  writeFileAtomic,
+  type ParsedNote,
+} from '../../lib/frontmatter.js';
+import { resolveExactNoteTarget, type ResolvedExactNoteTarget } from '../../lib/exact-note-target.js';
+import { buildVaultNoteSnapshot, type VaultNoteSnapshot } from '../../lib/discovery.js';
+import { collectLineageIssues } from '../../lib/audit/lineage.js';
+import {
+  generateUniqueNoteId,
+  isValidNoteId,
+  normalizeNoteId,
+  registerIssuedNoteIds,
+  withNoteIdAssignmentLock,
+} from '../../lib/note-id.js';
+import {
+  getLineageMutationLockPath,
+  withLineageMutationLocks,
+} from '../../lib/lineage-lock.js';
+
+export type LineageAdoptMode = 'dry-run' | 'execute';
+
+export interface LineageAdoptOptions {
+  child: string;
+  parent: string;
+  execute: boolean;
+}
+
+export interface LineageAdoptDependencies {
+  registerIds?: typeof registerIssuedNoteIds;
+}
+
+export interface LineageAdoptChange {
+  path: string;
+  field: 'id' | 'forked-from';
+  value: string;
+  status: 'planned' | 'applied';
+}
+
+export interface LineageAdoptBodyEvidence {
+  before_sha256: string;
+  after_sha256: string;
+  unchanged: boolean;
+}
+
+export interface LineageAdoptResult {
+  mode: LineageAdoptMode;
+  child: {
+    path: string;
+    id: string;
+    id_generated: boolean;
+  };
+  parent: {
+    path: string;
+    id: string;
+    id_generated: boolean;
+  };
+  changes: LineageAdoptChange[];
+  warnings: string[];
+  body_invariance: {
+    child: LineageAdoptBodyEvidence;
+    parent: LineageAdoptBodyEvidence;
+  };
+}
+
+interface PreparedAdoption {
+  result: LineageAdoptResult;
+  child: ResolvedExactNoteTarget;
+  parent: ResolvedExactNoteTarget;
+  childOriginal: ParsedNote;
+  parentOriginal: ParsedNote;
+  childNextRaw: string;
+  parentNextRaw: string;
+  registrations: Array<{ id: string; notePath: string }>;
+}
+
+/** Preview or apply one guarded immediate-source edge between existing notes. */
+export async function adoptLineage(
+  schema: LoadedSchema,
+  vaultDir: string,
+  options: LineageAdoptOptions,
+  dependencies: LineageAdoptDependencies = {}
+): Promise<LineageAdoptResult> {
+  const initial = await resolveTargets(schema, vaultDir, options.child, options.parent);
+  assertDifferentNotes(vaultDir, initial.child, initial.parent);
+
+  if (!options.execute) {
+    return (await prepareAdoption(schema, vaultDir, initial.child, initial.parent, 'dry-run')).result;
+  }
+
+  const lockedPaths = [initial.child.file.path, initial.parent.file.path];
+  return withLineageMutationLocks(vaultDir, lockedPaths, async () =>
+    withNoteIdAssignmentLock(vaultDir, async () => {
+      const current = await resolveTargets(schema, vaultDir, options.child, options.parent);
+      assertTargetsStayedLocked(vaultDir, initial, current);
+      const prepared = await prepareAdoption(
+        schema,
+        vaultDir,
+        current.child,
+        current.parent,
+        'execute'
+      );
+      await applyPreparedAdoption(
+        vaultDir,
+        prepared,
+        dependencies.registerIds ?? registerIssuedNoteIds
+      );
+      return prepared.result;
+    })
+  );
+}
+
+async function resolveTargets(
+  schema: LoadedSchema,
+  vaultDir: string,
+  childTarget: string,
+  parentTarget: string
+): Promise<{ child: ResolvedExactNoteTarget; parent: ResolvedExactNoteTarget }> {
+  const child = await resolveExactNoteTarget(schema, vaultDir, childTarget, {
+    purpose: 'adoption child',
+  });
+  const parent = await resolveExactNoteTarget(schema, vaultDir, parentTarget, {
+    purpose: 'adoption parent',
+  });
+  return { child, parent };
+}
+
+async function prepareAdoption(
+  schema: LoadedSchema,
+  vaultDir: string,
+  child: ResolvedExactNoteTarget,
+  parent: ResolvedExactNoteTarget,
+  mode: LineageAdoptMode
+): Promise<PreparedAdoption> {
+  assertDifferentNotes(vaultDir, child, parent);
+  if (child.typeName !== parent.typeName) {
+    throw new Error(
+      `Cannot adopt lineage across note types: child ${child.file.relativePath} is ${child.typeName}, ` +
+      `parent ${parent.file.relativePath} is ${parent.typeName}.`
+    );
+  }
+
+  assertNoExistingProvenance(child);
+  assertValidExistingId(child, 'child');
+  assertValidExistingId(parent, 'parent');
+
+  const snapshot = await buildVaultNoteSnapshot(schema, vaultDir);
+  assertGraphSafe(snapshot);
+
+  const usedIds = new Set<string>();
+  for (const note of snapshot.notes) {
+    const id = note.frontmatter?.id;
+    if (isValidNoteId(id)) usedIds.add(normalizeNoteId(id));
+  }
+
+  const parentExistingId = parent.frontmatter.id;
+  const parentId = isValidNoteId(parentExistingId)
+    ? parentExistingId
+    : await generateProspectiveId(vaultDir, usedIds);
+  usedIds.add(normalizeNoteId(parentId));
+
+  const childExistingId = child.frontmatter.id;
+  const childId = isValidNoteId(childExistingId)
+    ? childExistingId
+    : await generateProspectiveId(vaultDir, usedIds);
+  usedIds.add(normalizeNoteId(childId));
+
+  if (normalizeNoteId(childId) === normalizeNoteId(parentId)) {
+    throw new Error('Cannot adopt a note under itself: child and parent have the same stable id.');
+  }
+
+  const prospective = withProspectiveEdge(
+    snapshot,
+    child.file.path,
+    parent.file.path,
+    childId,
+    parentId
+  );
+  assertGraphSafe(prospective, true);
+
+  const parentRaw = await readFile(parent.file.path, 'utf-8');
+  const childRaw = await readFile(child.file.path, 'utf-8');
+  const parentNextRaw = isValidNoteId(parentExistingId)
+    ? parentRaw
+    : insertFrontmatterScalarPreservingBytes(parentRaw, 'id', parentId);
+  let childNextRaw = childRaw;
+  if (!isValidNoteId(childExistingId)) {
+    childNextRaw = insertFrontmatterScalarPreservingBytes(childNextRaw, 'id', childId);
+  }
+  childNextRaw = insertFrontmatterScalarPreservingBytes(childNextRaw, 'forked-from', parentId);
+
+  const childOriginal = parseNoteContent(childRaw);
+  const parentOriginal = parseNoteContent(parentRaw);
+  const childNext = parseNoteContent(childNextRaw);
+  const parentNext = parseNoteContent(parentNextRaw);
+  assertOnlySystemFieldsChanged(child.file.relativePath, childOriginal, childNext);
+  assertOnlySystemFieldsChanged(parent.file.relativePath, parentOriginal, parentNext);
+
+  const status = mode === 'execute' ? 'applied' : 'planned';
+  const changes: LineageAdoptChange[] = [];
+  if (!isValidNoteId(parentExistingId)) {
+    changes.push({ path: parent.file.relativePath, field: 'id', value: parentId, status });
+  }
+  if (!isValidNoteId(childExistingId)) {
+    changes.push({ path: child.file.relativePath, field: 'id', value: childId, status });
+  }
+  changes.push({
+    path: child.file.relativePath,
+    field: 'forked-from',
+    value: parentId,
+    status,
+  });
+
+  const registrations: Array<{ id: string; notePath: string }> = [];
+  if (!isValidNoteId(parentExistingId)) {
+    registrations.push({ id: parentId, notePath: parent.file.path });
+  }
+  if (!isValidNoteId(childExistingId)) {
+    registrations.push({ id: childId, notePath: child.file.path });
+  }
+
+  return {
+    child,
+    parent,
+    childOriginal,
+    parentOriginal,
+    childNextRaw,
+    parentNextRaw,
+    registrations,
+    result: {
+      mode,
+      child: {
+        path: child.file.relativePath,
+        id: childId,
+        id_generated: !isValidNoteId(childExistingId),
+      },
+      parent: {
+        path: parent.file.relativePath,
+        id: parentId,
+        id_generated: !isValidNoteId(parentExistingId),
+      },
+      changes,
+      warnings: mode === 'dry-run' && registrations.length > 0
+        ? ['Generated IDs in a dry run are provisional; execute revalidates and assigns fresh UUIDs.']
+        : [],
+      body_invariance: {
+        child: buildBodyEvidence(childOriginal.body, childNext.body),
+        parent: buildBodyEvidence(parentOriginal.body, parentNext.body),
+      },
+    },
+  };
+}
+
+async function applyPreparedAdoption(
+  vaultDir: string,
+  prepared: PreparedAdoption,
+  registerIds: typeof registerIssuedNoteIds
+): Promise<void> {
+  let parentWritten = false;
+  let childWritten = false;
+  try {
+    if (prepared.parentNextRaw !== prepared.parentOriginal.raw) {
+      await writeFileAtomic(prepared.parent.file.path, prepared.parentNextRaw);
+      parentWritten = true;
+    }
+    await writeFileAtomic(prepared.child.file.path, prepared.childNextRaw);
+    childWritten = true;
+    await registerIds(vaultDir, prepared.registrations);
+  } catch (error) {
+    const rollbackErrors: string[] = [];
+    if (childWritten) {
+      await writeFileAtomic(prepared.child.file.path, prepared.childOriginal.raw)
+        .catch(rollbackError => rollbackErrors.push(formatError(rollbackError)));
+    }
+    if (parentWritten) {
+      await writeFileAtomic(prepared.parent.file.path, prepared.parentOriginal.raw)
+        .catch(rollbackError => rollbackErrors.push(formatError(rollbackError)));
+    }
+    if (rollbackErrors.length > 0) {
+      throw new Error(
+        `Lineage adoption failed (${formatError(error)}) and rollback was incomplete: ${rollbackErrors.join('; ')}`
+      );
+    }
+    throw error;
+  }
+}
+
+function assertDifferentNotes(
+  vaultDir: string,
+  child: ResolvedExactNoteTarget,
+  parent: ResolvedExactNoteTarget
+): void {
+  const childLock = getLineageMutationLockPath(vaultDir, child.file.path);
+  const parentLock = getLineageMutationLockPath(vaultDir, parent.file.path);
+  if (childLock === parentLock) {
+    throw new Error(`Cannot adopt a note under itself: ${child.file.relativePath}.`);
+  }
+}
+
+function assertTargetsStayedLocked(
+  vaultDir: string,
+  initial: { child: ResolvedExactNoteTarget; parent: ResolvedExactNoteTarget },
+  current: { child: ResolvedExactNoteTarget; parent: ResolvedExactNoteTarget }
+): void {
+  for (const role of ['child', 'parent'] as const) {
+    const initialLock = getLineageMutationLockPath(vaultDir, initial[role].file.path);
+    const currentLock = getLineageMutationLockPath(vaultDir, current[role].file.path);
+    if (initialLock !== currentLock) {
+      throw new Error(`The adoption ${role} target changed while waiting for a lock; retry the command.`);
+    }
+  }
+}
+
+function assertNoExistingProvenance(child: ResolvedExactNoteTarget): void {
+  if (Object.prototype.hasOwnProperty.call(child.frontmatter, 'forked-from')) {
+    throw new Error(
+      `Cannot adopt ${child.file.relativePath}: child already has forked-from provenance.`
+    );
+  }
+}
+
+function assertValidExistingId(target: ResolvedExactNoteTarget, role: 'child' | 'parent'): void {
+  const id = target.frontmatter.id;
+  if (id !== undefined && !isValidNoteId(id)) {
+    throw new Error(
+      `Cannot adopt ${role} ${target.file.relativePath}: existing id is not a valid UUID.`
+    );
+  }
+}
+
+function assertGraphSafe(snapshot: VaultNoteSnapshot, prospective = false): void {
+  const issues = [...collectLineageIssues(snapshot).entries()]
+    .flatMap(([path, pathIssues]) => pathIssues.map(issue => ({ path, issue })))
+    .sort((a, b) =>
+      a.issue.code.localeCompare(b.issue.code, 'en') || a.path.localeCompare(b.path, 'en')
+    );
+  if (issues.length === 0) return;
+
+  const cycle = issues.find(({ issue }) => issue.code === 'fork-cycle');
+  if (prospective && cycle) {
+    throw new Error(`Cannot adopt lineage: the proposed edge would create a cycle (${cycle.issue.message}).`);
+  }
+  const first = issues[0]!;
+  throw new Error(
+    `Cannot adopt lineage while existing provenance is unsafe: ${first.issue.code} at ` +
+    `${first.path}: ${first.issue.message}`
+  );
+}
+
+function withProspectiveEdge(
+  snapshot: VaultNoteSnapshot,
+  childPath: string,
+  parentPath: string,
+  childId: string,
+  parentId: string
+): VaultNoteSnapshot {
+  const childAbsolute = resolve(childPath);
+  const parentAbsolute = resolve(parentPath);
+  let foundChild = false;
+  let foundParent = false;
+  const notes = snapshot.notes.map(note => {
+    const absolute = resolve(note.path);
+    if (absolute === childAbsolute) {
+      foundChild = true;
+      return {
+        ...note,
+        frontmatter: { ...note.frontmatter, id: childId, 'forked-from': parentId },
+      };
+    }
+    if (absolute === parentAbsolute) {
+      foundParent = true;
+      return { ...note, frontmatter: { ...note.frontmatter, id: parentId } };
+    }
+    return note;
+  });
+  if (!foundChild || !foundParent) {
+    throw new Error('Adoption target disappeared while validating the vault; retry the command.');
+  }
+  return { notes };
+}
+
+async function generateProspectiveId(vaultDir: string, usedIds: Set<string>): Promise<string> {
+  for (let attempt = 0; attempt < 100; attempt++) {
+    const id = await generateUniqueNoteId(vaultDir);
+    if (!usedIds.has(normalizeNoteId(id))) return id;
+  }
+  throw new Error('Could not assign a unique note ID; retry the command.');
+}
+
+function assertOnlySystemFieldsChanged(
+  path: string,
+  before: ParsedNote,
+  after: ParsedNote
+): void {
+  if (before.body !== after.body) {
+    throw new Error(`Refusing lineage adoption because it would change the body of ${path}.`);
+  }
+  if (!isDeepStrictEqual(stripMutableSystemFields(before.frontmatter), stripMutableSystemFields(after.frontmatter))) {
+    throw new Error(`Refusing lineage adoption because it would change ordinary metadata in ${path}.`);
+  }
+}
+
+function stripMutableSystemFields(frontmatter: Record<string, unknown>): Record<string, unknown> {
+  const copy = { ...frontmatter };
+  delete copy.id;
+  delete copy['forked-from'];
+  return copy;
+}
+
+function buildBodyEvidence(before: string, after: string): LineageAdoptBodyEvidence {
+  const beforeHash = hashBody(before);
+  const afterHash = hashBody(after);
+  return {
+    before_sha256: beforeHash,
+    after_sha256: afterHash,
+    unchanged: beforeHash === afterHash && before === after,
+  };
+}
+
+function hashBody(body: string): string {
+  return createHash('sha256').update(body, 'utf-8').digest('hex');
+}
+
+function formatError(error: unknown): string {
+  return error instanceof Error ? error.message : String(error);
+}
diff --git a/src/commands/lineage/index.ts b/src/commands/lineage/index.ts
new file mode 100644
index 0000000..470b501
--- /dev/null
+++ b/src/commands/lineage/index.ts
@@ -0,0 +1,87 @@
+import { Command } from 'commander';
+import { loadSchema } from '../../lib/schema.js';
+import { resolveVaultDirWithSelection } from '../../lib/vaultSelection.js';
+import { getGlobalOpts } from '../../lib/command.js';
+import { ExitCodes, jsonError, printJson } from '../../lib/output.js';
+import { printError, printInfo, printSuccess } from '../../lib/prompt.js';
+import { adoptLineage } from './adopt.js';
+
+interface AdoptCommandOptions {
+  from?: string;
+  dryRun?: boolean;
+  execute?: boolean;
+  output?: string;
+}
+
+const adoptCommand = new Command('adopt')
+  .description('Safely attach an existing note to known document lineage')
+  .argument('<child>', 'Exact child path, basename, name, alias, or UUID')
+  .option('--from <parent>', 'Exact immediate-source path, basename, name, alias, or UUID')
+  .option('--dry-run', 'Preview the guarded mutation (default)')
+  .option('-x, --execute', 'Apply the adoption after revalidation')
+  .option('--output <format>', 'Output format (text or json)', 'text')
+  .addHelpText('after', `
+Examples:
+  bwrb lineage adopt "Child note" --from "Parent note" --dry-run --output json
+  bwrb lineage adopt "Child note" --from "Parent note" --execute --output json
+`)
+  .action(async (child: string, options: AdoptCommandOptions, command: Command) => {
+    const jsonMode = options.output === 'json';
+    try {
+      if (options.output !== 'text' && options.output !== 'json') {
+        throw new Error('--output must be text or json.');
+      }
+      if (!options.from) {
+        throw new Error('--from <parent> is required.');
+      }
+      if (options.execute === true && options.dryRun === true) {
+        throw new Error('--execute cannot be combined with --dry-run.');
+      }
+
+      const globalOpts = getGlobalOpts(command);
+      const vaultDir = await resolveVaultDirWithSelection({
+        ...(globalOpts.vault ? { vault: globalOpts.vault } : {}),
+        allowFindDown: true,
+        jsonMode,
+      });
+      const schema = await loadSchema(vaultDir);
+      const result = await adoptLineage(schema, vaultDir, {
+        child,
+        parent: options.from,
+        execute: options.execute === true,
+      });
+
+      if (jsonMode) {
+        printJson({ success: true, ...result });
+        return;
+      }
+
+      const edge = `${result.child.path} -> ${result.parent.path}`;
+      if (result.mode === 'dry-run') {
+        printInfo(`Dry run: would adopt ${edge}`);
+        printInfo('Run again with --execute to apply these changes.');
+      } else {
+        printSuccess(`Adopted lineage: ${edge}`);
+      }
+      for (const change of result.changes) {
+        printInfo(`  ${change.status}: ${change.path} ${change.field}=${change.value}`);
+      }
+      for (const warning of result.warnings) printInfo(`Warning: ${warning}`);
+      printInfo(
+        `Bodies unchanged: child=${result.body_invariance.child.unchanged}, ` +
+        `parent=${result.body_invariance.parent.unchanged}`
+      );
+    } catch (error) {
+      const message = error instanceof Error ? error.message : String(error);
+      if (jsonMode) {
+        printJson(jsonError(message, { code: ExitCodes.VALIDATION_ERROR }));
+      } else {
+        printError(message);
+      }
+      process.exitCode = ExitCodes.VALIDATION_ERROR;
+    }
+  });
+
+export const lineageCommand = new Command('lineage')
+  .description('Manage immutable document lineage')
+  .addCommand(adoptCommand);
diff --git a/src/commands/new/fork.ts b/src/commands/new/fork.ts
index f43d9c1..c7032c6 100644
--- a/src/commands/new/fork.ts
+++ b/src/commands/new/fork.ts
@@ -1,4 +1,4 @@
-import { mkdir, open, stat, unlink } from 'fs/promises';
+import { unlink } from 'fs/promises';
 import { basename, dirname, relative, resolve } from 'path';
 import type { LoadedSchema } from '../../types/schema.js';
 import type { ManagedFile } from '../../lib/navigation.js';
@@ -14,6 +14,7 @@ import {
   isValidNoteId,
   normalizeNoteId,
   registerIssuedNoteId,
+  withNoteIdAssignmentLock,
 } from '../../lib/note-id.js';
 import {
   getAliasFieldName,
@@ -28,10 +29,6 @@ import { UserCancelledError } from '../../lib/errors.js';
 import { resolveExactNoteTarget } from '../../lib/exact-note-target.js';
 import { withLineageMutationLocks } from '../../lib/lineage-lock.js';
 
-const SOURCE_ID_LOCK = '.bwrb/locks/fork-source-id.lock';
-const LOCK_RETRY_MS = 20;
-const LOCK_ATTEMPTS = 250;
-const STALE_LOCK_MS = 30_000;
 const PORTABLE_PATH_WARNING_LENGTH = 200;
 const PORTABLE_PATH_MAX_LENGTH = 260;
 const STRUCTURAL_FIELDS = new Set(['type', 'id', 'name', 'forked-from', 'prev', 'next']);
@@ -195,7 +192,7 @@ async function ensureSourceId(
   vaultDir: string,
   sourcePath: string
 ): Promise<string> {
-  return withSourceIdLock(vaultDir, async () => {
+  return withNoteIdAssignmentLock(vaultDir, async () => {
     const parsed = await parseNote(sourcePath);
     const existing = parsed.frontmatter.id;
     if (existing !== undefined) {
@@ -268,41 +265,6 @@ async function findNotesWithId(
   return matches;
 }
 
-async function withSourceIdLock<T>(vaultDir: string, task: () => Promise<T>): Promise<T> {
-  const lockPath = resolve(vaultDir, SOURCE_ID_LOCK);
-  await mkdir(dirname(lockPath), { recursive: true });
-
-  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
-    try {
-      const handle = await open(lockPath, 'wx');
-      try {
-        await handle.writeFile(`${process.pid}\n`, 'utf-8');
-        return await task();
-      } finally {
-        await handle.close().catch(() => undefined);
-        await unlink(lockPath).catch(() => undefined);
-      }
-    } catch (error) {
-      if (!isFileExistsError(error)) throw error;
-      if (await isStaleLock(lockPath)) {
-        await unlink(lockPath).catch(() => undefined);
-        continue;
-      }
-      await delay(LOCK_RETRY_MS);
-    }
-  }
-  throw new Error('Timed out waiting to assign the fork source ID; retry the command.');
-}
-
-async function isStaleLock(lockPath: string): Promise<boolean> {
-  try {
-    const info = await stat(lockPath);
-    return Date.now() - info.mtimeMs > STALE_LOCK_MS;
-  } catch {
-    return false;
-  }
-}
-
 function buildForkFrontmatter(
   schema: LoadedSchema,
   typeName: string,
@@ -371,7 +333,3 @@ function buildForkFieldOrder(
 function isFileExistsError(error: unknown): boolean {
   return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST';
 }
-
-function delay(ms: number): Promise<void> {
-  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
-}
diff --git a/src/index.ts b/src/index.ts
index 28f7bac..520268a 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -13,6 +13,7 @@ import { auditCommand } from './commands/audit.js';
 import { bulkCommand } from './commands/bulk.js';
 import { templateCommand } from './commands/template.js';
 import { completionCommand } from './commands/completion.js';
+import { lineageCommand } from './commands/lineage/index.js';
 import { configCommand } from './commands/config.js';
 import { dashboardCommand } from './commands/dashboard.js';
 import { initCommand } from './commands/init.js';
@@ -77,6 +78,7 @@ if (completionsIndex !== -1) {
   program.addCommand(auditCommand);
   program.addCommand(bulkCommand);
   program.addCommand(templateCommand);
+  program.addCommand(lineageCommand);
 
   // Saved queries
   program.addCommand(dashboardCommand);
diff --git a/src/lib/completion.ts b/src/lib/completion.ts
index c6058e1..0156fd4 100644
--- a/src/lib/completion.ts
+++ b/src/lib/completion.ts
@@ -5,7 +5,7 @@
  * - Type name completion (--type/-t)
  * - Path completion (--path/-p)
  * - Command and option completion
- * - Subcommand completion (schema, template, dashboard, completion)
+ * - Subcommand completion (schema, template, lineage, dashboard, completion)
  * - Entity name completion (dashboard names, template names)
  * 
  * The completion system works via a runtime callback model:
@@ -54,7 +54,7 @@ export interface CompletionContext {
 /**
  * Commands that have subcommands.
  */
-const COMMANDS_WITH_SUBCOMMANDS = ['schema', 'template', 'dashboard', 'completion'];
+const COMMANDS_WITH_SUBCOMMANDS = ['schema', 'template', 'dashboard', 'lineage', 'completion'];
 
 /**
  * Subcommands for each parent command.
@@ -63,6 +63,7 @@ const SUBCOMMANDS: Record<string, string[]> = {
   schema: ['list', 'new', 'edit', 'delete', 'validate', 'diff', 'migrate', 'history'],
   template: ['list', 'show', 'new', 'edit', 'delete', 'validate'],
   dashboard: ['list', 'new', 'edit', 'delete'],
+  lineage: ['adopt'],
   completion: ['bash', 'zsh', 'fish'],
 };
 
@@ -252,6 +253,7 @@ const COMMANDS = [
   'bulk',
   'schema',
   'template',
+  'lineage',
   'dashboard',
   'delete',
   'completion',
@@ -318,6 +320,7 @@ const COMMAND_OPTIONS: Record<string, string[]> = {
     '--help',
   ],
   template: ['--vault', '-v', '--non-interactive', '--help'],
+  lineage: ['--from', '--dry-run', '--execute', '-x', '--output', '--vault', '-v', '--non-interactive', '--help'],
   dashboard: ['--output', '-o', '--vault', '-v', '--non-interactive', '--json', '--help'],
   delete: [
     '--type', '-t',
@@ -379,6 +382,7 @@ function isValueOption(option: string): boolean {
     '--output', '-o',
     '--template',
     '--fork',
+    '--from',
     '--label',
     '--name',
     '--app',
@@ -593,6 +597,14 @@ export async function handleCompletionRequest(
     return [];
   }
   
+  // === Lineage command ===
+  if (ctx.command === 'lineage') {
+    if (!ctx.subcommand && ctx.positionalIndex === 0) {
+      return filterByPrefix(SUBCOMMANDS['lineage'] ?? [], ctx.current);
+    }
+    return [];
+  }
+
   // === Completion command ===
   if (ctx.command === 'completion') {
     if (!ctx.subcommand && ctx.positionalIndex === 0) {
diff --git a/src/lib/exact-note-target.ts b/src/lib/exact-note-target.ts
index 2a77d06..54a6428 100644
--- a/src/lib/exact-note-target.ts
+++ b/src/lib/exact-note-target.ts
@@ -19,7 +19,7 @@ export interface ResolvedExactNoteTarget {
 
 export interface ExactNoteTargetOptions {
   /** Noun used in resolution errors. Fork mode keeps its established wording. */
-  purpose?: 'fork' | 'lineage';
+  purpose?: 'fork' | 'lineage' | 'adoption child' | 'adoption parent';
 }
 
 /**
@@ -42,7 +42,7 @@ export async function resolveExactNoteTarget(
   let snapshot: VaultNoteSnapshot | undefined;
   let index: NoteIndex;
 
-  if (purpose === 'lineage') {
+  if (purpose !== 'fork') {
     // Lineage needs a graph-wide snapshot anyway. Build resolution maps from
     // that snapshot and parse only the selected target's body afterward.
     snapshot = await buildVaultNoteSnapshot(schema, vaultDir);
@@ -139,7 +139,7 @@ function resolveExactFile(
   vaultDir: string,
   target: string,
   frontmatterByPath: Map<string, Record<string, unknown>>,
-  purpose: 'fork' | 'lineage' = 'fork'
+  purpose: NonNullable<ExactNoteTargetOptions['purpose']> = 'fork'
 ): ManagedFile | undefined {
   if (isAbsolute(target)) {
     const absolute = resolve(target);
@@ -218,7 +218,7 @@ function exactMapMatches(
 function throwAmbiguousTarget(
   target: string,
   files: ManagedFile[],
-  purpose: 'fork' | 'lineage' = 'fork'
+  purpose: NonNullable<ExactNoteTargetOptions['purpose']> = 'fork'
 ): never {
   const candidates = files.map(file => file.relativePath).sort().join(', ');
   throw new Error(`Ambiguous ${purpose} target "${target}"; matches: ${candidates}`);
diff --git a/src/lib/frontmatter.ts b/src/lib/frontmatter.ts
index bf2d607..c036f2c 100644
--- a/src/lib/frontmatter.ts
+++ b/src/lib/frontmatter.ts
@@ -53,11 +53,8 @@ export interface ParsedNote {
   raw: string;
 }
 
-/**
- * Parse a markdown file's frontmatter and body.
- */
-export async function parseNote(filePath: string): Promise<ParsedNote> {
-  const content = await readFile(filePath, 'utf-8');
+/** Parse an in-memory markdown note using the same normalization as parseNote. */
+export function parseNoteContent(content: string): ParsedNote {
   const { data, content: body } = matter(content);
   return {
     frontmatter: normalizeMatterValue(data) as Record<string, unknown>,
@@ -66,6 +63,14 @@ export async function parseNote(filePath: string): Promise<ParsedNote> {
   };
 }
 
+/**
+ * Parse a markdown file's frontmatter and body.
+ */
+export async function parseNote(filePath: string): Promise<ParsedNote> {
+  const content = await readFile(filePath, 'utf-8');
+  return parseNoteContent(content);
+}
+
 /**
  * Parse frontmatter from a string.
  */
diff --git a/src/lib/lineage-lock.ts b/src/lib/lineage-lock.ts
index 688f155..47bbc2e 100644
--- a/src/lib/lineage-lock.ts
+++ b/src/lib/lineage-lock.ts
@@ -8,7 +8,7 @@ const STALE_LOCK_MS = 30_000;
 const HEARTBEAT_MS = 10_000;
 const LOCK_VERSION = 1;
 
-interface LineageLockOptions {
+export interface OwnershipFileLockOptions {
   retryMs: number;
   attempts: number;
   staleMs: number;
@@ -33,7 +33,7 @@ interface LockSnapshot {
   size: number;
 }
 
-const DEFAULT_OPTIONS: LineageLockOptions = {
+const DEFAULT_OPTIONS: OwnershipFileLockOptions = {
   retryMs: LOCK_RETRY_MS,
   attempts: LOCK_ATTEMPTS,
   staleMs: STALE_LOCK_MS,
@@ -51,7 +51,7 @@ export async function withLineageMutationLocks<T>(
   vaultDir: string,
   sourcePaths: string[],
   task: () => Promise<T>,
-  optionOverrides: Partial<LineageLockOptions> = {}
+  optionOverrides: Partial<OwnershipFileLockOptions> = {}
 ): Promise<T> {
   const options = { ...DEFAULT_OPTIONS, ...optionOverrides };
   const lockPaths = Array.from(new Set(
@@ -61,7 +61,11 @@ export async function withLineageMutationLocks<T>(
   const releases: Array<() => Promise<void>> = [];
   try {
     for (const lockPath of lockPaths) {
-      releases.push(await acquireLock(lockPath, options));
+      releases.push(await acquireLock(
+        lockPath,
+        options,
+        'Timed out waiting for a fork-lineage mutation lock; retry the command.'
+      ));
     }
     return await task();
   } finally {
@@ -71,6 +75,28 @@ export async function withLineageMutationLocks<T>(
   }
 }
 
+/**
+ * Run one task while holding an ownership-safe lock at an existing lock path.
+ *
+ * This is shared by lineage-edge locks and the fixed note-ID coordination
+ * locks. Recovery and release are token/inode aware, so an old holder cannot
+ * remove a successor that has taken over the same pathname.
+ */
+export async function withOwnershipFileLock<T>(
+  lockPath: string,
+  task: () => Promise<T>,
+  optionOverrides: Partial<OwnershipFileLockOptions> = {},
+  timeoutMessage = 'Timed out waiting for a file lock; retry the command.'
+): Promise<T> {
+  const options = { ...DEFAULT_OPTIONS, ...optionOverrides };
+  const release = await acquireLock(resolve(lockPath), options, timeoutMessage);
+  try {
+    return await task();
+  } finally {
+    await release();
+  }
+}
+
 export function getLineageMutationLockPath(vaultDir: string, sourcePath: string): string {
   const vaultRoot = resolve(vaultDir);
   const absoluteSource = resolve(sourcePath);
@@ -92,7 +118,8 @@ export function getLineageMutationLockPath(vaultDir: string, sourcePath: string)
 
 async function acquireLock(
   lockPath: string,
-  options: LineageLockOptions
+  options: OwnershipFileLockOptions,
+  timeoutMessage: string
 ): Promise<() => Promise<void>> {
   await mkdir(dirname(lockPath), { recursive: true });
   const recoveryPath = `${lockPath}.recovery`;
@@ -148,14 +175,14 @@ async function acquireLock(
     }
   }
 
-  throw new Error('Timed out waiting for a fork-lineage mutation lock; retry the command.');
+  throw new Error(timeoutMessage);
 }
 
 function createRelease(
   lockPath: string,
   handle: Awaited<ReturnType<typeof open>>,
   metadata: LockMetadata,
-  options: LineageLockOptions
+  options: OwnershipFileLockOptions
 ): () => Promise<void> {
   let released = false;
   let heartbeatRunning = false;
@@ -194,7 +221,7 @@ async function heartbeatOwnedLock(
 async function recoverStaleLock(
   lockPath: string,
   recoveryPath: string,
-  options: LineageLockOptions
+  options: OwnershipFileLockOptions
 ): Promise<void> {
   const recovery = await acquireRecoveryMarker(recoveryPath, options);
   if (!recovery) return;
@@ -220,7 +247,7 @@ async function recoverStaleLock(
 
 async function acquireRecoveryMarker(
   recoveryPath: string,
-  options: LineageLockOptions
+  options: OwnershipFileLockOptions
 ): Promise<(() => Promise<void>) | null> {
   const token = randomUUID();
   const now = Date.now();
@@ -255,7 +282,7 @@ async function acquireRecoveryMarker(
 
 async function recoveryIsInProgress(
   recoveryPath: string,
-  options: LineageLockOptions
+  options: OwnershipFileLockOptions
 ): Promise<boolean> {
   const snapshot = await readLockSnapshot(recoveryPath);
   if (!snapshot) return false;
diff --git a/src/lib/note-id.ts b/src/lib/note-id.ts
index cd67136..dd46004 100644
--- a/src/lib/note-id.ts
+++ b/src/lib/note-id.ts
@@ -1,11 +1,28 @@
 import { randomUUID } from 'crypto';
-import { appendFile, mkdir, readFile, writeFile } from 'fs/promises';
+import { mkdir, open, readFile, rename, stat, unlink } from 'fs/promises';
 import { existsSync } from 'fs';
-import { dirname, join, relative } from 'path';
+import { basename, dirname, join, relative, resolve } from 'path';
+import {
+  type OwnershipFileLockOptions,
+  withOwnershipFileLock,
+} from './lineage-lock.js';
 
 const ID_REGISTRY_RELATIVE_PATH = '.bwrb/ids.jsonl';
+const ID_ASSIGNMENT_LOCK = '.bwrb/locks/fork-source-id.lock';
+const ID_REGISTRY_LOCK = '.bwrb/locks/id-registry.lock';
 const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 const MAX_ID_GENERATION_ATTEMPTS = 1000;
+const LOCK_RETRY_MS = 20;
+const LOCK_ATTEMPTS = 250;
+const STALE_LOCK_MS = 30_000;
+const HEARTBEAT_MS = 10_000;
+
+const NOTE_ID_LOCK_OPTIONS: OwnershipFileLockOptions = {
+  retryMs: LOCK_RETRY_MS,
+  attempts: LOCK_ATTEMPTS,
+  staleMs: STALE_LOCK_MS,
+  heartbeatMs: HEARTBEAT_MS,
+};
 
 /** Return whether a value is a UUID-shaped stable note ID. */
 export function isValidNoteId(value: unknown): value is string {
@@ -32,6 +49,11 @@ export interface IdRegistryEntry {
   path?: string;
 }
 
+export interface NoteIdRegistration {
+  id: string;
+  notePath: string;
+}
+
 async function readIssuedIds(vaultDir: string): Promise<Set<string>> {
   const registryPath = getIdRegistryPath(vaultDir);
   if (!existsSync(registryPath)) return new Set();
@@ -80,47 +102,115 @@ export async function registerIssuedNoteId(
   id: string,
   notePath: string
 ): Promise<void> {
-  const registryPath = getIdRegistryPath(vaultDir);
-  await mkdir(dirname(registryPath), { recursive: true });
-
-  const entry: IdRegistryEntry = {
-    id,
-    createdAt: new Date().toISOString(),
-    path: relative(vaultDir, notePath),
-  };
+  await registerIssuedNoteIds(vaultDir, [{ id, notePath }]);
+}
 
-  await appendFile(registryPath, `${JSON.stringify(entry)}\n`, 'utf-8');
+/** Register several newly assigned IDs as one atomic registry mutation. */
+export async function registerIssuedNoteIds(
+  vaultDir: string,
+  registrations: NoteIdRegistration[]
+): Promise<void> {
+  if (registrations.length === 0) return;
+  await withNoteIdRegistryLock(vaultDir, async () => {
+    const registryPath = getIdRegistryPath(vaultDir);
+    const current = await readFile(registryPath, 'utf-8').catch(error => {
+      if (isFileMissingError(error)) return '';
+      throw error;
+    });
+    const createdAt = new Date().toISOString();
+    const rows = registrations.map(({ id, notePath }) => JSON.stringify({
+      id,
+      createdAt,
+      path: relative(vaultDir, notePath),
+    } satisfies IdRegistryEntry));
+    const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n';
+    await writeRegistryAtomic(registryPath, `${current}${separator}${rows.join('\n')}\n`);
+  });
 }
 
 export async function unregisterIssuedNotePath(
   vaultDir: string,
   relativePath: string
 ): Promise<void> {
-  const registryPath = getIdRegistryPath(vaultDir);
-  if (!existsSync(registryPath)) return;
-
-  const content = await readFile(registryPath, 'utf-8');
-  const retained: string[] = [];
-
-  for (const line of content.split('\n')) {
-    const trimmed = line.trim();
-    if (!trimmed) continue;
+  await withNoteIdRegistryLock(vaultDir, async () => {
+    const registryPath = getIdRegistryPath(vaultDir);
+    if (!existsSync(registryPath)) return;
+
+    const content = await readFile(registryPath, 'utf-8');
+    const retained: string[] = [];
+
+    for (const line of content.split('\n')) {
+      const trimmed = line.trim();
+      if (!trimmed) continue;
+
+      try {
+        const parsed = JSON.parse(trimmed) as Partial<IdRegistryEntry>;
+        if (parsed.path === relativePath) continue;
+      } catch {
+        // Keep legacy/plain lines because they cannot be matched to a path.
+      }
 
-    try {
-      const parsed = JSON.parse(trimmed) as Partial<IdRegistryEntry>;
-      if (parsed.path === relativePath) continue;
-    } catch {
-      // Keep legacy/plain lines because they cannot be matched to a path.
+      retained.push(line);
     }
 
-    retained.push(line);
-  }
+    const nextContent = retained.length > 0 ? `${retained.join('\n')}\n` : '';
+    await writeRegistryAtomic(registryPath, nextContent);
+  });
+}
 
-  const nextContent = retained.length > 0 ? `${retained.join('\n')}\n` : '';
-  await writeFile(registryPath, nextContent, 'utf-8');
+/** Serialize legacy ID backfills across fork and lineage-adoption flows. */
+export async function withNoteIdAssignmentLock<T>(
+  vaultDir: string,
+  task: () => Promise<T>,
+  optionOverrides: Partial<OwnershipFileLockOptions> = {}
+): Promise<T> {
+  return withOwnershipFileLock(
+    resolve(vaultDir, ID_ASSIGNMENT_LOCK),
+    task,
+    { ...NOTE_ID_LOCK_OPTIONS, ...optionOverrides },
+    'Timed out waiting to assign a note ID; retry the command.'
+  );
 }
 
 export function ensureIdInFieldOrder(order: string[]): string[] {
   if (order.includes('id')) return order;
   return ['id', ...order];
 }
+
+export async function withNoteIdRegistryLock<T>(
+  vaultDir: string,
+  task: () => Promise<T>,
+  optionOverrides: Partial<OwnershipFileLockOptions> = {}
+): Promise<T> {
+  return withOwnershipFileLock(
+    resolve(vaultDir, ID_REGISTRY_LOCK),
+    task,
+    { ...NOTE_ID_LOCK_OPTIONS, ...optionOverrides },
+    'Timed out waiting to update the note ID registry; retry the command.'
+  );
+}
+
+async function writeRegistryAtomic(registryPath: string, content: string): Promise<void> {
+  await mkdir(dirname(registryPath), { recursive: true });
+  const tempPath = join(
+    dirname(registryPath),
+    `.${basename(registryPath)}.bwrb-${process.pid}-${randomUUID()}.tmp`
+  );
+  const mode = await stat(registryPath).then(info => info.mode).catch(() => undefined);
+  const handle = await open(tempPath, 'wx', mode);
+  let renamed = false;
+  try {
+    await handle.writeFile(content, 'utf-8');
+    await handle.sync();
+    await handle.close();
+    await rename(tempPath, registryPath);
+    renamed = true;
+  } finally {
+    await handle.close().catch(() => undefined);
+    if (!renamed) await unlink(tempPath).catch(() => undefined);
+  }
+}
+
+function isFileMissingError(error: unknown): boolean {
+  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
+}
diff --git a/tests/ts/commands/completion.test.ts b/tests/ts/commands/completion.test.ts
index 1eb49ae..17ce859 100644
--- a/tests/ts/commands/completion.test.ts
+++ b/tests/ts/commands/completion.test.ts
@@ -146,6 +146,22 @@ describe('bwrb completion command', () => {
       expect(completions).toContain('new');
       expect(completions).toContain('edit');
       expect(completions).toContain('completion');
+      expect(completions).toContain('lineage');
+    });
+
+    it('completes lineage adopt and its guarded mutation options', async () => {
+      const subcommands = (await runCliOutput([
+        '--completions', 'bwrb', 'lineage', '',
+      ], { vault: VAULT_DIR })).split('\n').filter(Boolean);
+      expect(subcommands).toContain('adopt');
+
+      const options = (await runCliOutput([
+        '--completions', 'bwrb', 'lineage', 'adopt', '--',
+      ], { vault: VAULT_DIR })).split('\n').filter(Boolean);
+      expect(options).toEqual(expect.arrayContaining([
+        '--from', '--dry-run', '--execute', '--output', '--vault', '--help',
+      ]));
+      expect(options).not.toContain('--force');
     });
 
     it('should return option completions when current word starts with -', async () => {
diff --git a/tests/ts/commands/help.contract.test.ts b/tests/ts/commands/help.contract.test.ts
index a60a626..af45218 100644
--- a/tests/ts/commands/help.contract.test.ts
+++ b/tests/ts/commands/help.contract.test.ts
@@ -33,6 +33,7 @@ describe('help output contract snapshots', () => {
       'audit',
       'bulk',
       'template',
+      'lineage',
       'dashboard',
       'init',
       'config',
diff --git a/tests/ts/commands/lineage-adopt.test.ts b/tests/ts/commands/lineage-adopt.test.ts
new file mode 100644
index 0000000..667a38e
--- /dev/null
+++ b/tests/ts/commands/lineage-adopt.test.ts
@@ -0,0 +1,366 @@
+import { afterEach, beforeEach, describe, expect, it } from 'vitest';
+import { mkdir, readFile, writeFile } from 'fs/promises';
+import { join } from 'path';
+import {
+  cleanupTestVault,
+  createTestVault,
+  runCLI,
+} from '../fixtures/setup.js';
+import { parseNote } from '../../../src/lib/frontmatter.js';
+import { loadSchema } from '../../../src/lib/schema.js';
+import { adoptLineage } from '../../../src/commands/lineage/adopt.js';
+
+const A = '11111111-1111-4111-8111-111111111111';
+const B = '22222222-2222-4222-8222-222222222222';
+const C = '33333333-3333-4333-8333-333333333333';
+const D = '44444444-4444-4444-8444-444444444444';
+
+function noteRaw(options: {
+  type?: string;
+  id?: string;
+  parent?: string;
+  name?: string;
+  extra?: string;
+  body?: string;
+} = {}): string {
+  return `---\n` +
+    `${options.type === undefined ? 'type: idea\n' : options.type ? `type: ${options.type}\n` : ''}` +
+    `${options.id ? `id: ${options.id}\n` : ''}` +
+    `${options.parent ? `forked-from: ${options.parent}\n` : ''}` +
+    `${options.name ? `name: ${options.name}\n` : ''}` +
+    `status: raw\n${options.extra ?? ''}---\n${options.body ?? ''}`;
+}
+
+describe('lineage adopt', () => {
+  let vaultDir: string;
+
+  beforeEach(async () => {
+    vaultDir = await createTestVault();
+  });
+
+  afterEach(async () => {
+    await cleanupTestVault(vaultDir);
+  });
+
+  it('defaults to a no-write dry run, then applies only IDs and provenance with stable JSON evidence', async () => {
+    const parentPath = join(vaultDir, 'Ideas/Archive/Adopt Parent.md');
+    const childPath = join(vaultDir, 'Ideas/Adopt Child.md');
+    const parentRaw = '\uFEFF---\r\n# provider-safe parent\r\ntype: "idea" # keep quotes\r\nstatus: &raw raw\r\nprovider:\r\n  remote-id: abc-123\r\n---\r\nParent body --- # exact.\r\n';
+    const childRaw = '\uFEFF---\r\ntype: "idea"\r\nstatus: raw\r\nprovider:\r\n  nested: [one, two]\r\nsummary: |-\r\n  do not fold me\r\n---\r\nChild prose.\r\n';
+    await mkdir(join(vaultDir, 'Ideas/Archive'), { recursive: true });
+    await writeFile(parentPath, parentRaw);
+    await writeFile(childPath, childRaw);
+    const registryPath = join(vaultDir, '.bwrb/ids.jsonl');
+    const registryBefore = await readFile(registryPath, 'utf-8').catch(() => null);
+
+    const preview = await runCLI([
+      'lineage', 'adopt', 'Adopt Child', '--from', 'Adopt Parent', '--output', 'json',
+    ], vaultDir);
+    expect(preview.exitCode, preview.stderr || preview.stdout).toBe(0);
+    const previewJson = JSON.parse(preview.stdout);
+    expect(previewJson).toMatchObject({
+      success: true,
+      mode: 'dry-run',
+      child: { path: 'Ideas/Adopt Child.md', id_generated: true },
+      parent: { path: 'Ideas/Archive/Adopt Parent.md', id_generated: true },
+      body_invariance: {
+        child: { unchanged: true },
+        parent: { unchanged: true },
+      },
+    });
+    expect(previewJson.changes.map((change: { field: string; status: string }) => [change.field, change.status]))
+      .toEqual([['id', 'planned'], ['id', 'planned'], ['forked-from', 'planned']]);
+    expect(await readFile(parentPath, 'utf-8')).toBe(parentRaw);
+    expect(await readFile(childPath, 'utf-8')).toBe(childRaw);
+    expect(await readFile(registryPath, 'utf-8').catch(() => null)).toBe(registryBefore);
+
+    const executed = await runCLI([
+      'lineage', 'adopt', 'Adopt Child', '--from', 'Adopt Parent', '--execute', '--output', 'json',
+    ], vaultDir);
+    expect(executed.exitCode, executed.stderr || executed.stdout).toBe(0);
+    const output = JSON.parse(executed.stdout);
+    expect(output).toMatchObject({
+      success: true,
+      mode: 'execute',
+      child: { path: 'Ideas/Adopt Child.md', id_generated: true },
+      parent: { path: 'Ideas/Archive/Adopt Parent.md', id_generated: true },
+      warnings: [],
+    });
+    expect(output.child.id).not.toBe(output.parent.id);
+    expect(output.changes.every((change: { status: string }) => change.status === 'applied')).toBe(true);
+
+    const parentAfter = await readFile(parentPath, 'utf-8');
+    const childAfter = await readFile(childPath, 'utf-8');
+    expect(parentAfter.replace(`id: ${output.parent.id}\r\n`, '')).toBe(parentRaw);
+    expect(
+      childAfter
+        .replace(`forked-from: ${output.parent.id}\r\n`, '')
+        .replace(`id: ${output.child.id}\r\n`, '')
+    ).toBe(childRaw);
+    expect((await parseNote(parentPath)).body).toBe('Parent body --- # exact.\r\n');
+    expect((await parseNote(childPath)).body).toBe('Child prose.\r\n');
+
+    const registry = (await readFile(registryPath, 'utf-8')).trim().split('\n').map(line => JSON.parse(line));
+    expect(registry.filter(row => row.path === 'Ideas/Archive/Adopt Parent.md')).toHaveLength(1);
+    expect(registry.filter(row => row.path === 'Ideas/Adopt Child.md')).toHaveLength(1);
+
+    const lineage = await runCLI(['list', '--lineage', output.child.id, '--output', 'json'], vaultDir);
+    expect(lineage.exitCode, lineage.stderr || lineage.stdout).toBe(0);
+    expect(JSON.parse(lineage.stdout).nodes.map((node: { path: string }) => node.path))
+      .toEqual(['Ideas/Archive/Adopt Parent.md', 'Ideas/Adopt Child.md']);
+
+    const audit = await runCLI(['audit', '--path', 'Ideas/Adopt Child.md', '--output', 'json'], vaultDir);
+    expect(audit.exitCode, audit.stderr || audit.stdout).toBe(0);
+    const codes = JSON.parse(audit.stdout).files.flatMap(
+      (file: { issues: Array<{ code: string }> }) => file.issues.map(issue => issue.code)
+    );
+    expect(codes.filter((code: string) => code.includes('fork') || code.includes('lineage') || code.includes('note-id')))
+      .toEqual([]);
+  });
+
+  it('resolves child and parent by exact UUID, path, basename, name, and schema alias', async () => {
+    const schemaPath = join(vaultDir, '.bwrb/schema.json');
+    const schema = JSON.parse(await readFile(schemaPath, 'utf-8')) as any;
+    schema.types.idea.fields.aliases = { prompt: 'list', alias: true };
+    schema.types.idea.field_order.push('aliases');
+    await writeFile(schemaPath, JSON.stringify(schema, null, 2));
+
+    const selectors = [
+      { child: A, parent: B },
+      { child: 'Ideas/Resolve Child Path', parent: 'Ideas/Resolve Parent Path.md' },
+      { child: 'Resolve Child Basename', parent: 'Resolve Parent Basename' },
+      { child: 'Child Frontmatter Name', parent: 'Parent Frontmatter Name' },
+      { child: 'Child Alias', parent: 'Parent Alias' },
+    ];
+    for (let index = 0; index < selectors.length; index++) {
+      const childName = index === 1 ? 'Resolve Child Path' : index === 2 ? 'Resolve Child Basename' : `Resolve Child ${index}`;
+      const parentName = index === 1 ? 'Resolve Parent Path' : index === 2 ? 'Resolve Parent Basename' : `Resolve Parent ${index}`;
+      await writeFile(join(vaultDir, `Ideas/${childName}.md`), noteRaw({
+        id: index === 0 ? A : undefined,
+        name: index === 3 ? 'Child Frontmatter Name' : undefined,
+        extra: index === 4 ? 'aliases: [Child Alias]\n' : undefined,
+      }));
+      await writeFile(join(vaultDir, `Ideas/${parentName}.md`), noteRaw({
+        id: index === 0 ? B : undefined,
+        name: index === 3 ? 'Parent Frontmatter Name' : undefined,
+        extra: index === 4 ? 'aliases: [Parent Alias]\n' : undefined,
+      }));
+      const result = await runCLI([
+        'lineage', 'adopt', selectors[index]!.child, '--from', selectors[index]!.parent,
+        '--dry-run', '--output', 'json',
+      ], vaultDir);
+      expect(result.exitCode, `${index}: ${result.stderr || result.stdout}`).toBe(0);
+      expect(JSON.parse(result.stdout).mode).toBe('dry-run');
+    }
+  });
+
+  it.each([
+    { label: 'neither', childId: undefined, parentId: undefined, generated: [true, true] },
+    { label: 'child only', childId: A, parentId: undefined, generated: [false, true] },
+    { label: 'parent only', childId: undefined, parentId: B, generated: [true, false] },
+    { label: 'both', childId: C, parentId: D, generated: [false, false] },
+  ])('preserves valid IDs and backfills the $label ID combination', async ({ label, childId, parentId, generated }) => {
+    const suffix = label.replace(' ', '-');
+    await writeFile(join(vaultDir, `Ideas/Combo Child ${suffix}.md`), noteRaw({ id: childId }));
+    await writeFile(join(vaultDir, `Ideas/Combo Parent ${suffix}.md`), noteRaw({ id: parentId }));
+    const result = await runCLI([
+      'lineage', 'adopt', `Combo Child ${suffix}`, '--from', `Combo Parent ${suffix}`,
+      '--execute', '--output', 'json',
+    ], vaultDir);
+    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
+    const output = JSON.parse(result.stdout);
+    expect([output.child.id_generated, output.parent.id_generated]).toEqual(generated);
+    if (childId) expect(output.child.id).toBe(childId);
+    if (parentId) expect(output.parent.id).toBe(parentId);
+  });
+
+  it('refuses self-edges, type mismatch, existing provenance, invalid IDs, and unsafe graph state without writes', async () => {
+    const cases: Array<{ child: string; parent: string; expected: string }> = [];
+    await writeFile(join(vaultDir, 'Ideas/Self.md'), noteRaw({ id: A }));
+    cases.push({ child: 'Self', parent: A.toLowerCase(), expected: 'under itself' });
+
+    await writeFile(join(vaultDir, 'Ideas/Idea Child.md'), noteRaw());
+    cases.push({ child: 'Idea Child', parent: 'Sample Task', expected: 'across note types' });
+
+    await writeFile(join(vaultDir, 'Ideas/Has Parent.md'), noteRaw({ id: B, parent: A }));
+    cases.push({ child: 'Has Parent', parent: 'Self', expected: 'already has forked-from' });
+
+    await writeFile(join(vaultDir, 'Ideas/Bad ID.md'), noteRaw({ id: 'not-a-uuid' }));
+    cases.push({ child: 'Bad ID', parent: 'Self', expected: 'not a valid UUID' });
+
+    await writeFile(join(vaultDir, 'Ideas/Bad Parent ID.md'), noteRaw({ id: 'still-not-a-uuid' }));
+    cases.push({ child: 'Idea Child', parent: 'Bad Parent ID', expected: 'not a valid UUID' });
+
+    for (const testCase of cases) {
+      const childPath = testCase.child === 'Sample Task'
+        ? join(vaultDir, 'Objectives/Tasks/Sample Task.md')
+        : join(vaultDir, `Ideas/${testCase.child}.md`);
+      const before = await readFile(childPath, 'utf-8');
+      const result = await runCLI([
+        'lineage', 'adopt', testCase.child, '--from', testCase.parent,
+        '--execute', '--output', 'json',
+      ], vaultDir);
+      expect(result.exitCode).toBe(1);
+      expect(JSON.parse(result.stdout).error).toContain(testCase.expected);
+      expect(await readFile(childPath, 'utf-8')).toBe(before);
+    }
+
+    await writeFile(join(vaultDir, 'Ideas/Duplicate A.md'), noteRaw({ id: C }));
+    await writeFile(join(vaultDir, 'Ideas/Duplicate B.md'), noteRaw({ id: C.toLowerCase() }));
+    const duplicate = await runCLI([
+      'lineage', 'adopt', 'Idea Child', '--from', 'Self', '--execute', '--output', 'json',
+    ], vaultDir);
+    expect(duplicate.exitCode).toBe(1);
+    expect(JSON.parse(duplicate.stdout).error).toContain('duplicate-note-id');
+
+    await writeFile(join(vaultDir, 'Ideas/Duplicate B.md'), noteRaw({ id: D }));
+    await writeFile(join(vaultDir, 'Ideas/Dangling.md'), noteRaw({ id: C, parent: '99999999-9999-4999-8999-999999999999' }));
+    const dangling = await runCLI([
+      'lineage', 'adopt', 'Idea Child', '--from', 'Self', '--output', 'json',
+    ], vaultDir);
+    expect(dangling.exitCode).toBe(1);
+    expect(JSON.parse(dangling.stdout).error).toContain('dangling-forked-from');
+  });
+
+  it('refuses missing or invalid resolved types for either target role', async () => {
+    await writeFile(join(vaultDir, 'Ideas/Untyped Child.md'), noteRaw({ type: '' }));
+    await writeFile(join(vaultDir, 'Ideas/Invalid Child Type.md'), noteRaw({ type: 'not-a-type' }));
+    await writeFile(join(vaultDir, 'Ideas/Untyped Parent.md'), noteRaw({ type: '' }));
+    await writeFile(join(vaultDir, 'Ideas/Invalid Parent Type.md'), noteRaw({ type: 'not-a-type' }));
+
+    for (const [child, parent, expected] of [
+      ['Untyped Child', 'Sample Idea', 'Adoption child source does not have a valid schema type'],
+      ['Invalid Child Type', 'Sample Idea', 'Adoption child source does not have a valid schema type'],
+      ['Sample Idea', 'Untyped Parent', 'Adoption parent source does not have a valid schema type'],
+      ['Sample Idea', 'Invalid Parent Type', 'Adoption parent source does not have a valid schema type'],
+    ]) {
+      const result = await runCLI([
+        'lineage', 'adopt', child!, '--from', parent!, '--execute', '--output', 'json',
+      ], vaultDir);
+      expect(result.exitCode).toBe(1);
+      expect(JSON.parse(result.stdout).error).toContain(expected);
+    }
+  });
+
+  it('rolls both note bytes back when atomic registry registration fails after backfill writes', async () => {
+    const childPath = join(vaultDir, 'Ideas/Rollback Child.md');
+    const parentPath = join(vaultDir, 'Ideas/Rollback Parent.md');
+    const childRaw = noteRaw({ extra: 'provider: { remote: child }\n', body: 'Child bytes\n' });
+    const parentRaw = noteRaw({ extra: 'provider: { remote: parent }\n', body: 'Parent bytes\n' });
+    await writeFile(childPath, childRaw);
+    await writeFile(parentPath, parentRaw);
+    const registryPath = join(vaultDir, '.bwrb/ids.jsonl');
+    const registryBefore = await readFile(registryPath, 'utf-8').catch(() => null);
+    const schema = await loadSchema(vaultDir);
+
+    await expect(adoptLineage(
+      schema,
+      vaultDir,
+      { child: 'Rollback Child', parent: 'Rollback Parent', execute: true },
+      { registerIds: async () => { throw new Error('injected registry failure'); } }
+    )).rejects.toThrow('injected registry failure');
+
+    expect(await readFile(childPath, 'utf-8')).toBe(childRaw);
+    expect(await readFile(parentPath, 'utf-8')).toBe(parentRaw);
+    expect(await readFile(registryPath, 'utf-8').catch(() => null)).toBe(registryBefore);
+  });
+
+  it('refuses cycles and ambiguous or missing exact targets', async () => {
+    await writeFile(join(vaultDir, 'Ideas/Cycle Root.md'), noteRaw({ id: A }));
+    await writeFile(join(vaultDir, 'Ideas/Cycle Child.md'), noteRaw({ id: B, parent: A }));
+    const cycle = await runCLI([
+      'lineage', 'adopt', 'Cycle Root', '--from', 'Cycle Child', '--execute', '--output', 'json',
+    ], vaultDir);
+    expect(cycle.exitCode).toBe(1);
+    expect(JSON.parse(cycle.stdout).error).toContain('would create a cycle');
+
+    await mkdir(join(vaultDir, 'Ideas/Nested'), { recursive: true });
+    await writeFile(join(vaultDir, 'Ideas/Ambiguous.md'), noteRaw());
+    await writeFile(join(vaultDir, 'Ideas/Nested/Ambiguous.md'), noteRaw());
+    for (const [child, parent, noun] of [
+      ['Ambiguous', 'Cycle Child', 'Ambiguous adoption child target'],
+      ['Sample Idea', 'Ambiguous', 'Ambiguous adoption parent target'],
+      ['Missing child', 'Cycle Child', 'No exact note found for adoption child target'],
+      ['Sample Idea', 'Missing parent', 'No exact note found for adoption parent target'],
+    ]) {
+      const result = await runCLI([
+        'lineage', 'adopt', child!, '--from', parent!, '--output', 'json',
+      ], vaultDir);
+      expect(result.exitCode).toBe(1);
+      expect(JSON.parse(result.stdout).error).toContain(noun);
+    }
+  });
+
+  it('serializes competing adoptions so exactly one parent wins', async () => {
+    await writeFile(join(vaultDir, 'Ideas/Race Child.md'), noteRaw());
+    await writeFile(join(vaultDir, 'Ideas/Race Parent A.md'), noteRaw());
+    await writeFile(join(vaultDir, 'Ideas/Race Parent B.md'), noteRaw());
+    const results = await Promise.all([
+      runCLI(['lineage', 'adopt', 'Race Child', '--from', 'Race Parent A', '--execute', '--output', 'json'], vaultDir),
+      runCLI(['lineage', 'adopt', 'Race Child', '--from', 'Race Parent B', '--execute', '--output', 'json'], vaultDir),
+    ]);
+    expect(results.map(result => result.exitCode).sort()).toEqual([0, 1]);
+    expect(JSON.parse(results.find(result => result.exitCode === 1)!.stdout).error)
+      .toContain('already has forked-from');
+    const child = await parseNote(join(vaultDir, 'Ideas/Race Child.md'));
+    expect(child.frontmatter.id).toMatch(/^[0-9a-f-]{36}$/i);
+    expect(child.frontmatter['forked-from']).toMatch(/^[0-9a-f-]{36}$/i);
+    const parentIds = await Promise.all([
+      parseNote(join(vaultDir, 'Ideas/Race Parent A.md')),
+      parseNote(join(vaultDir, 'Ideas/Race Parent B.md')),
+    ]).then(notes => notes.map(note => note.frontmatter.id).filter(Boolean));
+    expect(parentIds).toContain(child.frontmatter['forked-from']);
+    const registry = (await readFile(join(vaultDir, '.bwrb/ids.jsonl'), 'utf-8'))
+      .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
+    expect(registry.filter(row => row.path === 'Ideas/Race Child.md')).toHaveLength(1);
+  });
+
+  it('stays consistent when adoption races fork and non-force deletion', async () => {
+    await writeFile(join(vaultDir, 'Ideas/Shared Parent.md'), noteRaw());
+    await writeFile(join(vaultDir, 'Ideas/Existing Child.md'), noteRaw());
+    const [adopt, fork] = await Promise.all([
+      runCLI(['lineage', 'adopt', 'Existing Child', '--from', 'Shared Parent', '--execute', '--output', 'json'], vaultDir),
+      runCLI(['new', '--fork', 'Shared Parent', '--name', 'New Fork Child', '--output', 'json'], vaultDir),
+    ]);
+    expect(adopt.exitCode, adopt.stderr || adopt.stdout).toBe(0);
+    expect(fork.exitCode, fork.stderr || fork.stdout).toBe(0);
+    expect(JSON.parse(adopt.stdout).parent.id).toBe(JSON.parse(fork.stdout).forked_from);
+
+    await writeFile(join(vaultDir, 'Ideas/Delete Race Parent.md'), noteRaw());
+    await writeFile(join(vaultDir, 'Ideas/Delete Race Child.md'), noteRaw());
+    const [raceAdopt, raceDelete] = await Promise.all([
+      runCLI(['lineage', 'adopt', 'Delete Race Child', '--from', 'Delete Race Parent', '--execute', '--output', 'json'], vaultDir),
+      runCLI(['delete', '--path', 'Ideas/Delete Race Parent.md', '--execute', '--output', 'json'], vaultDir),
+    ]);
+    expect([0, 1]).toContain(raceAdopt.exitCode);
+    expect([0, 1]).toContain(raceDelete.exitCode);
+    expect(raceAdopt.exitCode === 0 || raceDelete.exitCode === 0).toBe(true);
+
+    const audit = await runCLI(['audit', 'idea', '--output', 'json'], vaultDir);
+    const issues = JSON.parse(audit.stdout).files.flatMap(
+      (file: { issues: Array<{ code: string }> }) => file.issues
+    );
+    expect(issues.filter((issue: { code: string }) => issue.code === 'dangling-forked-from')).toEqual([]);
+  });
+
+  it('rejects conflicting execution flags and unsupported output formats', async () => {
+    const conflict = await runCLI([
+      'lineage', 'adopt', 'Sample Idea', '--from', 'Another Idea',
+      '--dry-run', '--execute', '--output', 'json',
+    ], vaultDir);
+    expect(conflict.exitCode).toBe(1);
+    expect(JSON.parse(conflict.stdout).error).toContain('cannot be combined');
+
+    const output = await runCLI([
+      'lineage', 'adopt', 'Sample Idea', '--from', 'Another Idea', '--output', 'yaml',
+    ], vaultDir);
+    expect(output.exitCode).toBe(1);
+    expect(output.stderr).toContain('--output must be text or json');
+
+    const missingFrom = await runCLI([
+      'lineage', 'adopt', 'Sample Idea', '--output', 'json',
+    ], vaultDir);
+    expect(missingFrom.exitCode).toBe(1);
+    expect(JSON.parse(missingFrom.stdout).error).toContain('--from <parent> is required');
+  });
+});
diff --git a/tests/ts/commands/list-lineage.test.ts b/tests/ts/commands/list-lineage.test.ts
index 117fb90..1d0f203 100644
--- a/tests/ts/commands/list-lineage.test.ts
+++ b/tests/ts/commands/list-lineage.test.ts
@@ -367,13 +367,13 @@ B body
       .not.toContain('dangling-forked-from');
   });
 
-  it('documents lineage on list help without adding a top-level command', async () => {
+  it('documents lineage reading on list help and lineage mutation as a top-level command', async () => {
     const listHelp = await runCLI(['list', '--help'], vaultDir);
     expect(listHelp.exitCode).toBe(0);
     expect(listHelp.stdout).toContain('--lineage <target>');
 
     const topHelp = await runCLI(['--help'], vaultDir);
     expect(topHelp.exitCode).toBe(0);
-    expect(topHelp.stdout).not.toMatch(/^\s+lineage(?:\s|$)/m);
+    expect(topHelp.stdout).toMatch(/^\s+lineage(?:\s|$)/m);
   });
 });
diff --git a/tests/ts/helpers/help.ts b/tests/ts/helpers/help.ts
index 6f4faf1..caa279c 100644
--- a/tests/ts/helpers/help.ts
+++ b/tests/ts/helpers/help.ts
@@ -8,6 +8,7 @@ const CANONICAL_HELP_COMMAND_ORDER = [
   'audit',
   'bulk',
   'template',
+  'lineage',
   'dashboard',
   'init',
   'config',
diff --git a/tests/ts/lib/note-id-lock.test.ts b/tests/ts/lib/note-id-lock.test.ts
new file mode 100644
index 0000000..35b9a41
--- /dev/null
+++ b/tests/ts/lib/note-id-lock.test.ts
@@ -0,0 +1,140 @@
+import { existsSync } from 'fs';
+import { mkdtemp, readFile, rm, stat, unlink } from 'fs/promises';
+import { tmpdir } from 'os';
+import { join } from 'path';
+import { afterEach, beforeEach, describe, expect, it } from 'vitest';
+import {
+  withNoteIdAssignmentLock,
+  withNoteIdRegistryLock,
+} from '../../../src/lib/note-id.js';
+import type { OwnershipFileLockOptions } from '../../../src/lib/lineage-lock.js';
+
+const TEST_LOCK_OPTIONS: Partial<OwnershipFileLockOptions> = {
+  retryMs: 2,
+  attempts: 250,
+  staleMs: 45,
+  heartbeatMs: 5,
+};
+
+const LOCKS = [
+  {
+    name: 'note-ID assignment',
+    path: '.bwrb/locks/fork-source-id.lock',
+    run: withNoteIdAssignmentLock,
+  },
+  {
+    name: 'note-ID registry',
+    path: '.bwrb/locks/id-registry.lock',
+    run: withNoteIdRegistryLock,
+  },
+] as const;
+
+describe.each(LOCKS)('$name lock', ({ path, run }) => {
+  let vaultDir: string;
+  let lockPath: string;
+
+  beforeEach(async () => {
+    vaultDir = await mkdtemp(join(tmpdir(), 'bwrb-note-id-lock-'));
+    lockPath = join(vaultDir, path);
+  });
+
+  afterEach(async () => {
+    await rm(vaultDir, { recursive: true, force: true });
+  });
+
+  it('heartbeats a live holder and does not reap it after the stale threshold', async () => {
+    let releaseFirst!: () => void;
+    const firstBarrier = new Promise<void>(resolve => { releaseFirst = resolve; });
+    let active = 0;
+    let maxActive = 0;
+    const first = run(vaultDir, async () => {
+      active++;
+      maxActive = Math.max(maxActive, active);
+      await firstBarrier;
+      active--;
+    }, TEST_LOCK_OPTIONS);
+
+    await waitFor(() => existsSync(lockPath));
+    const initialMtime = (await stat(lockPath)).mtimeMs;
+    await delay(70);
+    const heartbeatMtime = (await stat(lockPath)).mtimeMs;
+    expect(heartbeatMtime).toBeGreaterThan(initialMtime);
+    expect(Date.now() - heartbeatMtime).toBeLessThan(45);
+
+    let secondEntered = false;
+    const second = run(vaultDir, async () => {
+      secondEntered = true;
+      active++;
+      maxActive = Math.max(maxActive, active);
+      active--;
+    }, TEST_LOCK_OPTIONS);
+    await delay(25);
+    expect(secondEntered).toBe(false);
+    expect(maxActive).toBe(1);
+
+    releaseFirst();
+    await Promise.all([first, second]);
+    expect(maxActive).toBe(1);
+    expect(existsSync(lockPath)).toBe(false);
+  });
+
+  it('keeps a successor owned after replacement and serializes a third holder behind it', async () => {
+    let releaseFirst!: () => void;
+    const firstBarrier = new Promise<void>(resolve => { releaseFirst = resolve; });
+    const first = run(vaultDir, async () => {
+      await firstBarrier;
+    }, TEST_LOCK_OPTIONS);
+    await waitFor(() => existsSync(lockPath));
+
+    // Simulate stale-owner recovery moving the old inode out of the lock path.
+    // The successor then acquires that same fixed coordination pathname.
+    await unlink(lockPath);
+    let releaseSecond!: () => void;
+    const secondBarrier = new Promise<void>(resolve => { releaseSecond = resolve; });
+    let active = 0;
+    let maxActive = 0;
+    let secondEntered = false;
+    const second = run(vaultDir, async () => {
+      secondEntered = true;
+      active++;
+      maxActive = Math.max(maxActive, active);
+      await secondBarrier;
+      active--;
+    }, TEST_LOCK_OPTIONS);
+    await waitFor(() => secondEntered);
+    const successorMetadata = await readFile(lockPath, 'utf-8');
+
+    releaseFirst();
+    await first;
+    expect(await readFile(lockPath, 'utf-8')).toBe(successorMetadata);
+
+    let thirdEntered = false;
+    const third = run(vaultDir, async () => {
+      thirdEntered = true;
+      active++;
+      maxActive = Math.max(maxActive, active);
+      active--;
+    }, TEST_LOCK_OPTIONS);
+    await delay(25);
+    expect(thirdEntered).toBe(false);
+    expect(maxActive).toBe(1);
+
+    releaseSecond();
+    await Promise.all([second, third]);
+    expect(thirdEntered).toBe(true);
+    expect(maxActive).toBe(1);
+    expect(existsSync(lockPath)).toBe(false);
+  });
+});
+
+async function waitFor(predicate: () => boolean): Promise<void> {
+  for (let attempt = 0; attempt < 250; attempt++) {
+    if (predicate()) return;
+    await delay(2);
+  }
+  throw new Error('Timed out waiting for lock test condition');
+}
+
+function delay(ms: number): Promise<void> {
+  return new Promise(resolve => setTimeout(resolve, ms));
+}

END DIFF

