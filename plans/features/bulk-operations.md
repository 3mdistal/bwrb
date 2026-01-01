# Bulk Operations

> Mass changes across filtered file sets

---

## Overview

The `pika bulk` command performs mass changes across notes matching filter criteria:

- Set or clear field values
- Rename fields (for migrations)
- Move files to different directories
- Append/remove from list fields
- Update wikilinks when files move

---

## Command Syntax

```bash
pika bulk <type> [options]

# Operations
--set <field>=<value>       # Set field value
--set <field>=              # Clear field (remove)
--rename <old>=<new>        # Rename field
--delete <field>            # Delete field
--move <path>               # Move files to path
--append <field>=<value>    # Append to list field
--remove <field>=<value>    # Remove from list field

# Filters
--where "<expression>"      # Filter expression (can repeat)

# Execution
--execute                   # Actually apply changes (dry-run by default)
--backup                    # Create backup before changes
--limit <n>                 # Limit to n files

# Output
--verbose                   # Show detailed changes
--quiet                     # Only show summary
```

---

## Dry-Run by Default

All bulk operations are dry-run by default for safety:

```bash
pika bulk task --set status=done --where "status == 'in-progress'"

# Dry run - no changes will be made
# 
# Would affect 12 files:
#   Objectives/Tasks/Task A.md
#     status: in-progress → done
#   Objectives/Tasks/Task B.md
#     status: in-progress → done
#   ... (10 more)
# 
# Run with --execute to apply changes.
```

---

## Operations

### Set Field Value

```bash
# Set single field
pika bulk task --set status=done --where "status == 'in-progress'" --execute

# Set multiple fields
pika bulk task --set status=done --set "completion-date=$(date +%Y-%m-%d)" --where "status == 'in-progress'" --execute

# Set with special values
pika bulk task --set deadline=today --where "isEmpty(deadline)" --execute
pika bulk task --set "milestone=[[Q1 Release]]" --where "type == 'task'" --execute
```

### Clear Field

```bash
# Remove field entirely
pika bulk task --set deadline= --where "status == 'done'" --execute
```

### Rename Field

```bash
# For schema migrations
pika bulk objective --rename old-field=new-field --execute

# All affected files:
#   Objectives/Tasks/Task A.md
#     old-field: value → new-field: value
```

### Delete Field

```bash
# Explicit deletion (same as --set field=)
pika bulk task --delete legacy-field --execute
```

### Move Files

```bash
# Move to different directory
pika bulk idea --move Archive/Ideas --where "status == 'settled'" --execute

# Output:
#   Moving 15 files...
#   Updating 23 wikilinks across 8 files...
#   ✓ Done
```

### Append to List

```bash
# Add tag to all matching files
pika bulk task --append tags=urgent --where "priority == 'critical'" --execute

# Before: tags: [bug]
# After:  tags: [bug, urgent]
```

### Remove from List

```bash
# Remove tag from files
pika bulk task --remove tags=legacy --where "contains(tags, 'legacy')" --execute
```

---

## Filter Expressions

Filters use the same expression syntax as `pika list`:

```bash
# Simple equality
pika bulk task --set status=done --where "status == 'in-progress'"

# Comparison operators
pika bulk task --set priority=high --where "priority < 2"

# Boolean logic
pika bulk task --set status=backlog --where "status == 'inbox' && isEmpty(deadline)"

# Functions
pika bulk task --set status=overdue --where "deadline < today()"
pika bulk idea --move Archive/Ideas --where "contains(tags, 'archived')"

# Multiple --where (AND logic)
pika bulk task --set status=done --where "status == 'in-progress'" --where "scope == 'day'"
```

---

## Target Types

### Specific Type

```bash
pika bulk objective/task --set status=done ...
```

### Parent Type (All Subtypes)

```bash
pika bulk objective --set status=done ...
# Affects both tasks and milestones
```

### All Types

```bash
pika bulk --all --set status=done --where "status == 'in-progress'" ...
# Warning: This affects ALL managed files. Are you sure? [y/N]
```

---

## Safety Features

### 1. Dry-Run by Default

```bash
pika bulk task --set status=done --where "status == 'in-progress'"
# Shows what would change, doesn't change anything
```

### 2. Backup Option

```bash
pika bulk task --set status=done --where "status == 'in-progress'" --execute --backup

# Creating backup...
#   Backup saved to .pika/backups/2025-01-15T10-30-00/
# 
# Applying changes...
#   ✓ Updated 12 files
```

Restore from backup:
```bash
pika backup restore 2025-01-15T10-30-00
# Restoring 12 files from backup...
# ✓ Restored
```

### 3. Git Status Warning

```bash
pika bulk task --set status=done --where "status == 'in-progress'" --execute

# ⚠ Warning: You have uncommitted changes in your vault.
# Bulk operations will modify files. Consider committing first.
# 
# Uncommitted changes:
#   M Objectives/Tasks/Task A.md
#   M Ideas/New Idea.md
# 
# Continue anyway? [y/N]
```

### 4. Limit Flag

```bash
# Apply to first 5 matches only
pika bulk task --set status=done --where "status == 'in-progress'" --execute --limit 5

# Updated 5 of 12 matching files.
# Run without --limit to update remaining 7 files.
```

### 5. Confirmation for Large Operations

```bash
pika bulk task --set status=archived --execute

# This will modify 247 files.
# Are you sure? [y/N]
```

---

## Wikilink Auto-Update

When `--move` relocates files, wikilinks are automatically updated:

```bash
pika bulk idea --move Archive/Ideas --where "status == 'settled'" --execute

# Moving 5 files...
#   Ideas/Old Idea 1.md → Archive/Ideas/Old Idea 1.md
#   Ideas/Old Idea 2.md → Archive/Ideas/Old Idea 2.md
#   ...
# 
# Updating wikilinks...
#   Scanning 147 files for references...
#   Found 12 wikilinks to update across 8 files:
#     Tasks/Task A.md: [[Old Idea 1]] → [[Archive/Ideas/Old Idea 1]]
#     Tasks/Task B.md: [[Old Idea 2]] (2 occurrences)
#     ...
# 
# ✓ Moved 5 files
# ✓ Updated 12 wikilinks
```

### Wikilink Patterns Handled

| Pattern | Updated To |
|---------|------------|
| `[[Filename]]` | `[[New/Path/Filename]]` (if needed for disambiguation) |
| `[[Filename\|Alias]]` | `[[New/Path/Filename\|Alias]]` |
| `[[Filename#Heading]]` | `[[New/Path/Filename#Heading]]` |
| `[[Filename#Heading\|Alias]]` | `[[New/Path/Filename#Heading\|Alias]]` |

### Shortest Path Preference

If using Obsidian's "shortest path when possible" setting:
- Links stay as just `[[Filename]]` if still unique
- Only add path if needed for disambiguation

---

## Output Formats

### Default (Interactive)

```bash
pika bulk task --set status=done --where "status == 'in-progress'" --execute

# Applying changes to 12 files...
#   ✓ Objectives/Tasks/Task A.md
#   ✓ Objectives/Tasks/Task B.md
#   ... (10 more)
# 
# ✓ Updated 12 files
```

### Verbose

```bash
pika bulk task --set status=done --where "status == 'in-progress'" --execute --verbose

# Applying changes...
# 
# Objectives/Tasks/Task A.md
#   status: in-progress → done
# 
# Objectives/Tasks/Task B.md
#   status: in-progress → done
# 
# ... (detailed for each file)
# 
# ✓ Updated 12 files
```

### Quiet

```bash
pika bulk task --set status=done --where "status == 'in-progress'" --execute --quiet

# ✓ Updated 12 files
```

### JSON (for scripting)

```bash
pika bulk task --set status=done --where "status == 'in-progress'" --execute --format json

# {
#   "success": true,
#   "filesModified": 12,
#   "changes": [
#     { "file": "Objectives/Tasks/Task A.md", "field": "status", "from": "in-progress", "to": "done" },
#     ...
#   ]
# }
```

---

## Instance-Grouped Operations

### Operating on Parent Type

```bash
pika bulk draft --set status=archived --where "status == 'done'" --execute
# Only affects parent notes (Drafts/X/X.md)
```

### Operating on Subtypes

```bash
pika bulk draft/version --set canonical=false --execute
# Affects all version files across all drafts
```

### Moving Entire Instances

```bash
pika bulk draft --move Archive/Drafts --where "status == 'archived'" --execute

# This will move entire draft instances (parent + subtypes):
#   Drafts/Old Project/ → Archive/Drafts/Old Project/
#     - Old Project.md
#     - Draft v1.md
#     - Research.md
# 
# Continue? [Y/n]
```

---

## Use Cases

### Migration: Rename Enum Values

```bash
# 1. Check current usage
pika list task --where "status == 'wip'" --count
# 47 files

# 2. Bulk update
pika bulk task --set status=in-progress --where "status == 'wip'" --execute --backup

# 3. Update schema
pika schema edit-enum status --remove wip
```

### Cleanup: Archive Old Items

```bash
# Archive settled ideas
pika bulk idea --move Archive/Ideas --where "status == 'settled'" --execute

# Archive completed tasks older than 30 days
pika bulk task --move Archive/Tasks --where "status == 'done' && completion-date < today() - '30d'" --execute
```

### Tagging: Add Tags Based on Criteria

```bash
# Tag all high-priority items
pika bulk task --append tags=priority --where "priority == 'high' || priority == 'critical'" --execute

# Tag overdue items
pika bulk task --append tags=overdue --where "deadline < today() && status != 'done'" --execute
```

### Field Migration: Rename or Remove

```bash
# Rename field across all types
pika bulk --all --rename assignee=owner --execute

# Remove deprecated field
pika bulk --all --delete legacy-notes --execute
```

---

## Implementation Notes

### Frontmatter Preservation

When modifying files, preserve:
- Field order (as much as possible)
- Comments (if any)
- Body content
- Trailing newlines

```typescript
async function updateFrontmatter(
  filePath: string,
  changes: Record<string, any>
): Promise<void> {
  const content = await fs.readFile(filePath, 'utf-8');
  const { data: frontmatter, content: body } = matter(content);
  
  // Apply changes
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) {
      delete frontmatter[key];
    } else {
      frontmatter[key] = value;
    }
  }
  
  // Reconstruct file
  const newContent = matter.stringify(body, frontmatter);
  await fs.writeFile(filePath, newContent);
}
```

### Wikilink Scanning

```typescript
const WIKILINK_PATTERN = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;

async function findWikilinks(
  vaultPath: string,
  targetFilename: string
): Promise<WikilinkReference[]> {
  const references: WikilinkReference[] = [];
  const files = await glob(path.join(vaultPath, '**/*.md'));
  
  for (const file of files) {
    const content = await fs.readFile(file, 'utf-8');
    let match;
    while ((match = WIKILINK_PATTERN.exec(content)) !== null) {
      const linkTarget = match[1];
      if (path.basename(linkTarget) === targetFilename || linkTarget === targetFilename) {
        references.push({
          sourceFile: file,
          match: match[0],
          linkTarget,
          position: match.index,
        });
      }
    }
  }
  
  return references;
}
```

### Backup Structure

```
.pika/
  backups/
    2025-01-15T10-30-00/
      manifest.json           # What was backed up and why
      files/
        Objectives/
          Tasks/
            Task A.md         # Original file content
            Task B.md
```

Manifest:
```json
{
  "timestamp": "2025-01-15T10:30:00Z",
  "operation": "bulk set status=done",
  "files": [
    "Objectives/Tasks/Task A.md",
    "Objectives/Tasks/Task B.md"
  ]
}
```

---

## Success Criteria

1. **Safe by default** — Dry-run, backups, warnings
2. **Powerful filters** — Full expression support
3. **Wikilink aware** — Auto-update on move
4. **Reversible** — Backup and restore
5. **Fast** — Batch operations, minimal I/O
6. **Scriptable** — JSON output, proper exit codes
