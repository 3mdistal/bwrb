# Audit Command

> Validate vault files against schema and surface mismatches

---

## Overview

The `pika audit` command validates files against the schema and reports issues:

- Missing required fields
- Invalid enum values
- Wrong directory location
- Unknown fields
- Type mismatches
- Orphan files
- Stale references

---

## Command Syntax

```bash
pika audit                      # Check all files (report only)
pika audit objective/task       # Check specific type
pika audit --fix                # Interactive repair mode
pika audit --fix --auto         # Automatic fixes where unambiguous
pika audit --strict             # Error on unknown fields
pika audit --templates          # Also audit templates
```

---

## Issue Types

### 1. Missing Required Field

A field marked `required: true` in schema is absent.

```
Issues/My Issue.md
  ✗ Missing required field: status
```

**Auto-fix:** Add with default value (if schema has default)
**Interactive fix:** Prompt for value

### 2. Invalid Enum Value

Field value not in enum definition.

```
Tasks/Bug Fix.md
  ✗ Invalid status value: 'wip' (expected: inbox, backlog, planned, in-progress, done, cancelled)
```

**Auto-fix:** Cannot auto-fix (ambiguous)
**Interactive fix:** Prompt to select valid value

### 3. Wrong Directory

File's `type` field doesn't match its location.

```
Ideas/My Task.md
  ✗ Wrong directory: type is 'task', expected in Objectives/Tasks/
```

**Auto-fix:** Cannot auto-fix (might be intentional)
**Interactive fix:** Offer to move file

### 4. Unknown Field

Field in frontmatter not defined in schema.

```
Tasks/Old Task.md
  ⚠ Unknown field: assignee (not in schema)
```

**Default behavior:** Warning only
**With `--strict`:** Error
**Auto-fix:** Cannot auto-fix
**Interactive fix:** Offer to remove or add to schema

### 5. Type Mismatch

`type` field value is invalid or misspelled.

```
Tasks/Something.md
  ✗ Invalid type: 'taks' (did you mean 'task'?)
```

**Auto-fix:** Cannot auto-fix
**Interactive fix:** Prompt to correct

### 6. Orphan File

File in managed directory but no `type` field.

```
Objectives/Tasks/Random Notes.md
  ✗ Orphan file: no 'type' field (in managed directory)
```

**Auto-fix:** Cannot auto-fix
**Interactive fix:** Assign type or move to unmanaged location

### 7. Format Violation

Field value doesn't match expected format.

```
Tasks/Task A.md
  ✗ Format violation: 'milestone' should be wikilink, got plain text
```

**Auto-fix:** Reformat if unambiguous (e.g., add `[[` `]]`)
**Interactive fix:** Prompt to confirm fix

### 8. Stale Reference

Wikilink points to deleted/moved file.

```
Tasks/Task B.md
  ⚠ Stale reference: milestone '[[Old Milestone]]' not found
```

**Auto-fix:** Cannot auto-fix
**Interactive fix:** Prompt to update or clear

### 9. Instance-Grouped Issues

For instance-grouped types:

```
Drafts/Q1 Blog Post/
  ✗ Missing parent note: expected 'Q1 Blog Post.md'

Drafts/Q1 Blog Post/Research.md
  ✗ Orphan subtype: 'draft/research' without parent
```

---

## Output Modes

### Default: Report Only

```bash
pika audit

# Auditing vault...
# 
# Objectives/Tasks/Task A.md
#   ✗ Missing required field: status
#   ✗ Invalid milestone value: 'nonexistent'
# 
# Objectives/Tasks/Task B.md
#   ⚠ Unknown field: custom-field
# 
# Ideas/Old Idea.md
#   ✗ Missing required field: status
#   ✗ Missing required field: scopes
# 
# Summary:
#   Files checked: 47
#   Files with errors: 3
#   Total errors: 5
#   Total warnings: 1
# 
# Run 'pika audit --fix' to repair interactively.
```

### Interactive Fix Mode

```bash
pika audit --fix

# Auditing vault...
# 
# Objectives/Tasks/Task A.md
#   ✗ Missing required field: status
#     → Add with default 'inbox'? [Y/n/s(kip)/q(uit)] y
#     ✓ Added status: inbox
#   
#   ✗ Invalid milestone value: 'nonexistent'
#     Current: nonexistent
#     Valid milestones:
#       1. Q1 Release
#       2. Beta Launch
#       3. [clear field]
#     Select: 1
#     ✓ Updated milestone: Q1 Release
# 
# Objectives/Tasks/Task B.md
#   ⚠ Unknown field: custom-field
#     → Remove field? [y/N/a(dd to schema)/s(kip)] s
#     → Skipped
# 
# Summary:
#   Fixed: 2 issues
#   Skipped: 1 issue
#   Remaining: 2 issues
```

### Auto-Fix Mode

```bash
pika audit --fix --auto

# Auditing vault...
# 
# Auto-fixing unambiguous issues...
# 
#   Objectives/Tasks/Task A.md
#     ✓ Added status: inbox (default)
#   
#   Ideas/Old Idea.md
#     ✓ Added status: inbox (default)
#     ✓ Added scopes: [] (default)
# 
# Issues requiring manual review:
#   Objectives/Tasks/Task A.md
#     ✗ Invalid milestone value: 'nonexistent'
#   Objectives/Tasks/Task B.md
#     ⚠ Unknown field: custom-field
# 
# Summary:
#   Auto-fixed: 3 issues
#   Manual review needed: 2 issues
# 
# Run 'pika audit --fix' to address remaining issues.
```

### Strict Mode

```bash
pika audit --strict

# Unknown fields are now errors:
# 
# Objectives/Tasks/Task B.md
#   ✗ Unknown field: custom-field (strict mode)
# 
# Exit code: 1
```

---

## Filtering

### By Type

```bash
pika audit objective/task      # Only tasks
pika audit objective           # Tasks and milestones
pika audit draft               # All draft instances
pika audit draft/version       # Only draft versions
```

### By Directory

```bash
pika audit --path "Objectives/Tasks/"
pika audit --path "Drafts/Q1 Blog Post/"
```

### By Issue Type

```bash
pika audit --only missing-required
pika audit --only invalid-enum
pika audit --only unknown-field
pika audit --ignore unknown-field
```

---

## Unknown Fields Handling

### Default Allowed Fields

These fields are always allowed (Obsidian native):

- `tags`
- `aliases`
- `cssclasses`
- `publish`

### Schema-Level Configuration

```json
{
  "audit": {
    "allowed_extra_fields": ["custom-field", "legacy-field"],
    "ignored_directories": ["Archive/", "Templates/"]
  }
}
```

### Command-Line Override

```bash
pika audit --allow-field custom-field
pika audit --strict --allow-field custom-field
```

---

## Auto-Fix Rules

| Issue Type | Auto-Fixable | Condition |
|------------|--------------|-----------|
| Missing required field | Yes | If schema has default |
| Invalid enum value | No | Ambiguous choice |
| Wrong directory | No | Might be intentional |
| Unknown field | No | User decision |
| Type mismatch | No | Ambiguous |
| Orphan file | No | User decision |
| Format violation | Partial | If transformation is clear |
| Stale reference | No | User decision |
| Missing parent note | No | User decision |

---

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | No issues (or all fixed) |
| 1 | Errors found (not fixed) |
| 2 | Warnings only (with `--strict-warnings`) |

---

## Integration with Other Commands

### Pre-Bulk Check

```bash
pika bulk task --set status=done --where "status == 'in-progress'"
# Warning: 3 files have audit issues that may affect this operation.
# Run 'pika audit objective/task' first? [Y/n]
```

### Post-Schema-Change

```bash
pika schema edit-enum status --rename wip=in-progress
# Schema updated. Run 'pika audit' to check for issues.
```

### CI/CD Integration

```bash
pika audit --format json > audit-report.json
pika audit --format junit > audit-report.xml
```

---

## Instance-Grouped Audit

For instance-grouped types, additional checks:

### Parent Note Check

```bash
pika audit draft

# Checking draft instances...
# 
# Drafts/Q1 Blog Post/
#   ✓ Parent note exists: Q1 Blog Post.md
#   ✓ 4 subtype files valid
# 
# Drafts/Technical Guide/
#   ✗ Missing parent note: expected 'Technical Guide.md'
#   ⚠ 2 orphan subtype files
```

### Subtype Validation

```bash
pika audit draft/version

# Checking draft/version files...
# 
# Drafts/Q1 Blog Post/Draft v1.md
#   ✓ Valid
# 
# Drafts/Q1 Blog Post/Random.md
#   ⚠ Unknown file in draft folder (not a recognized subtype)
```

---

## Implementation Notes

### File Discovery

```typescript
async function discoverManagedFiles(
  vaultPath: string,
  schema: Schema
): Promise<ManagedFile[]> {
  const files: ManagedFile[] = [];
  
  // For pooled types: glob output_dir
  for (const [typeName, typeConfig] of Object.entries(schema.types)) {
    if (typeConfig.dir_mode !== 'instance-grouped') {
      const pattern = path.join(vaultPath, typeConfig.output_dir, '**/*.md');
      const matches = await glob(pattern);
      for (const file of matches) {
        files.push({ path: file, expectedType: typeName });
      }
    }
  }
  
  // For instance-grouped: discover instances first
  for (const [typeName, typeConfig] of Object.entries(schema.types)) {
    if (typeConfig.dir_mode === 'instance-grouped') {
      const baseDir = path.join(vaultPath, typeConfig.output_dir);
      const instances = await fs.readdir(baseDir);
      for (const instance of instances) {
        const instanceDir = path.join(baseDir, instance);
        if ((await fs.stat(instanceDir)).isDirectory()) {
          const instanceFiles = await glob(path.join(instanceDir, '*.md'));
          for (const file of instanceFiles) {
            files.push({ path: file, expectedType: typeName, instance });
          }
        }
      }
    }
  }
  
  return files;
}
```

### Issue Detection

```typescript
interface AuditIssue {
  file: string;
  type: 'error' | 'warning';
  code: string;
  message: string;
  autoFixable: boolean;
  fix?: () => Promise<void>;
}

async function auditFile(
  filePath: string,
  schema: Schema,
  options: AuditOptions
): Promise<AuditIssue[]> {
  const issues: AuditIssue[] = [];
  const { data: frontmatter, content } = matter(await fs.readFile(filePath, 'utf-8'));
  
  const noteType = frontmatter.type as string;
  if (!noteType) {
    issues.push({
      file: filePath,
      type: 'error',
      code: 'orphan-file',
      message: "No 'type' field (in managed directory)",
      autoFixable: false,
    });
    return issues;
  }
  
  const typeConfig = getTypeConfig(schema, noteType);
  if (!typeConfig) {
    issues.push({
      file: filePath,
      type: 'error',
      code: 'invalid-type',
      message: `Invalid type: '${noteType}'`,
      autoFixable: false,
    });
    return issues;
  }
  
  const fields = getFieldsForType(schema, noteType);
  
  // Check required fields
  for (const [fieldName, fieldConfig] of Object.entries(fields)) {
    if (fieldConfig.required && !(fieldName in frontmatter)) {
      issues.push({
        file: filePath,
        type: 'error',
        code: 'missing-required',
        message: `Missing required field: ${fieldName}`,
        autoFixable: fieldConfig.default !== undefined,
        fix: fieldConfig.default !== undefined
          ? () => addField(filePath, fieldName, fieldConfig.default)
          : undefined,
      });
    }
  }
  
  // Check enum values
  for (const [fieldName, value] of Object.entries(frontmatter)) {
    const fieldConfig = fields[fieldName];
    if (fieldConfig?.enum) {
      const enumValues = schema.enums[fieldConfig.enum];
      if (enumValues && !enumValues.includes(value as string)) {
        issues.push({
          file: filePath,
          type: 'error',
          code: 'invalid-enum',
          message: `Invalid ${fieldName} value: '${value}' (expected: ${enumValues.join(', ')})`,
          autoFixable: false,
        });
      }
    }
  }
  
  // Check unknown fields
  if (options.strict) {
    for (const fieldName of Object.keys(frontmatter)) {
      if (!(fieldName in fields) && !ALLOWED_NATIVE_FIELDS.includes(fieldName)) {
        issues.push({
          file: filePath,
          type: options.strict ? 'error' : 'warning',
          code: 'unknown-field',
          message: `Unknown field: ${fieldName}`,
          autoFixable: false,
        });
      }
    }
  }
  
  return issues;
}
```

---

## Success Criteria

1. **Comprehensive** — Catches all schema violations
2. **Actionable** — Clear messages with fix suggestions
3. **Safe** — Auto-fix only when unambiguous
4. **Fast** — Audit 1000 files in <2 seconds
5. **Flexible** — Filter by type, path, issue type
6. **CI-friendly** — JSON/JUnit output, proper exit codes
