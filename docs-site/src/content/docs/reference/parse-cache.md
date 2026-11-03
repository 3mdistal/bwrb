---
title: Note parsing cache
description: Disposable, content-verified metadata reuse across Bowerbird runs
---

Bowerbird keeps a bounded cache of normalized note frontmatter between runs.
Snapshots still rediscover files and read each note's current bytes. A cached
parse is reused only when those bytes have the same SHA-256 fingerprint. File
timestamps, Git HEAD and a previous file inventory are never freshness proofs.
Schema interpretation, aliases, ownership, dates and derived indexes are rebuilt
against the current command's inputs. This reduces parsing work; it does not
eliminate whole-vault discovery or note I/O.

The memo is shared across vaults and short-lived transaction worktrees because
it stores only content-derived parsing, not file paths or resolved schema state.
Read failures still produce the original unreadable-note behavior, even if the
same content was cached earlier. Malformed parses and values that cannot round-trip
through JSON without loss are not stored. Node major version, parser dependencies
and the normalization-format revision separate incompatible results.

## Location and limits

The cache is outside the vault in the operating system's user-cache directory:

- Windows: `%LOCALAPPDATA%/Cache/bwrb/snapshot-parsing/`
- macOS: `~/Library/Caches/bwrb/snapshot-parsing/`
- Other systems: `~/.cache/bwrb/snapshot-parsing/`

An absolute `XDG_CACHE_HOME` overrides that base. Persistence is disabled if its
resolved location is inside the vault, including through directory symlinks.
Each Node-major memo is limited to 16,384 entries and 32 MiB, with a 64 KiB limit
on an individual normalized value. Only frontmatter is retained, not note bodies;
it can still contain private information. Newly created cache directories and
files request owner-only permissions (subject to the platform's filesystem ACLs).

Missing, corrupt, incompatible or unwritable caches fall back to fresh parsing.
Writes publish complete files by atomic rename; concurrent writers may discard
one another's memo hits without changing note results. No cache lock, worker,
watcher or recovery process is required. Abandoned temporary writes are removed
only after the grace period and when their PID is proven gone.

The cache is disposable: deleting its user-cache folder costs only a cold parse.
It is not an identity registry, validation exemption or source of truth. Changes
to parsing or normalization must bump its format revision.
