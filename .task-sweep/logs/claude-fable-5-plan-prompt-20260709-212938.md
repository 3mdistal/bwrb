# TaskSweep early planning packet

You are advising on a repository task before implementation. You have no tools. Do not claim to inspect anything outside this packet. Give advice for another agent; do not propose mutations beyond the stated task.

## Normalized task record

- ID: bwrb-lineage-adopt-2026-07-09
- Source: `/Users/alicemoore/Developer/teenylilthoughts/briefs/Bowerbird native document lineage migration 2026-07-09.md`
- Repository: `3mdistal/bwrb`
- Base: `origin/main` at `7b741c632805554dff77cf4cae8d42005cea6e3b` (`v0.2.3`)
- Branch: `codex/lineage-adopt` in an isolated worktree
- Problem: Existing notes whose true historical derivation is known cannot be safely attached to immutable native document lineage. Ordinary edit/create/template/audit paths must stay unable to set or mutate `forked-from`.
- Desired command (validate against repo conventions):
  - `bwrb lineage adopt "Child note" --from "Parent note" --dry-run --output json`
  - `bwrb lineage adopt "Child note" --from "Parent note" --execute --output json`
- Scope: One parent-to-child edge per invocation. Default dry-run. Explicit `--execute` required for writes. No force/bulk mode.
- Resolution: child and parent only via existing exact path/name/alias/UUID machinery; reject ambiguous or absent targets.
- Validation: same resolved type; refuse self-edge, invalid/missing type, existing `forked-from`, duplicate stable IDs anywhere relevant, and any new cycle.
- Mutation: preserve valid existing IDs; atomically backfill missing parent/child IDs; assign child `forked-from` to parent ID; coordinate with existing fork/delete/adopt locks; preserve bodies, filenames, ordinary frontmatter, aliases, provider fields, and all other bytes.
- JSON: stable agent-oriented result containing mode, parent/child paths and IDs, planned/applied field changes, warnings, and body-invariance evidence.
- Docs/release surface: reference docs, changelog/docs changelog, completions, bundled agent skill, system-field policy as appropriate.
- Testing: focused unit/integration/CLI tests, disposable-vault built CLI smoke, audit/list lineage proof, and fork/delete/adopt race coverage.
- Out of scope: any migration of the user's teenylilthoughts vault or schema changes described later in the source brief.
- Successful user story: A vault owner previews and explicitly adopts an existing child under an existing parent without changing prose or ordinary metadata; both gain stable identity if needed; `list --lineage` shows the family; audit stays clean; dishonest/cyclic adoption is refused; concurrent lineage mutations remain safe.

## Repository and policy facts

- TypeScript ESM CLI built with Commander 12, Node 22, `pnpm@10.11.0`.
- Root command registration order in `src/index.ts`: CRUD, query, schema/management, saved queries, utility.
- Top-level `lineage` would be new. Current lineage read surface is `list --lineage`; mutation surface is `new --fork`.
- Full local CI parity, exact order: `pnpm build`; `pnpm verify:pack`; `pnpm typecheck`; `pnpm lint`; `pnpm knip`; `pnpm test -- --exclude='**/*.pty.test.ts'`.
- Branch protection is strict and current required checks are `Test`, `PTY Tests`, and `Vercel`; required review count is zero; admins are enforced.
- Canonical user docs are under `docs-site/src/content/docs/`; bundled programmatic skill is `docs/skill/SKILL.md`.
- Existing lineage feature PRs: #802 foundation/immutability/audit, #803 `new --fork`, #804 `list --lineage`, #806 delete protection and lineage locks.

## Read-only repo context

### Exact note resolution

`src/lib/exact-note-target.ts` exports `resolveExactNoteTarget(schema, vaultDir, target, { purpose })` and returns `{ file, frontmatter, body, typeName, snapshot }`. For `purpose: 'lineage'` it builds one `VaultNoteSnapshot`, constructs maps, and resolves in this strict precedence:

1. case-insensitive UUID (error if duplicates),
2. absolute/relative path inside the vault,
3. basename (error if ambiguous),
4. frontmatter `name` (error if ambiguous),
5. schema-declared aliases (error if ambiguous).

It never performs fuzzy matching. It rejects a selected note without a valid resolved schema type. Current purpose values are `'fork' | 'lineage'`, so error nouns may need extending to distinguish parent/child adoption targets cleanly.

### Byte-preserving mutation and atomic file write

`src/lib/frontmatter.ts` has:

```ts
export function insertFrontmatterScalarPreservingBytes(
  content: string,
  key: string,
  value: string
): string
```

It inserts one plain scalar into valid top-level mapping frontmatter without reserializing existing YAML. It preserves BOM, EOL, comments, anchors, quotes, block scalars, and body. It refuses an existing key.

```ts
export async function writeFileAtomic(filePath: string, content: string): Promise<void>
```

It writes/fsyncs a same-directory exclusive temp file and atomically renames it over one target. There is no obvious cross-file transaction primitive. `new --fork` backfills a source ID, then appends the ID registry; if registry append fails it restores the source's original raw bytes.

### Stable IDs

`src/lib/note-id.ts` exposes `isValidNoteId`, `normalizeNoteId`, `generateUniqueNoteId`, `registerIssuedNoteId`, and `unregisterIssuedNotePath`. Issued IDs are append-only JSONL at `.bwrb/ids.jsonl`; generation avoids IDs already registered. `new --fork` additionally scans current notes for collisions before accepting/backfilling a source ID.

### Existing fork critical section

`src/commands/new/fork.ts` resolves the source, checks an existing ID for uniqueness, then calls:

```ts
return withLineageMutationLocks(vaultDir, [source.file.path], async () => {
  const sourceId = await ensureSourceId(schema, vaultDir, source.file.path);
  const current = await parseNote(source.file.path);
  // revalidate type, create child exclusively, register child ID
});
```

It re-reads after locking. A separate `.bwrb/locks/fork-source-id.lock` serializes legacy source ID backfill. This suggests adoption must acquire locks for both parent and child paths in deterministic order and re-resolve/revalidate all graph invariants inside the critical section, not trust pre-lock state.

### Existing lineage mutation locks

`src/lib/lineage-lock.ts` exports:

```ts
export async function withLineageMutationLocks<T>(
  vaultDir: string,
  sourcePaths: string[],
  task: () => Promise<T>,
  optionOverrides: Partial<LineageLockOptions> = {}
): Promise<T>
```

It derives a case-folded SHA-256 lock per canonical vault-relative source path, deduplicates and sorts lock paths to avoid deadlock, uses exclusive lock files with ownership tokens/heartbeats, and safely recovers stale locks. `new --fork` locks its source path; non-force delete locks paths whose outgoing/child relationships might be affected.

### Lineage graph

`src/lib/lineage.ts` exposes `buildLineageMaps(snapshot)` with `notesById` and `childrenByParentId`, normalizing UUID identity. `collectLineage(target, maps)` detects duplicate IDs while traversing, warns on invalid/dangling edges and missing child IDs, and deterministically detects cycles. Audit separately detects invalid/missing/dangling/duplicate/cyclic lineage. The adopter needs a narrow prospective-edge cycle predicate; likely equivalent to rejecting when the proposed child is already an ancestor of the proposed parent, while malformed/duplicate graph state should fail closed.

### Current JSON and errors

`list --lineage --output json` returns:

```json
{
  "target": { "path": "...", "id": "..." },
  "nodes": [{ "path": "...", "id": "...", "forked_from": "...", "depth": 0, "relationship": "target" }],
  "warnings": []
}
```

Command handlers use `jsonError(message, { code: ExitCodes.VALIDATION_ERROR })` and exit code 1 for validation failures. `new --fork` returns snake_case keys such as `forked_from`.

### Tests and known contracts

- `tests/ts/commands/new-fork.test.ts`: exact UUID/path/name/alias resolution, ambiguity/fuzzy refusal, concurrent missing-source-ID backfill, byte preservation including CRLF/comments, invalid/duplicate ID refusal, path collision, incompatible flags, ownership rules, and audit-clean lineage.
- `tests/ts/commands/delete-lineage.test.ts`: non-force delete guards and a sequential real-CLI fork-vs-delete race test.
- `tests/ts/lib/lineage-lock.test.ts`: deterministic multi-lock acquisition, ownership/heartbeat/stale recovery, and timeout behavior.
- `tests/ts/commands/list-lineage.test.ts` and `tests/ts/commands/audit-lineage.test.ts`: connected family rendering plus malformed/dangling/duplicate/cycle behavior.
- Commander negated flag contract: `.option('--no-foo')` sets `options.foo === false`. Avoid a negated flag here if a positive `--execute` is sufficient.

## Questions for the planning review

1. Is `bwrb lineage adopt <child> --from <parent>` the clearest repository-consistent namespace, or is there a strong reason to keep it under `new`/`edit` despite immutability boundaries?
2. What is the safest minimal algorithm for dry-run and execute, especially lock scope, fresh snapshot timing, duplicate-ID validation, cycle validation, and rollback across two notes plus `.bwrb/ids.jsonl`?
3. What JSON schema makes planned versus applied changes and byte/body invariance clear and stable without promising impossible filesystem transaction semantics?
4. Which concurrency races must be tested among adopt/adopt, adopt/fork, and adopt/delete?
5. Which failure modes or scope traps are most likely to be missed?

Give a concise implementation plan with:

- root-cause and files to inspect,
- minimal command and library design,
- precise validation/mutation ordering,
- tests and real CLI checks,
- docs/release/completion updates,
- risks and edge cases,
- parallel/conflict cautions.
