# Custom Calendars (PR 2 of the story-time pair)

Prereq: relative-dates (PR 1, merged). Vault brief: teenylilthoughts `briefs/bwrb relative dates and custom calendars.md`.

## What

Schema-defined calendars for fictional/alternative timekeeping. A calendar is declared once in vault config; `date` fields opt in by id. Calendar dates parse, format, validate, and sort natively (via a linear timestamp), so `list --sort`, `--where` comparisons, and relative-date chains work on non-Gregorian time.

## Config shape (`.bwrb/schema.json` → `config.calendars`)

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

- `hoursInDay` (default 24), `eras` (≥1; `backwards: true` counts years down toward the era boundary), `months` (≥1, each with `days`).
- No leap-cycle support in v1 (documented limitation).

## Field opt-in

```json
"in-world-when": { "prompt": "date", "calendar": "tmi" }
```

- `calendar` key valid only on `prompt: "date"` fields; unknown calendar id = schema validation error.
- Optional type-level `calendar_default` applying to all date fields of the type without their own `calendar`.

## Date string format (canonical, round-trippable)

`<eraShort> <year>-<month>-<day>` with optional ` <hour>:<minute>` — e.g. `AR 3019-09-02 266:50`.
- month/day are 1-based indexes into the calendar; hour may exceed 23 when `hoursInDay` > 24.
- Parse errors must state the failing component and the calendar's valid ranges.
- Formatting for display (`list` table) uses the same canonical string; `--output json` adds `{ calendar: "tmi", linear: <number> }` where `linear` is the internal linear timestamp (hours since era-zero; stable, documented, sortable).

## Semantics

- Sorting/`--where` comparisons on calendar date fields compare linear timestamps. Comparing dates across *different* calendars is a diagnostic (warning; treated as null ordering), not a crash.
- Relative-date (PR 1) chains: an anchor whose resolved field is a calendar date resolves in that calendar's linear hours; linear offset units (min/h/d/w) apply with `d`/`w` meaning **real 24h/168h only when the chain is Gregorian**. For calendar chains, `d` = the calendar's `hoursInDay` and `w` is rejected with a clear error (v1; a future PR may add calendar-scoped units). The `{amount, unit, mode}` AST gains `mode: "calendar"` resolution at this boundary — the parser is untouched.
- `audit` validates calendar date strings against the calendar definition (month index in range, day within month's `days`, hour < `hoursInDay`).

## Non-goals (v1)

- Leap cycles, week structures, named weekdays, timezone concepts.
- Converting dates between calendars.
- Calendar-scoped offset unit *names* ("2 cycles") — the groundwork (`mode` on the AST) lands, the surface syntax does not.

## Acceptance (fresh agent, CLI only)

1. Define the TMI calendar in config + an `event` type with `when: { prompt: date, calendar: tmi }` via schema edit + migrate.
2. Create events with `AR 960-06-01`, `AR 3019-09-02 266:50`, `BH 12-01-01`; `list --sort when` orders BH before AR, and within AR by linear time; JSON shows canonical string + linear.
3. Feed an invalid date (`AR 3019-14-01`, month out of range) — creation fails with an error naming the month range; `audit` catches the same if hand-edited in.
4. Mix a relative-date constraint chain anchored on a calendar date: `equal [[X]] + 340h` resolves correctly in linear hours; `+2d` means 2×336h; `+1w` errors clearly.
5. Full CI parity passes; docs-site page for calendars + SKILL.md updated; relative-dates docs cross-link.
