---
title: bwrb explain
description: Explain whether a relation-backed transition is currently allowed
---

`explain` evaluates a note's configured transition guards without writing.

## Synopsis

```bash
bwrb explain <query> --transition <field=value|value> [--output text|json]
```

The query must resolve exactly by path, name, alias, or ID-compatible exact
targeting. The full `field = value` form is always deterministic. A value-only
shorthand such as `accepted` works only when exactly one configured guard enters
that value.

```bash
bwrb explain "Candidate 417" --transition "status = accepted"
bwrb explain "Candidate 417" --transition accepted --output json
```

Text output begins with `Allowed` or `Blocked` and reports every relation
requirement as missing, unresolved, stale, failed, or satisfied. JSON returns
the same complete explanation DTO used by guarded edit failures.

A valid blocked explanation exits `0`: blocked is workflow state, not a command
failure. Invalid targeting, ambiguous shorthand, malformed transition syntax,
or invalid schema configuration exits nonzero.
