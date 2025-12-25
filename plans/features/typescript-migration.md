# TypeScript Migration

> Phase 0: Migrate ovault from Bash to TypeScript

---

## Overview

The current ovault implementation is written in Bash. While functional, this limits:

- **Testing**: No good test framework for shell scripts
- **Type Safety**: Easy to introduce bugs, hard to refactor
- **Complex Logic**: Nested conditionals, error handling, parsing are ugly
- **Data Structures**: Associative arrays are clunky
- **Agentic Features**: API calls, streaming, async operations are difficult

TypeScript provides all of these capabilities while maintaining excellent CLI ergonomics.

---

## Why TypeScript?

### Considered Alternatives

| Language | Types | Testing | CLI | Agentic Ready | Learning Curve | Distribution |
|----------|-------|---------|-----|---------------|----------------|--------------|
| **TypeScript** | Excellent | Excellent | Great | Native async | Low-Medium | npm/binary |
| Rust | Excellent | Excellent | Great | Complex async | High | Single binary |
| Python | Optional | Excellent | Good | Excellent | Low | pip/binary |
| Go | Basic | Good | Great | Good | Medium | Single binary |

### TypeScript Wins Because:

1. **Ecosystem alignment** — Obsidian plugins are JS/TS
2. **Excellent type safety** — Catches bugs at compile time
3. **Best-in-class testing** — Vitest, Jest, excellent mocking
4. **CLI frameworks are mature** — Commander, Oclif, Yargs
5. **Agentic features are natural** — async/await, fetch, streaming
6. **Distribution options** — npm, npx, or single binary via Bun/pkg

### Performance Considerations

For vault operations (1K-10K files):

| Operation | Expected Time | Bottleneck |
|-----------|---------------|------------|
| List all files | ~50-200ms | Filesystem I/O |
| Parse frontmatter | ~100-500ms | YAML parsing |
| Filter in memory | <50ms | Trivial |
| Write one file | ~5ms | Disk I/O |

**V8 is plenty fast.** Disk I/O is always the bottleneck, not the language.

---

## Architecture

### Project Structure

```
ovault/
├── src/
│   ├── index.ts              # CLI entry point
│   ├── commands/
│   │   ├── new.ts
│   │   ├── edit.ts
│   │   ├── list.ts
│   │   ├── open.ts
│   │   ├── audit.ts
│   │   ├── bulk.ts
│   │   └── schema/
│   │       ├── show.ts
│   │       ├── add-type.ts
│   │       ├── add-field.ts
│   │       └── ...
│   ├── lib/
│   │   ├── schema.ts         # Schema loading & validation
│   │   ├── frontmatter.ts    # Frontmatter parsing & writing
│   │   ├── query.ts          # Expression parsing & evaluation
│   │   ├── vault.ts          # Vault operations
│   │   ├── git.ts            # Git status & warnings
│   │   └── obsidian.ts       # Obsidian URI handling
│   ├── types/
│   │   ├── schema.ts         # Schema type definitions
│   │   ├── note.ts           # Note/frontmatter types
│   │   └── query.ts          # Query expression types
│   └── utils/
│       ├── prompt.ts         # Interactive prompts
│       ├── table.ts          # Table output formatting
│       └── fs.ts             # File system helpers
├── tests/
│   ├── commands/
│   ├── lib/
│   └── fixtures/
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── README.md
```

### Dependencies

**Core:**
- `commander` — CLI framework
- `zod` — Schema validation (runtime + types)
- `gray-matter` — Frontmatter parsing
- `yaml` — YAML serialization
- `fast-glob` — File pattern matching
- `jsep` or `expr-eval` — Expression parsing
- `chalk` — Terminal colors
- `ora` — Spinners
- `prompts` or `inquirer` — Interactive prompts
- `cli-table3` — Table output

**Development:**
- `typescript`
- `vitest` — Testing
- `tsx` — Development runner
- `esbuild` or `tsup` — Bundling

### Type Definitions

```typescript
// types/schema.ts
import { z } from 'zod';

export const FieldSchema = z.object({
  prompt: z.enum(['input', 'select', 'multi-input', 'date', 'dynamic']).optional(),
  value: z.string().optional(),
  enum: z.string().optional(),
  source: z.string().optional(),
  required: z.boolean().optional(),
  default: z.union([z.string(), z.array(z.string())]).optional(),
  list_format: z.enum(['yaml-array', 'comma-separated']).optional(),
  label: z.string().optional(),
});

export const SubtypeSchema = z.object({
  output_dir: z.string().optional(),
  filename: z.string().optional(),
  frontmatter: z.record(FieldSchema),
  frontmatter_order: z.array(z.string()).optional(),
});

export const TypeSchema = z.object({
  output_dir: z.string(),
  dir_mode: z.enum(['pooled', 'instance-grouped']).default('pooled'),
  frontmatter: z.record(FieldSchema).optional(),
  frontmatter_order: z.array(z.string()).optional(),
  subtypes: z.record(SubtypeSchema).optional(),
});

export const OvaultSchema = z.object({
  version: z.number(),
  shared_fields: z.record(FieldSchema).optional(),
  enums: z.record(z.array(z.string())),
  types: z.record(TypeSchema),
});

export type Field = z.infer<typeof FieldSchema>;
export type Subtype = z.infer<typeof SubtypeSchema>;
export type Type = z.infer<typeof TypeSchema>;
export type Schema = z.infer<typeof OvaultSchema>;
```

---

## Migration Strategy

### Approach: Full Rewrite

Given the codebase is ~1000 lines of shell (which translates to ~500-800 lines of TS), a full rewrite is cleaner than incremental migration.

### Phase 0.1: Project Setup

1. Initialize TypeScript project with package.json
2. Configure tsconfig.json, vitest, eslint
3. Set up basic CLI structure with Commander
4. Create Zod schemas for validation

### Phase 0.2: Core Library

1. Port `lib/schema.sh` → `src/lib/schema.ts`
2. Port frontmatter parsing → `src/lib/frontmatter.ts`
3. Port vault operations → `src/lib/vault.ts`
4. Add expression parser → `src/lib/query.ts`

### Phase 0.3: Commands

1. Port `ovault new` → `src/commands/new.ts`
2. Port `ovault edit` → `src/commands/edit.ts`
3. Port `ovault list` → `src/commands/list.ts`
4. Add `ovault open` → `src/commands/open.ts`
5. Add `ovault help` → handled by Commander

### Phase 0.4: Testing

1. Port existing tests from `tests/` to Vitest
2. Add unit tests for lib functions
3. Add integration tests for commands
4. Achieve >80% coverage

### Phase 0.5: Polish

1. Add proper error handling
2. Add progress spinners for long operations
3. Improve table output formatting
4. Add shell completions

---

## CLI Interface

The CLI interface remains the same, but with improved consistency:

```bash
# Core commands
ovault new <type>                    # Create new note
ovault edit <file>                   # Edit existing note
ovault list <type> [options]         # List notes
ovault open <file>                   # Open in Obsidian

# Audit & bulk (Phase 2)
ovault audit [type] [options]        # Validate notes
ovault bulk <type> [options]         # Mass operations

# Schema management (Phase 4)
ovault schema show [type]            # View schema
ovault schema validate               # Validate schema
ovault schema add-type <name>        # Add type
ovault schema add-field <name> <type># Add field
ovault schema edit-enum <name>       # Modify enum

# Templates (Phase 3)
ovault template list [type]          # List templates
ovault template new <type>           # Create template

# Global options
ovault --vault <path>                # Specify vault
ovault --version                     # Show version
ovault --help                        # Show help
```

---

## Testing Strategy

### Unit Tests

```typescript
// tests/lib/schema.test.ts
import { describe, it, expect } from 'vitest';
import { loadSchema, getTypeConfig, getFieldsForType } from '../src/lib/schema';

describe('loadSchema', () => {
  it('should load and validate schema from .ovault/schema.json', async () => {
    const schema = await loadSchema('/path/to/vault');
    expect(schema.version).toBeGreaterThan(0);
    expect(schema.types).toBeDefined();
  });

  it('should throw on invalid schema', async () => {
    await expect(loadSchema('/invalid/path')).rejects.toThrow();
  });
});

describe('getFieldsForType', () => {
  it('should merge shared fields with type fields', () => {
    const fields = getFieldsForType(mockSchema, 'objective/task');
    expect(fields).toHaveProperty('status'); // shared
    expect(fields).toHaveProperty('milestone'); // type-specific
  });

  it('should respect type overrides of shared fields', () => {
    const fields = getFieldsForType(mockSchema, 'idea');
    expect(fields.status.default).toBe('inbox'); // overridden
  });
});
```

### Integration Tests

```typescript
// tests/commands/new.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { join } from 'path';

describe('ovault new', () => {
  let testVault: string;

  beforeEach(async () => {
    testVault = await mkdtemp('/tmp/ovault-test-');
    // Copy test fixtures
  });

  afterEach(async () => {
    await rm(testVault, { recursive: true });
  });

  it('should create a new task with prompted fields', async () => {
    // Use expect-test or similar for CLI testing
    const result = execSync(`ovault new objective/task --vault ${testVault}`, {
      input: 'Test Task\nmilestone-1\n',
    });
    
    const created = await readFile(join(testVault, 'Objectives/Tasks/Test Task.md'), 'utf-8');
    expect(created).toContain('type: task');
  });
});
```

### Test Fixtures

Migrate existing fixtures from `tests/fixtures/` and expand:

```
tests/
├── fixtures/
│   ├── vault/                    # Test vault with notes
│   │   ├── .ovault/
│   │   │   └── schema.json
│   │   ├── Ideas/
│   │   ├── Objectives/
│   │   └── Templates/
│   ├── schemas/
│   │   ├── valid.json
│   │   ├── invalid-enum.json
│   │   └── ...
│   └── notes/
│       ├── valid-task.md
│       ├── missing-required.md
│       └── ...
```

---

## Distribution

### Development

```bash
npm install
npm run dev           # Run with tsx
npm test              # Run tests
npm run build         # Build for production
```

### npm Package

```json
{
  "name": "ovault",
  "version": "2.0.0",
  "bin": {
    "ovault": "./dist/index.js"
  }
}
```

Users install with:
```bash
npm install -g ovault
# or
npx ovault new idea
```

### Single Binary (Optional)

Using Bun:
```bash
bun build src/index.ts --compile --outfile ovault
```

Or pkg:
```bash
npx pkg dist/index.js --targets node18-macos-arm64
```

---

## Migration Checklist

- [ ] Initialize TypeScript project
- [ ] Set up Vitest and testing infrastructure
- [ ] Define Zod schemas for validation
- [ ] Port schema loading (`lib/schema.sh` → `lib/schema.ts`)
- [ ] Port frontmatter parsing (`lib/body.sh` → `lib/frontmatter.ts`)
- [ ] Port list functionality (`lib/list.sh` → `lib/vault.ts`)
- [ ] Port query parsing (`lib/query.sh` → `lib/query.ts`)
- [ ] Port `ovault new` command
- [ ] Port `ovault edit` command
- [ ] Port `ovault list` command
- [ ] Add `ovault open` command
- [ ] Port existing tests
- [ ] Add new unit tests (>80% coverage)
- [ ] Add integration tests
- [ ] Update README with new installation instructions
- [ ] Remove old shell scripts (keep as reference initially)

---

## Success Criteria

1. **Feature parity** — All v1 functionality works in TypeScript
2. **Test coverage** — >80% line coverage
3. **Type safety** — No `any` types, full Zod validation
4. **Performance** — List 1000 files in <500ms
5. **Documentation** — Updated README, --help for all commands
