---
title: Note parsing cache
description: Disposable, stamp- and content-verified metadata reuse across Bowerbird runs
---

Bowerbird keeps a bounded cache of normalized note frontmatter between runs.
Snapshots still rediscover files every time. For each note, Bowerbird first
reads its file stamp: device, file ID, size, modification time and change time.
When the stamp matches the one recorded at the note's last read, the cached
parse is reused without reading the note. A stamp is recorded only for a note
that had not changed for five seconds before that read, so a later write always
carries a newer timestamp, and any write changes the change time, even one that
puts the modification time back. Otherwise Bowerbird reads the note's current
bytes and reuses a cached parse only when they have the same SHA-256
fingerprint. Git HEAD and a previous file inventory are never freshness proofs.
Schema interpretation, aliases, ownership, dates and derived indexes are rebuilt
against the current command's inputs. This removes most note reads on a vault
that is not changing; it does not eliminate whole-vault discovery.

Parsed entries are keyed by content, so they are shared across vaults and
short-lived transaction worktrees. Stamps are keyed by a note's absolute path, so
each checkout keeps its own. A note whose stat or read fails still produces the
original unreadable-note behavior. Malformed parses and values that cannot
round-trip through JSON without loss are not stored. Node major version, parser
dependencies and the normalization-format revision separate incompatible results.

## Location and limits

The cache is outside the vault in the operating system's user-cache directory:

- Windows: `%LOCALAPPDATA%/Cache/bwrb/snapshot-parsing/`
- macOS: `~/Library/Caches/bwrb/snapshot-parsing/`
- Other systems: `~/.cache/bwrb/snapshot-parsing/`

An absolute `XDG_CACHE_HOME` overrides that base. Persistence is disabled if its
resolved location is inside the vault, including through directory symlinks.
Each Node-major memo is limited to 16,384 entries and 32 MiB, with a 64 KiB limit
on an individual normalized value, and to 32,768 file stamps, which fill the
32 MiB file after the entries. Only frontmatter and note paths are retained, not
note bodies; they can still contain private information. Newly created cache directories and
files request owner-only permissions (subject to the platform's filesystem ACLs).

Missing, corrupt, incompatible or unwritable caches fall back to fresh parsing.
Writes publish complete files by atomic rename; concurrent writers may discard
one another's memo hits without changing note results. No cache lock, worker,
watcher or recovery process is required. Abandoned temporary writes are removed
only after the grace period and when their PID is proven gone.

The cache is disposable: deleting its user-cache folder costs only a cold parse.
It is not an identity registry, validation exemption or source of truth. Changes
to parsing or normalization must bump its format revision.
