---
title: AI Integration
description: Using Bowerbird with AI assistants
---

Bowerbird is designed to work seamlessly with AI coding assistants.

## JSON Mode

Every command supports `--output json` and `--json` input, making Bowerbird fully scriptable by AI:

```bash
# AI reads vault state
bwrb list task --output json

# AI creates notes
bwrb new task --json '{"name": "Generated task", "status": "backlog"}'
```

## Agent Skill

For AI assistants that support skills (like OpenCode), Bowerbird provides a skill document at `docs/skill/SKILL.md` with:

- Command patterns for common operations
- JSON mode examples
- Best practices for note management

## Use Cases

### Inbox Processing

AI can triage notes:

```bash
# Read unprocessed items
bwrb list idea --where "status = 'raw'" --output json

# Update after review
bwrb edit "My Idea" --json '{"status": "developing"}'
```

### Daily-Note Sweep (Coverage)

The goal: ramble into daily notes every day and **know nothing got swept under
the rug**. The convention is a single boolean field on your daily-note type that
records whether a note has been reviewed/swept for extractable items (tasks,
ideas, people to link). bwrb itself ships no `daily-note` type — types are
defined per-vault — so you declare the field in your schema:

```json
{
  "types": {
    "daily-note": {
      "output_dir": "Daily Notes",
      "fields": {
        "reviewed": {
          "prompt": "boolean",
          "description": "Whether this note has been swept for tasks, ideas, and people to extract. Absent or false means not yet swept."
        }
      }
    }
  }
}
```

The workflow:

1. New daily notes start without `reviewed` (or with `reviewed: false`).
2. An agent (or you) sweeps a note, extracts what matters, then stamps
   `reviewed: true`.
3. At any time, list the notes that still need a sweep.

**The recipe — find unswept notes:**

```bash
bwrb list --type daily-note --where "reviewed != true"
```

Use `!= true`, **not** `== false`. A note that has never been touched has no
`reviewed` field at all, and `reviewed == false` only matches notes where the
field is *explicitly* `false` — it silently skips the never-reviewed notes, which
are exactly the ones most likely to have been swept under the rug. `reviewed !=
true` matches both the explicit `false` and the missing-field cases.

Save it as a dashboard so the un-swept queue is one command away:

```bash
# Save the query as a reusable dashboard...
bwrb list --type daily-note --where "reviewed != true" --save-as unswept-daily-notes

# ...then run it any time
bwrb dashboard unswept-daily-notes
```

Stamping a note as swept is a normal edit:

```bash
bwrb edit "Daily Notes/2026-06-20" --json '{"reviewed": true}'
```

> The risk in this loop is the agent forgetting to stamp `reviewed: true`. That is
> prompting discipline, not a bwrb feature — but the `reviewed != true` query is
> the deterministic backstop that makes a forgotten stamp visible instead of lost.

### Content Generation

AI can create structured notes:

```bash
bwrb new task --json '{
  "name": "Research topic X",
  "status": "backlog",
  "priority": "medium"
}'
```

### Batch Analysis

AI can analyze vault contents:

```bash
# Export for analysis
bwrb list --output json > vault-export.json
```

## Future: AI Commands

Post-v1.0, Bowerbird will include dedicated AI commands for:

- Ingest (process external content)
- Suggest (recommend connections)
- Summarize (generate overviews)

## See Also

- [JSON Mode](/automation/json-mode/)
- [Product Roadmap](/product/roadmap/)
