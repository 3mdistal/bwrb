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
