# Query System

> Expression-based filtering with Obsidian Bases parity

---

## Overview

bwrb's query system provides powerful filtering capabilities compatible with Obsidian Bases. This enables:

- Complex filters in `bwrb list`
- Conditions in `bwrb bulk`
- Validation rules in templates
- Future: `bwrb base` for generating Bases queries

---

## Syntax

### Basic Comparison

```bash
# Equality
bwrb list task --where "status == 'in-progress'"
bwrb list task --where "priority == 'high'"

# Inequality
bwrb list task --where "status != 'done'"

# Numeric comparison
bwrb list task --where "priority < 3"
bwrb list task --where "priority >= 2"

# String comparison (lexicographic)
bwrb list task --where "title < 'M'"
```

### Boolean Logic

```bash
# AND
bwrb list task --where "status == 'in-progress' && priority == 'high'"

# OR
bwrb list task --where "status == 'done' || status == 'cancelled'"

# NOT
bwrb list task --where "!isEmpty(deadline)"

# Grouped
bwrb list task --where "(status == 'inbox' || status == 'backlog') && priority == 'critical'"
```

### Multiple --where Clauses

Multiple `--where` flags are ANDed together:

```bash
bwrb list task --where "status == 'in-progress'" --where "priority == 'high'"
# Equivalent to:
bwrb list task --where "status == 'in-progress' && priority == 'high'"
```

---

## Operators

### Comparison Operators

| Operator | Description | Example |
|----------|-------------|---------|
| `==` | Equal | `status == 'done'` |
| `!=` | Not equal | `status != 'done'` |
| `>` | Greater than | `priority > 2` |
| `<` | Less than | `deadline < today()` |
| `>=` | Greater or equal | `priority >= 2` |
| `<=` | Less or equal | `deadline <= today() + '7d'` |

### Boolean Operators

| Operator | Description | Example |
|----------|-------------|---------|
| `&&` | Logical AND | `a && b` |
| `\|\|` | Logical OR | `a \|\| b` |
| `!` | Logical NOT | `!isEmpty(field)` |

### Arithmetic Operators

| Operator | Description | Example |
|----------|-------------|---------|
| `+` | Addition | `priority + 1` |
| `-` | Subtraction | `today() - '7d'` |
| `*` | Multiplication | `price * quantity` |
| `/` | Division | `total / count` |

---

## Functions

### String Functions

| Function | Description | Example |
|----------|-------------|---------|
| `contains(str, substr)` | String contains substring | `contains(title, 'bug')` |
| `startsWith(str, prefix)` | String starts with | `startsWith(title, 'WIP')` |
| `endsWith(str, suffix)` | String ends with | `endsWith(title, '.md')` |
| `lower(str)` | Lowercase | `lower(title)` |
| `upper(str)` | Uppercase | `upper(status)` |
| `length(str)` | String length | `length(title) > 10` |
| `trim(str)` | Remove whitespace | `trim(title)` |
| `replace(str, old, new)` | Replace substring | `replace(title, '-', ' ')` |

### Date Functions

| Function | Description | Example |
|----------|-------------|---------|
| `today()` | Today's date | `deadline < today()` |
| `now()` | Current datetime | `file.mtime > now() - '1h'` |
| `date(str)` | Parse date | `date('2025-01-15')` |
| `year(date)` | Extract year | `year(deadline) == 2025` |
| `month(date)` | Extract month | `month(deadline) == 1` |
| `day(date)` | Extract day | `day(deadline) == 15` |

### Duration Literals

Durations can be added/subtracted from dates:

| Literal | Description |
|---------|-------------|
| `'1d'` | 1 day |
| `'7d'` | 7 days |
| `'1w'` | 1 week |
| `'1m'` | 1 month |
| `'1y'` | 1 year |
| `'2h'` | 2 hours |
| `'30min'` | 30 minutes |

```bash
bwrb list task --where "deadline < today() + '7d'"
bwrb list task --where "file.mtime > now() - '24h'"
```

### Null/Empty Functions

| Function | Description | Example |
|----------|-------------|---------|
| `isEmpty(field)` | Field is empty/null/[] | `isEmpty(tags)` |
| `isNull(field)` | Field is null/undefined | `isNull(deadline)` |
| `isDefined(field)` | Field exists | `isDefined(deadline)` |

### List Functions

| Function | Description | Example |
|----------|-------------|---------|
| `contains(list, item)` | List contains item | `contains(tags, 'urgent')` |
| `length(list)` | List length | `length(tags) > 0` |
| `isEmpty(list)` | List is empty | `isEmpty(tags)` |

### File Functions

| Function | Description | Example |
|----------|-------------|---------|
| `inFolder(path)` | File is in folder | `inFolder('Archive/')` |
| `hasTag(tag)` | File has tag | `hasTag('urgent')` |
| `hasLink(target)` | File links to target | `hasLink('Project A')` |

---

## Field Access

### Frontmatter Fields

Access frontmatter fields directly by name:

```bash
bwrb list task --where "status == 'done'"
bwrb list task --where "priority < 3"
bwrb list task --where "contains(tags, 'urgent')"
```

### File Properties

Access file metadata via `file.*`:

| Property | Description |
|----------|-------------|
| `file.name` | Filename (without extension) |
| `file.path` | Full path |
| `file.folder` | Parent folder |
| `file.ext` | File extension |
| `file.size` | File size in bytes |
| `file.ctime` | Creation time |
| `file.mtime` | Modification time |

```bash
bwrb list task --where "file.mtime > now() - '24h'"
bwrb list task --where "inFolder('Archive/')"
```

### Nested Access

For nested frontmatter (if supported):

```bash
bwrb list task --where "metadata.author == 'alice'"
```

---

## Type Coercion

The query engine handles type coercion:

| From | To | Rule |
|------|-----|------|
| String | Number | Parse if numeric |
| String | Date | Parse ISO format |
| String | Boolean | `'true'` → true |
| Number | String | Stringify |
| Null | String | `''` |
| Null | Number | `0` |
| Null | Boolean | `false` |

---

## Examples

### Common Queries

```bash
# Overdue tasks
bwrb list task --where "deadline < today() && status != 'done'"

# High priority inbox items
bwrb list task --where "status == 'inbox' && (priority == 'high' || priority == 'critical')"

# Recently modified
bwrb list --all --where "file.mtime > now() - '24h'"

# Tasks without deadlines
bwrb list task --where "isEmpty(deadline) && status != 'done'"

# Tasks for this week
bwrb list task --where "scope == 'week' && status != 'done'"

# Items with specific tag
bwrb list --all --where "contains(tags, 'review')"

# Drafts in progress
bwrb list draft --where "status == 'drafting' || status == 'revising'"
```

### Bulk Operations

```bash
# Mark overdue as urgent
bwrb bulk task --append tags=overdue --where "deadline < today() && status != 'done'" --execute

# Archive old completed tasks
bwrb bulk task --move Archive/Tasks --where "status == 'done' && file.mtime < now() - '30d'" --execute

# Set default priority
bwrb bulk task --set priority=medium --where "isEmpty(priority)" --execute
```

### Template Constraints

```yaml
constraints:
  deadline:
    validate: "this < today() + '5d'"
    error: "Deadline must be within 5 days"
  
  priority:
    validate: "this == 'critical' || this == 'high'"
    error: "Only high/critical priority for urgent tasks"
```

---

## Bases Compatibility

bwrb queries align with Obsidian Bases syntax for easy mental model sharing:

### Bases Syntax

```yaml
# .base file
filters:
  and:
    - status: "in-progress"
    - priority:
        gte: 2
```

### bwrb Equivalent

```bash
bwrb list task --where "status == 'in-progress' && priority >= 2"
```

### Future: Base Generation

```bash
bwrb base task --where "status == 'in-progress'" --where "priority >= 2"

# Output:
# filters:
#   and:
#     - status: "in-progress"  
#     - priority:
#         gte: 2
```

---

## Error Handling

### Syntax Errors

```bash
bwrb list task --where "status = 'done'"
# Error: Invalid operator '=' at position 7
# Did you mean '=='?
# 
# status = 'done'
#        ^
```

### Unknown Fields

```bash
bwrb list task --where "stauts == 'done'"
# Warning: Unknown field 'stauts'. Did you mean 'status'?
# No results found.
```

### Type Errors

```bash
bwrb list task --where "deadline == 'not-a-date'"
# Warning: Cannot compare date field 'deadline' with non-date value
```

---

## Implementation

### Expression Parsing

Using `jsep` for parsing:

```typescript
import jsep from 'jsep';

// Add custom operators
jsep.addBinaryOp('&&', 2);
jsep.addBinaryOp('||', 1);

function parseExpression(expr: string): jsep.Expression {
  return jsep(expr);
}

function evaluateExpression(
  expr: jsep.Expression,
  context: Record<string, any>
): any {
  switch (expr.type) {
    case 'BinaryExpression':
      const left = evaluateExpression(expr.left, context);
      const right = evaluateExpression(expr.right, context);
      return applyOperator(expr.operator, left, right);
    
    case 'CallExpression':
      const fn = FUNCTIONS[expr.callee.name];
      const args = expr.arguments.map(arg => evaluateExpression(arg, context));
      return fn(...args);
    
    case 'Identifier':
      return context[expr.name];
    
    case 'Literal':
      return expr.value;
    
    case 'MemberExpression':
      const obj = evaluateExpression(expr.object, context);
      return obj?.[expr.property.name];
    
    // ... more cases
  }
}
```

### Built-in Functions

```typescript
const FUNCTIONS: Record<string, Function> = {
  // String functions
  contains: (str: string, substr: string) => str?.includes(substr) ?? false,
  startsWith: (str: string, prefix: string) => str?.startsWith(prefix) ?? false,
  endsWith: (str: string, suffix: string) => str?.endsWith(suffix) ?? false,
  lower: (str: string) => str?.toLowerCase() ?? '',
  upper: (str: string) => str?.toUpperCase() ?? '',
  length: (val: any) => Array.isArray(val) ? val.length : String(val ?? '').length,
  trim: (str: string) => str?.trim() ?? '',
  
  // Date functions
  today: () => new Date().toISOString().split('T')[0],
  now: () => new Date(),
  date: (str: string) => new Date(str),
  year: (date: Date) => date.getFullYear(),
  month: (date: Date) => date.getMonth() + 1,
  day: (date: Date) => date.getDate(),
  
  // Null functions
  isEmpty: (val: any) => val == null || val === '' || (Array.isArray(val) && val.length === 0),
  isNull: (val: any) => val == null,
  isDefined: (val: any) => val !== undefined,
  
  // File functions (require file context)
  inFolder: (folder: string, ctx: FileContext) => ctx.file.folder.startsWith(folder),
  hasTag: (tag: string, ctx: FileContext) => ctx.frontmatter.tags?.includes(tag) ?? false,
  hasLink: (target: string, ctx: FileContext) => ctx.links.includes(target),
};
```

### Duration Parsing

```typescript
function parseDuration(str: string): number {
  const match = str.match(/^(\d+)(min|h|d|w|m|y)$/);
  if (!match) throw new Error(`Invalid duration: ${str}`);
  
  const [, value, unit] = match;
  const n = parseInt(value, 10);
  
  const MS_PER = {
    min: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
    m: 30 * 24 * 60 * 60 * 1000,
    y: 365 * 24 * 60 * 60 * 1000,
  };
  
  return n * MS_PER[unit];
}
```

---

## Performance

### Optimization Strategies

1. **Index common fields** — Cache parsed frontmatter
2. **Short-circuit evaluation** — `&&` stops on first false
3. **Compile expressions** — Parse once, evaluate many times
4. **Parallel file reading** — Use worker threads for large vaults

### Benchmarks Target

| Operation | Target |
|-----------|--------|
| Parse expression | <1ms |
| Evaluate (1 file) | <0.1ms |
| Filter 1000 files | <500ms |
| Filter 10000 files | <2s |

---

## Success Criteria

1. **Bases compatibility** — Same operators and functions
2. **Intuitive syntax** — Feels natural to write
3. **Helpful errors** — Clear messages, suggestions
4. **Fast** — Sub-second for typical vaults
5. **Extensible** — Easy to add new functions
