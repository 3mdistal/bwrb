# Planning advice: `bwrb lineage adopt`

## 1. Namespace answer

Keep `bwerb lineage adopt` as a new top-level `lineage` command group. Rationale: `new` semantics are "create a note" (fork creates the child); `edit` is explicitly forbidden from touching `forked-from` by policy, and grafting an escape hatch into `edit` weakens the immutability story the audit/system-field policy depends on. A dedicated `lineage` namespace also gives a natural home for future read subcommands. Register it in `src/index.ts` in the schema/management or utility block — decide by looking at where `audit`/lock-adjacent commands sit; do not disturb the documented registration order for existing commands.

## Root cause and files to inspect

- **Root cause:** immutability of `forked-from` is enforced across all mutation paths, so historically-known lineage cannot be attached; the fix is a single narrowly-scoped, heavily-validated write path that coexists with existing locks.
- **Inspect before writing code:**
  - `src/commands/new/fork.ts` — the canonical lock/backfill/revalidate pattern to mirror.
  - `src/lib/exact-note-target.ts` — extend `purpose` union (e.g. `'adopt-child' | 'adopt-parent'`) so error nouns distinguish the two targets.
  - `src/lib/lineage-lock.ts`, `src/lib/lineage.ts`, `src/lib/note-id.ts`, `src/lib/frontmatter.ts` — reuse, don't reimplement.
  - Delete's lineage guard (per #806) — confirm which paths it locks so adopt's lock set actually collides with it.
  - `list --lineage` / `new --fork` JSON output for key-naming conventions (snake_case).
  - `docs/skill/SKILL.md`, `docs-site/src/content/docs/`, completions source, changelog(s).

## Minimal command and library design

- `src/commands/lineage/adopt.ts` (handler) + `src/commands/lineage/index.ts` (subcommand registration). Flags: `--from <parent>` (required), `--execute`, `--output json|text`, and accept `--dry-run` as an explicit no-op alias of the default so scripts can be self-documenting. Do **not** use Commander negated flags.
- One small new library function, e.g. `validateProspectiveEdge(maps, childId?, parentId?, childPath, parentPath)` in `src/lib/lineage.ts` or adjacent: rejects self-edge, existing `forked-from` on child, duplicate IDs anywhere in the connected components, and the prospective cycle (proposed parent must not have the proposed child as an ancestor; walk parent's ancestor chain with the maps' cycle detection). Fail closed on any malformed/dangling/duplicate state touching either family.
- Reuse `insertFrontmatterScalarPreservingBytes` for all three possible writes (parent ID backfill, child ID backfill, child `forked-from`). Note it **refuses an existing key** — that property is your safety net against double-writing `forked-from`.

## Precise validation/mutation ordering

**Dry-run (default):**
1. Resolve child and parent via `resolveExactNoteTarget` with distinct purposes; reject absent/ambiguous.
2. Same resolved type check; self-edge check (same canonical path or same ID).
3. Build lineage maps from one fresh snapshot; run prospective-edge validation.
4. Emit plan JSON (fields that *would* be written, whether IDs would be generated, warnings). No lock acquisition needed for dry-run, but state clearly in JSON that it's advisory (`"mode": "dry-run"`).

**Execute:**
1. Same pre-lock resolution (cheap fail-fast only; treat results as untrusted).
2. `withLineageMutationLocks(vaultDir, [childPath, parentPath], ...)` — the helper already dedupes/sorts, so deadlock ordering is handled. If legacy ID backfill needs the `fork-source-id.lock`, acquire it the same way fork does, consistently ordered relative to the lineage locks (mirror fork exactly).
3. **Inside the lock:** re-read both notes (`parseNote`), re-resolve types, rebuild a fresh snapshot and lineage maps, and rerun *all* validations, including duplicate-ID scan across current notes (as fork does) — never trust pre-lock state.
4. Ensure parent ID: if missing, `generateUniqueNoteId`, write parent atomically, `registerIssuedNoteId`.
5. Ensure child ID: same.
6. Write child `forked-from: <parentId>` via byte-preserving insert + `writeFileAtomic`.
7. **Rollback contract:** there is no cross-file transaction. Order writes so partial failure is benign: ID backfills alone are harmless (audit-clean, no edge). Only the final child write creates the edge, and it's a single atomic rename. If registry append fails after a backfill, restore original raw bytes as fork does (capture pre-write bytes for both files before touching them). Document in JSON output that ID backfills may persist even if the edge write fails — that's honest and safe.

## JSON schema

Snake_case, matching fork/list conventions:

```json
{
  "mode": "dry-run" | "execute",
  "child": { "path": "...", "id": "...", "id_generated": false },
  "parent": { "path": "...", "id": "...", "id_generated": true },
  "changes": [
    { "path": "...", "field": "id", "value": "...", "status": "planned" | "applied" },
    { "path": "...", "field": "forked-from", "value": "...", "status": "applied" }
  ],
  "body_invariance": { "child_body_unchanged": true, "parent_body_unchanged": true },
  "warnings": []
}
```

For body-invariance evidence, compare pre/post body bytes (or hash) around the frontmatter insert and assert equality in the handler — report the check result, not a promise of transactionality. Errors via `jsonError(..., ExitCodes.VALIDATION_ERROR)`.

## Tests and real CLI checks

Unit/integration (`tests/ts/commands/lineage-adopt.test.ts` modeled on `new-fork.test.ts`):
- Resolution: UUID/path/basename/name/alias exact matches; ambiguity and absence refusals for **both** child and parent; distinct error nouns.
- Validation refusals: type mismatch, self-edge (path and ID variants), child already has `forked-from`, duplicate IDs, prospective cycle (adopting an ancestor under a descendant), malformed graph state → fail closed.
- Mutation: all four ID states (both present / both missing / one missing each way); byte preservation with CRLF, BOM, comments, anchors, block scalars; body hash unchanged; registry updated; audit clean; `list --lineage` shows the family.
- Dry-run writes nothing (byte-identical vault, no registry append).
- JSON shape snapshot for both modes.

Concurrency races (real-CLI style like `delete-lineage.test.ts`):
- **adopt vs adopt:** same child, two parents concurrently → exactly one wins (the loser hits the existing-`forked-from` recheck inside the lock).
- **adopt vs fork:** fork of the parent while adopt backfills parent ID → no duplicate IDs, registry consistent (exercises `fork-source-id.lock` interaction).
- **adopt vs delete:** delete parent while adopt executes → adopt either completes before delete's guard sees the edge, or fails cleanly; no dangling edge silently written. Confirm delete's lock set actually overlaps adopt's — if delete only locks certain paths, this is the highest-risk gap.

Built-CLI smoke: disposable vault, dry-run then execute, then `list --lineage` and `audit` proof. Add a PTY test only if interactive output is added (prefer none).

Run full CI parity in exact order: `pnpm build; pnpm verify:pack; pnpm typecheck; pnpm lint; pnpm knip; pnpm test -- --exclude='**/*.pty.test.ts'`. Knip will flag any newly-exported-but-unused helpers — keep the surface minimal.

## Docs/release/completions

- Reference doc page under `docs-site/src/content/docs/` for `lineage adopt` (default dry-run semantics prominent).
- Update `docs/skill/SKILL.md` with the agent-facing JSON contract.
- Changelog + docs changelog entries; update system-field policy doc to note the single sanctioned `forked-from` write path.
- Shell completions for the new `lineage` group and flags.
- Cross-link from `new --fork` and `list --lineage` docs.

## Risks, edge cases, likely-missed traps

- **Lock coverage gap with delete:** verify adopt's locked paths intersect delete's guard locks; otherwise the adopt/delete race is only probabilistically safe.
- **Purpose-noun extension:** changing `resolveExactNoteTarget`'s purpose union touches fork's error messages — keep `'fork'`/`'lineage'` behavior byte-identical; add new purposes rather than repurposing.
- **`insertFrontmatterScalarPreservingBytes` refuses existing keys:** an inside-lock re-read that finds `forked-from` must produce a validation error, not an unhandled throw.
- **Notes with no frontmatter or invalid YAML:** confirm the insert helper's contract ("valid top-level mapping frontmatter"); refuse cleanly otherwise.
- **Dangling/duplicate graph state near either note:** fail closed rather than "adopt anyway"; audit is the remediation path.
- **Scope traps:** no bulk/force mode, no re-parenting, no removal of edges, no vault migration, no schema changes — all explicitly out of scope; resist adding `--force`.
- **Case-folded path identity:** self-edge check must use the same canonicalization the lock module uses, or case-variant paths could slip a self-edge past validation while still deadlocking or double-locking.

## Parallel/conflict cautions

- PRs #802–#806 established this surface recently; rebase on `origin/main@7b741c6` and watch for in-flight lineage PRs touching `lineage-lock.ts`, `lineage.ts`, or delete guards — coordinate rather than fork behavior.
- Required checks are `Test`, `PTY Tests`, `Vercel`; the docs-site change will exercise Vercel — keep docs edits in the same PR so the deployment preview validates them.
- Don't refactor fork's backfill logic into shared helpers unless trivial; behavioral drift in fork is the easiest way to break its extensive existing test suite.