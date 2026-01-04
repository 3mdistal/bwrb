# AI Ingest Command

> AI-powered extraction of tasks, ideas, and entities from unstructured notes

---

## Overview

The `bwrb ingest` command uses AI to scan notes (especially daily notes, journals, meeting notes) and extract structured data:

- **Tasks** — Action items, TODOs, things to do
- **Ideas** — Creative thoughts, concepts, possibilities
- **Entities** — People, places, media, software mentioned
- **Links** — Connections to existing vault notes

This bridges the gap between free-form journaling and structured knowledge management. Write naturally, then let AI help organize.

```
┌─────────────────────────────────────────────────────────────┐
│                     Daily Note                               │
│  "Listening to the Luca soundtrack... need to look into     │
│   Keda... really loved the entity linking feature..."       │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                   bwrb ingest                              │
│  • Sends note + schema context to AI                        │
│  • Receives structured extraction proposals                 │
│  • Presents interactive approval flow                       │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                     Proposals                                │
│  Task: "Look into Keda"                     [accept/reject] │
│  Entity: "Luca" → [[Entities/Media/Luca]]   [accept/reject] │
│  Idea: "Entity linking for daily notes"     [accept/reject] │
└─────────────────────────────────────────────────────────────┘
```

---

## Command Syntax

```bash
# Ingest a specific file
bwrb ingest "Daily Notes/2025-12-30.md"

# Ingest multiple files
bwrb ingest "Daily Notes/2025-12-*.md"

# Ingest all notes of a type
bwrb ingest --type daily-note

# Ingest notes marked for processing
bwrb ingest --pending

# Dry run (show what would be extracted, don't prompt)
bwrb ingest "Daily Notes/2025-12-30.md" --dry-run

# Auto-accept high-confidence extractions
bwrb ingest "Daily Notes/2025-12-30.md" --auto

# JSON output for scripting
bwrb ingest "Daily Notes/2025-12-30.md" --output json

# Limit extraction types
bwrb ingest --extract tasks,ideas  # Skip entities
bwrb ingest --extract entities     # Only entities
```

---

## Extraction Types

### 1. Tasks

Identifies action items, TODOs, and things to do.

**Markers detected:**
- Explicit: `[TODO]:`, `TODO:`, `- [ ]`, `TASK:`
- Implicit: "need to", "should", "have to", "want to", "going to"

**Output:**
```yaml
type: task
title: "Look into Keda"
source: "[[Daily Notes/2025-12-30]]"
source-context: "...need to look into Keda for container scaling..."
confidence: 0.85
```

### 2. Ideas

Identifies creative thoughts, concepts, and possibilities.

**Markers detected:**
- Explicit: `[IDEA]:`, `IDEA:`, `💡`
- Implicit: "what if", "could be", "interesting", "I wonder"

**Output:**
```yaml
type: idea
title: "Entity linking for daily note processing"
source: "[[Daily Notes/2025-12-30]]"
source-context: "...entity linking is really nice for building the graph..."
confidence: 0.72
```

### 3. Entities

Identifies people, places, media, software, and other named things.

**Entity types:**
- People (names, roles)
- Places (locations, venues)
- Media (movies, music, books)
- Software (tools, apps, services)
- Custom types from schema

**Output:**
```yaml
entity-type: media
name: "Luca"
existing-match: "[[Entities/Media/Luca]]"  # If found
confidence: 0.92
context: "Listening to the Luca soundtrack..."
```

### 4. Links

Identifies references to concepts that might match existing notes.

**Output:**
```yaml
target: "[[Entities/People/Steve Yegge]]"
context: "...as Steve mentioned in his talk..."
link-type: mention  # mention, reference, quote
confidence: 0.88
```

---

## Processing State

### Frontmatter Fields

Notes can track their AI processing state:

```yaml
---
type: daily-note
ai-process-stage: to-process  # to-process | processing | processed | needs-review
ai-last-processed: 2025-12-30T11:18:00Z
ai-schema-version: 5
ai-extractions:
  - type: task
    created: "[[Objectives/Tasks/Look into Keda]]"
  - type: entity
    linked: "[[Entities/Media/Luca]]"
---
```

### Processing Stages

| Stage | Meaning |
|-------|---------|
| `to-process` | Note has not been ingested yet |
| `processing` | Currently being processed |
| `processed` | Ingestion complete, all proposals handled |
| `needs-review` | Schema changed since last processing |

### Schema Version Tracking

When the schema changes (new type added, fields modified), notes processed under an older schema version are marked `needs-review`:

```bash
bwrb schema add-type place
# Notes with ai-schema-version < current marked for re-processing

bwrb ingest --pending
# Finds notes with ai-process-stage: to-process OR needs-review
```

---

## Interactive Approval Flow

```bash
bwrb ingest "Daily Notes/2025-12-30.md"

# Scanning Daily Notes/2025-12-30.md...
# 
# Found 4 potential extractions:
# 
# ─────────────────────────────────────────────────────
# 1/4  TASK (confidence: 85%)
# ─────────────────────────────────────────────────────
# 
#   "Look into Keda"
#   
#   Context: "...need to look into Keda for container scaling..."
#   
#   Will create:
#     Type: objective/task
#     Title: Look into Keda
#     Status: inbox
#     Source: [[Daily Notes/2025-12-30]]
#   
#   [a]ccept  [e]dit  [r]eject  [s]kip  [q]uit
# > a
# 
#   ✓ Created: Objectives/Tasks/Look into Keda.md
# 
# ─────────────────────────────────────────────────────
# 2/4  ENTITY (confidence: 92%)
# ─────────────────────────────────────────────────────
# 
#   "Luca" (media)
#   
#   Context: "Listening to the Luca soundtrack..."
#   
#   Found existing: [[Entities/Media/Luca]]
#   
#   Action: Add backlink to source note
#   
#   [a]ccept  [e]dit  [r]eject  [s]kip  [q]uit
# > a
# 
#   ✓ Linked: [[Entities/Media/Luca]]
# 
# ─────────────────────────────────────────────────────
# 3/4  ENTITY (confidence: 67%)
# ─────────────────────────────────────────────────────
# 
#   "Keda" (software)
#   
#   Context: "...need to look into Keda for container scaling..."
#   
#   No existing match found.
#   
#   Options:
#     1. Create new: Entities/Software/Keda.md
#     2. Link to existing note (search)
#     3. Skip (not an entity)
#   
#   [1-3] or [s]kip  [q]uit
# > 1
# 
#   ✓ Created: Entities/Software/Keda.md
# 
# ─────────────────────────────────────────────────────
# 4/4  IDEA (confidence: 72%)
# ─────────────────────────────────────────────────────
# 
#   "Entity linking for daily note processing"
#   
#   Context: "...entity linking is really nice for building the graph..."
#   
#   Will create:
#     Type: idea
#     Title: Entity linking for daily note processing
#     Status: raw
#     Source: [[Daily Notes/2025-12-30]]
#   
#   [a]ccept  [e]dit  [r]eject  [s]kip  [q]uit
# > e
# 
#   Edit title: AI-powered entity extraction from daily notes
#   
#   ✓ Created: Ideas/AI-powered entity extraction from daily notes.md
# 
# ─────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────
# 
#   Accepted: 4
#   Rejected: 0
#   Skipped: 0
#   
#   Notes updated:
#     Daily Notes/2025-12-30.md
#       ai-process-stage: processed
#       ai-last-processed: 2025-12-30T14:30:00Z
#   
#   Created:
#     Objectives/Tasks/Look into Keda.md
#     Entities/Software/Keda.md
#     Ideas/AI-powered entity extraction from daily notes.md
#   
#   Linked:
#     [[Entities/Media/Luca]] ← Daily Notes/2025-12-30.md
```

---

## Auto Mode

For high-confidence extractions, `--auto` accepts automatically:

```bash
bwrb ingest "Daily Notes/2025-12-30.md" --auto

# Scanning Daily Notes/2025-12-30.md...
# 
# Auto-processing extractions (threshold: 80%)...
# 
#   ✓ TASK "Look into Keda" (85%) → Created
#   ✓ ENTITY "Luca" (92%) → Linked to existing
#   ? ENTITY "Keda" (67%) → Below threshold, skipped
#   ? IDEA "Entity linking..." (72%) → Below threshold, skipped
# 
# Auto-processed: 2
# Skipped (low confidence): 2
# 
# Run without --auto to review skipped items.
```

### Confidence Thresholds

```bash
bwrb ingest --auto --threshold 0.7  # Lower threshold
bwrb ingest --auto --threshold 0.9  # Higher threshold
```

Or configure in schema:

```json
{
  "ingest": {
    "auto_threshold": 0.8,
    "entity_match_threshold": 0.7
  }
}
```

---

## Entity Matching

When AI extracts an entity, bwrb searches for existing matches:

### Match Strategies

1. **Exact name match** — File basename matches entity name
2. **Alias match** — Entity name in `aliases` frontmatter
3. **Fuzzy match** — Levenshtein distance < threshold
4. **Full-text search** — Entity name appears in note content

### Match Presentation

```
Found potential matches for "Steve Yegge":

  1. [[Entities/People/Steve Yegge]] (exact)
  2. [[Entities/People/stevey]] (alias)
  3. [[Learning/Inspos/Yegge on Compilers]] (mentions)

Select match or [n]ew entity:
```

---

## JSON Output

For scripting and integration:

```bash
bwrb ingest "Daily Notes/2025-12-30.md" --output json --dry-run
```

```json
{
  "source": "Daily Notes/2025-12-30.md",
  "extractions": [
    {
      "type": "task",
      "title": "Look into Keda",
      "confidence": 0.85,
      "context": "...need to look into Keda for container scaling...",
      "proposed_fields": {
        "type": "task",
        "status": "inbox",
        "source": "[[Daily Notes/2025-12-30]]"
      }
    },
    {
      "type": "entity",
      "entity_type": "media",
      "name": "Luca",
      "confidence": 0.92,
      "context": "Listening to the Luca soundtrack...",
      "existing_match": "Entities/Media/Luca.md"
    }
  ],
  "stats": {
    "tasks": 1,
    "ideas": 1,
    "entities": 2,
    "total": 4
  }
}
```

---

## AI Integration

### Provider Support

Uses the same API infrastructure as agentic workflows (Phase 6):

```bash
# Use OpenRouter (default)
bwrb ingest "note.md"

# Use opencode run (leverages existing subscription)
bwrb ingest "note.md" --provider opencode

# Direct Anthropic API
bwrb ingest "note.md" --provider anthropic
```

### Model Selection

```bash
bwrb ingest "note.md" --model claude-3-5-haiku  # Fast, cheap
bwrb ingest "note.md" --model claude-sonnet-4   # Better quality
```

Or configure default:

```json
{
  "ingest": {
    "model": "claude-3-5-haiku-20241022",
    "provider": "openrouter"
  }
}
```

### Prompt Structure

The AI receives:

1. **Schema context** — Available types, fields, enums
2. **Existing entities** — List of known entities for matching
3. **Note content** — The full note being processed
4. **Extraction instructions** — What to look for, output format

```typescript
interface IngestPrompt {
  schema: {
    types: string[];
    entityTypes: string[];
    fields: Record<string, FieldDef>;
  };
  existingEntities: {
    type: string;
    name: string;
    aliases: string[];
  }[];
  noteContent: string;
  extractTypes: ('tasks' | 'ideas' | 'entities' | 'links')[];
}
```

### Response Schema

AI returns structured JSON (with Zod validation):

```typescript
interface IngestResponse {
  extractions: Extraction[];
}

interface Extraction {
  type: 'task' | 'idea' | 'entity' | 'link';
  confidence: number;
  context: string;
  lineNumber?: number;
  
  // For tasks/ideas
  title?: string;
  proposedFields?: Record<string, unknown>;
  
  // For entities
  entityType?: string;
  name?: string;
  existingMatch?: string;
  
  // For links
  target?: string;
  linkType?: 'mention' | 'reference' | 'quote';
}
```

### Self-Healing JSON

If AI returns malformed JSON:

1. Attempt to parse and extract valid portions
2. Re-prompt with error context (up to 2 retries)
3. Fall back to partial results with warning

---

## Cost Tracking

Ingest operations log to the same cost tracking system as workflows:

```bash
bwrb costs --command ingest

# Ingest Costs (last 7 days):
#   
#   Total: $0.42
#   Files processed: 28
#   Extractions: 67
#   
#   By model:
#     claude-3-5-haiku: $0.12 (23 files)
#     claude-sonnet-4: $0.30 (5 files)
```

---

## Batch Processing

### Daily Workflow

```bash
# Process yesterday's daily note each morning
bwrb ingest "Daily Notes/$(date -d yesterday +%Y-%m-%d).md"
```

### Catch-Up Processing

```bash
# Process all unprocessed daily notes
bwrb ingest --type daily-note --pending

# Process last 7 days
bwrb ingest "Daily Notes/2025-12-2*.md" --auto
```

### Cron Integration

```bash
# In crontab: process daily note at 9am
0 9 * * * cd ~/vault && bwrb ingest --type daily-note --pending --auto
```

---

## Schema Configuration

### Ingest Settings

```json
{
  "ingest": {
    "model": "claude-3-5-haiku-20241022",
    "provider": "openrouter",
    "auto_threshold": 0.8,
    "entity_match_threshold": 0.7,
    "default_extractions": ["tasks", "ideas", "entities"],
    "task_markers": ["TODO", "TASK", "ACTION"],
    "idea_markers": ["IDEA", "THOUGHT", "CONCEPT"],
    "source_field": "source",
    "track_processing_state": true
  }
}
```

### Type-Specific Extraction

```json
{
  "types": {
    "daily-note": {
      "ingest": {
        "enabled": true,
        "extract": ["tasks", "ideas", "entities"],
        "auto_process": false
      }
    },
    "meeting-note": {
      "ingest": {
        "enabled": true,
        "extract": ["tasks", "entities"],
        "auto_process": true,
        "threshold": 0.9
      }
    }
  }
}
```

---

## Integration with Other Commands

### With Audit

```bash
bwrb audit --fix
# After fixing issues, suggests:
# "3 notes have ai-process-stage: to-process. Run 'bwrb ingest --pending'?"
```

### With Schema Changes

```bash
bwrb schema add-type place
# "12 processed notes may contain place entities. Mark for re-processing? [Y/n]"

bwrb ingest --pending --extract entities
# Re-processes only entity extraction on marked notes
```

### With Bulk

```bash
# Mark all daily notes for processing
bwrb bulk daily-note --set ai-process-stage=to-process
```

---

## CLI Reference

```bash
bwrb ingest <files...>              # Process specific files
bwrb ingest --type <type>           # Process all of a type
bwrb ingest --pending               # Process to-process/needs-review notes

# Options
--dry-run                             # Show extractions without prompting
--auto                                # Auto-accept above threshold
--threshold <n>                       # Confidence threshold (0.0-1.0)
--extract <types>                     # Limit extraction types
--model <model>                       # AI model to use
--provider <provider>                 # AI provider
--output json                         # JSON output
--verbose                             # Show AI prompts/responses
```

---

## Error Handling

### API Errors

```
bwrb ingest "note.md"

# ✗ API error: Rate limit exceeded
#   Retry in 60 seconds? [Y/n]
```

### Partial Processing

If processing fails mid-file:

```yaml
ai-process-stage: processing
ai-process-error: "API timeout at extraction 3/5"
ai-partial-extractions:
  - type: task
    title: "Look into Keda"
    status: pending-review
```

```bash
bwrb ingest "note.md"
# "Previous processing incomplete. Resume from extraction 3? [Y/n]"
```

---

## Privacy & Security

### Local Processing Option

For sensitive vaults, support local models:

```bash
bwrb ingest "note.md" --provider ollama --model llama3
```

### Content Filtering

```json
{
  "ingest": {
    "exclude_patterns": ["**/Private/**", "**/Health/**"],
    "redact_fields": ["phone", "ssn", "password"]
  }
}
```

---

## Success Criteria

1. **Accurate** — High precision extractions (>80% useful)
2. **Fast** — Process a daily note in <5 seconds
3. **Safe** — Always user approval (unless --auto)
4. **Cheap** — Haiku-level costs (~$0.01-0.02 per note)
5. **Resumable** — Handle failures gracefully
6. **Trackable** — Know what's been processed
7. **Integrated** — Works with audit, bulk, schema commands
