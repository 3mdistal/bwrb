---
title: Relative Dates
description: Model story-time and sequence positions without writing computed dates back to notes
---

Relative-date fields describe where a note sits in time relative to another note. They are useful for fictional timelines, historical sequences, research events, or any vault where the order matters before every absolute date is known.

The stored frontmatter is only the source constraint. Bowerbird resolves the computed position at query time and never writes the resolved value back to the note.

## Schema

Declare a `relative-date` field alongside a normal `date` field that can anchor the chain:

```json
{
  "types": {
    "event": {
      "output_dir": "Events",
      "fields": {
        "name": { "prompt": "text", "required": true },
        "start": { "prompt": "date" },
        "position": { "prompt": "relative-date", "source": "event" }
      }
    }
  }
}
```

`source` works like relation fields: it constrains which note types can be used as anchors.

## Frontmatter

A relative-date value is an object or a list of objects:

```yaml
position:
  - kind: equal
    ref: "[[The Rending]]"
    field: start
    offset: 34h
```

| Key | Description |
| --- | --- |
| `kind` | `equal`, `after`, or `before` |
| `ref` | Anchor note reference, usually a wikilink |
| `field` | Optional anchor field. If omitted, Bowerbird uses the anchor's date field, then its relative-date field |
| `offset` | Optional signed duration using `min`, `h`, `d`, or `w` |

Offsets are parsed internally as `{ amount, unit, mode }` so future calendar-aware resolvers can preserve the unit instead of inheriting a millisecond-only value.

For fictional or alternative timekeeping, define a [custom calendar](/concepts/custom-calendars/) and anchor relative-date chains on calendar date fields.

## Resolution

A relative-date field resolves to:

- the note's own `date` field, when the note has one and no relative constraint is set
- the transitive result of its first `equal` constraint plus the offset
- `null` when it only has `after`/`before` bounds or the chain has no absolute anchor

Plain `YYYY-MM-DD` dates are interpreted at local midnight in the machine's timezone before being converted to UTC.

Calendar anchors resolve in their calendar's linear hours instead. On those chains, `d` uses the calendar's configured `hoursInDay`, and `w` is rejected in v1.

Multiple `equal` constraints are allowed, but only the first one provides the resolved value. If later equal constraints resolve to a different position, Bowerbird reports a contradiction.

Cycles do not crash commands. The involved notes resolve to `null` and are marked with `resolution: "cycle"` in JSON output.

## Querying

`bwrb list --output json` expands the field:

```json
{
  "position": {
    "source": [{ "kind": "equal", "ref": "[[A]]", "offset": "34h" }],
    "resolved": "2026-01-02T15:00:00.000Z",
    "resolution": "ok"
  }
}
```

`--sort position` sorts by the resolved value, with unresolved values last.

`--where` comparisons use the resolved value:

```bash
bwrb list event --where "position < date('2026-01-03T00:00:00Z')"
```

## Audit

`bwrb audit` reports relative-date cycles, contradictions, invalid anchor references, and bound violations as warnings. Unanchored chains are normal and appear as `resolution: "unanchored"` in JSON list output instead of audit noise.
