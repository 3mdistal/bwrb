---
title: JSON Mode
description: Scripting and automation with JSON input/output
---

Every Bowerbird command supports JSON mode for scripting and AI integration.

## JSON Output

Add `--output json` to any command:

```bash
bwrb list task --output json
bwrb audit --output json
bwrb search "My Note" --output json
```

## JSON Input

Provide field values without interactive prompts:

```bash
bwrb new task --json '{"name": "Fix login", "priority": "high"}'
bwrb edit "My Task" --json '{"status": "done"}'
bwrb bulk set --json '{"status": "archived"}' --type task
```

## Scripting Examples

### Create Note from Script

```bash
#!/bin/bash
bwrb new task --json "{
  \"name\": \"$TASK_NAME\",
  \"priority\": \"$PRIORITY\"
}"
```

### Process Audit Results

```bash
bwrb audit --output json | jq '.violations[] | .file'
```

Audit JSON is report-only. It never performs fixes or deletes. For delete-eligible findings, the issue payload can include recommendation metadata under `meta.recommendation` (for example `{"action":"delete-note","interactiveOnly":true}`).

### Batch Operations

```bash
bwrb list task --output json | \
  jq -r '.[] | select(.status == "done") | .path' | \
  xargs -I {} bwrb delete {} --execute
```

## AI Integration

JSON mode makes Bowerbird scriptable by AI assistants:

```bash
# AI can read vault state
bwrb list --output json

# AI can create notes
bwrb new idea --json '{"name": "AI suggestion", "status": "raw"}'
```

## See Also

- [Shell completion](/automation/shell-completion/)
- [AI integration](/automation/ai-integration/)
