---
title: Custom Calendars
description: Define fictional calendars for native date validation, sorting, and relative-date chains
---

Custom calendars let a vault store fictional or alternative dates without converting them to Gregorian dates. A calendar is declared once in `.bwrb/schema.json`, then date fields opt in by calendar id.

Calendar dates are stored as canonical strings in frontmatter, but Bowerbird parses them to a timezone-independent linear hour value for sorting, `--where` comparisons, JSON output, audit, and calendar-anchored relative-date chains.

## Schema

Declare calendars under `config.calendars`:

```json
{
  "config": {
    "calendars": {
      "tmi": {
        "label": "TMI lunar calendar",
        "hoursInDay": 336,
        "eras": [
          { "name": "Before Humans", "shortName": "BH", "backwards": true },
          { "name": "After Humans", "shortName": "AR" }
        ],
        "months": [
          { "name": "Month One", "shortName": "M1", "days": 2 },
          { "name": "Month Two", "shortName": "M2", "days": 2 }
        ]
      }
    }
  }
}
```

`hoursInDay` defaults to `24`. Each calendar needs at least one era and one month. Month indexes are one-based in date strings.

Era support is intentionally limited in v1: a calendar can declare one era, or one backwards era plus one forward era. Calendars cannot declare more than two eras, more than one `backwards: true` era, or two forward-only eras.

## Date Fields

Opt a date field into a calendar:

```json
{
  "types": {
    "event": {
      "calendar_default": "tmi",
      "fields": {
        "name": { "prompt": "text", "required": true },
        "when": { "prompt": "date" },
        "gregorian": { "prompt": "date", "calendar": "earth" }
      }
    }
  }
}
```

`calendar_default` applies to date fields on the type that do not declare their own `calendar`. A `calendar` key is valid only on `prompt: "date"` fields. Unknown calendar ids are schema errors.

## Date Format

The canonical format is:

```text
<eraShort> <year>-<month>-<day> [<hour>:<minute>]
```

Examples:

```yaml
when: "AR 3019-09-02 266:50"
origin: "BH 12-01-01"
```

Month and day are canonicalized to two digits. Hours may exceed `23` when the calendar's `hoursInDay` is larger than a Gregorian day, but must be less than `hoursInDay`. Minutes must be `0-59`.

## Querying

Text table output displays the canonical string. JSON output expands calendar date fields:

```json
{
  "when": {
    "value": "AR 3019-09-02 266:50",
    "calendar": "tmi",
    "linear": 24324338.833333332
  }
}
```

`linear` is the internal hour count used for sorting and comparisons. It is stable and timezone-independent.

```bash
bwrb list event --sort when --output json
bwrb list event --where "when > 'AR 1000-01-01'" --output json
```

Dates from different calendars are not converted. Cross-calendar sort ties fall back to name order with a warning; cross-calendar `--where` comparisons do not match.

## Relative Dates

Relative-date chains anchored on a calendar date resolve in that calendar's linear hours:

```yaml
position:
  kind: equal
  ref: "[[Anchor]]"
  field: when
  offset: 2d
```

For calendar chains, `d` means the calendar's `hoursInDay`. The `w` unit is rejected for calendar chains in v1; use hours or days instead. Gregorian chains keep the existing real-time meanings: `d = 24h`, `w = 168h`.

## Audit

`bwrb audit` validates calendar date strings against the configured calendar. It reports invalid eras, month ranges, day ranges, hours, and minutes as `invalid-date-format`.

## Limits

Custom calendars v1 do not support more than one backwards era and one forward era, leap cycles, weekday names, timezone concepts, or conversion between calendars.
