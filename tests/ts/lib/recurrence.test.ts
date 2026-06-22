import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';

import { loadSchema } from '../../../src/lib/schema.js';
import { editNoteFromJson } from '../../../src/lib/edit.js';
import { executeBulk } from '../../../src/lib/bulk/execute.js';
import { runAudit } from '../../../src/lib/audit/detection.js';
import { runAutoFix } from '../../../src/lib/audit/fix.js';
import { createNoteFromJson } from '../../../src/commands/new/json-mode.js';
import {
  parseTrigger,
  parseFieldOffset,
  computeOffsetFields,
  needsSuccessor,
  validateRecurrenceRule,
} from '../../../src/lib/recurrence.js';
import type { Schema } from '../../../src/types/schema.js';

// A schema whose `task` type composes a `recurring` trait: completing a task
// (status -> done) spawns a successor whose deadline is offset 7 days from the
// predecessor's deadline. The `next`/`prev` relation fields form the chain.
const RECURRING_SCHEMA: Schema = {
  version: 2,
  traits: {
    recurring: {
      description: 'Spawn-on-transition recurrence',
      fields: {
        next: { prompt: 'relation', source: 'task' },
        prev: { prompt: 'relation', source: 'task' },
      },
      recurrence: {
        on: 'status = done',
        set: {
          deadline: 'deadline + 7d',
        },
      },
    },
  },
  types: {
    task: {
      output_dir: 'tasks',
      traits: ['recurring'],
      fields: {
        name: { prompt: 'text', required: true },
        status: { prompt: 'select', options: ['todo', 'doing', 'done'], default: 'todo' },
        deadline: { prompt: 'date' },
      },
    },
  },
};

// A non-recurring schema (back-compat): a plain `note` type.
const PLAIN_SCHEMA: Schema = {
  version: 2,
  types: {
    note: {
      output_dir: 'notes',
      fields: {
        name: { prompt: 'text', required: true },
        status: { prompt: 'select', options: ['open', 'done'], default: 'open' },
      },
    },
  },
};

async function setupVault(schema: Schema): Promise<string> {
  const vaultDir = await mkdtemp(join(tmpdir(), 'recurrence-test-'));
  await mkdir(join(vaultDir, '.bwrb'), { recursive: true });
  await writeFile(join(vaultDir, '.bwrb', 'schema.json'), JSON.stringify(schema, null, 2));
  return vaultDir;
}

async function writeDefaultTaskTemplate(vaultDir: string): Promise<void> {
  const dir = join(vaultDir, '.bwrb', 'templates', 'task');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'default.md'),
    `---
type: template
template-for: task
defaults:
  status: todo
---

# {name}
`
  );
}

async function readFrontmatter(filePath: string): Promise<Record<string, unknown>> {
  const { parseNote } = await import('../../../src/lib/frontmatter.js');
  const { frontmatter } = await parseNote(filePath);
  return frontmatter;
}

async function listTasks(vaultDir: string): Promise<string[]> {
  const dir = join(vaultDir, 'tasks');
  if (!existsSync(dir)) return [];
  return (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
}

/** Extract the raw text after `<key>:` on its frontmatter line (verbatim). */
async function rawFieldLine(filePath: string, key: string): Promise<string> {
  const content = await readFile(filePath, 'utf-8');
  const line = content.split('\n').find((l) => l.startsWith(`${key}:`));
  if (!line) throw new Error(`No '${key}:' line in ${filePath}`);
  return line.slice(`${key}:`.length).trim();
}

describe('recurrence: pure helpers', () => {
  it('parses a trigger expression', () => {
    expect(parseTrigger('status = done')).toEqual({ field: 'status', value: 'done' });
    expect(parseTrigger('status=done')).toEqual({ field: 'status', value: 'done' });
    expect(parseTrigger("status = 'done'")).toEqual({ field: 'status', value: 'done' });
    expect(parseTrigger('garbage')).toBeNull();
  });

  it('parses a field-offset expression', () => {
    expect(parseFieldOffset('deadline + 7d')).toEqual({
      baseField: 'deadline',
      sign: 1,
      amount: 7,
      unit: 'd',
    });
    expect(parseFieldOffset('deadline+1w')).toEqual({
      baseField: 'deadline',
      sign: 1,
      amount: 1,
      unit: 'w',
    });
    expect(parseFieldOffset('due - 2mon')?.unit).toBe('mon');
    // m is normalized to mon
    expect(parseFieldOffset('due + 3m')?.unit).toBe('mon');
    // not a field-offset (transition-time offset would have no date field base
    // we recognize, but "completed + 7d" is still parsed as a field offset on
    // the `completed` field — the date-base validation rejects non-date bases).
    expect(parseFieldOffset('justtext')).toBeNull();
  });
});

describe('recurrence: validation', () => {
  let vaultDir: string;
  afterEach(async () => {
    if (vaultDir) await rm(vaultDir, { recursive: true, force: true });
  });

  it('accepts a valid date-base offset rule', async () => {
    vaultDir = await setupVault(RECURRING_SCHEMA);
    const schema = await loadSchema(vaultDir);
    expect(validateRecurrenceRule(schema, 'task')).toEqual([]);
  });

  it('rejects a non-date offset base', async () => {
    const badSchema: Schema = JSON.parse(JSON.stringify(RECURRING_SCHEMA));
    // base `status` is a select field, not a date field
    badSchema.traits!.recurring!.recurrence!.set = { deadline: 'status + 7d' };
    vaultDir = await setupVault(badSchema);
    const schema = await loadSchema(vaultDir);
    const issues = validateRecurrenceRule(schema, 'task');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.message).toMatch(/must be a date field/);
  });

  it('computes the offset date from the predecessor', async () => {
    vaultDir = await setupVault(RECURRING_SCHEMA);
    const schema = await loadSchema(vaultDir);
    const out = computeOffsetFields(schema, 'task', { deadline: '2026-01-01' });
    expect(out).toEqual({ deadline: '2026-01-08' });
  });
});

describe('recurrence: fast path (edit --json)', () => {
  let vaultDir: string;
  beforeEach(async () => {
    vaultDir = await setupVault(RECURRING_SCHEMA);
    await writeDefaultTaskTemplate(vaultDir);
    await mkdir(join(vaultDir, 'tasks'), { recursive: true });
  });
  afterEach(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  it('spawns one successor with correct offset + chain links on status->done', async () => {
    const taskPath = join(vaultDir, 'tasks', 'Water plants.md');
    await writeFile(
      taskPath,
      `---
type: task
name: Water plants
status: doing
deadline: 2026-03-01
---

# Water plants
`
    );

    const schema = await loadSchema(vaultDir);
    await editNoteFromJson(schema, vaultDir, taskPath, JSON.stringify({ status: 'done' }), {
      jsonMode: false,
    });

    const tasks = await listTasks(vaultDir);
    expect(tasks).toHaveLength(2); // predecessor + successor

    // Predecessor now points forward via `next`.
    const predFm = await readFrontmatter(taskPath);
    expect(predFm['status']).toBe('done');
    expect(String(predFm['next'])).toContain('[[');

    // Successor: fresh status, offset deadline, back-link, empty next.
    const successorName = tasks.find((f) => f !== 'Water plants.md')!;
    const succFm = await readFrontmatter(join(vaultDir, 'tasks', successorName));
    expect(succFm['status']).not.toBe('done');
    expect(succFm['deadline']).toBe('2026-03-08');
    expect(String(succFm['prev'])).toContain('Water plants');
    expect(succFm['next'] ?? '').toBe('');
  });

  it('writes a CLEAN, byte-symmetric next/prev; audit clean; --fix converges (#107 blocker 1)', async () => {
    const taskPath = join(vaultDir, 'tasks', 'Symmetric.md');
    await writeFile(
      taskPath,
      `---
type: task
name: Symmetric
status: doing
deadline: 2026-03-01
---

# Symmetric
`
    );

    const schema = await loadSchema(vaultDir);
    await editNoteFromJson(schema, vaultDir, taskPath, JSON.stringify({ status: 'done' }), {
      jsonMode: false,
    });

    const tasks = await listTasks(vaultDir);
    expect(tasks).toHaveLength(2);
    const successorName = tasks.find((f) => f !== 'Symmetric.md')!;
    const succPath = join(vaultDir, 'tasks', successorName);

    // Predecessor's `next` must be a CLEAN wikilink — exactly one quoting layer,
    // NO embedded literal quote characters. The double-wrap bug produced
    // `'"[[Successor]]"'` (YAML single-quoted around a literal `"[[...]]"`) or
    // `"\"[[Successor]]\""`. The clean form is `"[[Successor]]"`.
    const rawNext = await rawFieldLine(taskPath, 'next');
    expect(rawNext.startsWith("'")).toBe(false); // not YAML single-quoted (double-wrap)
    expect(rawNext).not.toContain('\\"'); // no escaped embedded quote
    expect(rawNext).toMatch(/^"\[\[[^"\\]+\]\]"$/); // single YAML quote layer, no inner quote

    // The parsed value is the bare wikilink (no embedded quote characters).
    const nextValue = String((await readFrontmatter(taskPath))['next']);
    expect(nextValue).toMatch(/^\[\[.+\]\]$/);
    expect(nextValue).not.toContain('"');

    // Byte-symmetric with the successor's `prev`: same shape, same quoting.
    const rawPrev = await rawFieldLine(succPath, 'prev');
    expect(rawPrev).toMatch(/^"\[\[[^"\\]+\]\]"$/);
    const prevValue = String((await readFrontmatter(succPath))['prev']);
    // next points at successor, prev points at predecessor; strip the names and
    // confirm the LINK SHELL is byte-identical.
    expect(nextValue.replace(/\[\[.*\]\]/, '[[X]]')).toBe(prevValue.replace(/\[\[.*\]\]/, '[[X]]'));

    // Audit is clean immediately after the spawn: no format-violation on `next`.
    const results = await runAudit(schema, vaultDir, { strict: false, vaultDir, schema });
    const issues = results.flatMap((r) => r.issues);
    expect(issues.some((i) => i.code === 'format-violation')).toBe(false);

    // `--fix` converges: a second run reports 0 fixes (non-converging double-wrap
    // would re-report "Fixed next format" forever).
    const r1 = await runAudit(schema, vaultDir, { strict: false, vaultDir, schema });
    await runAutoFix(r1, schema, vaultDir, { dryRun: false });
    const r2 = await runAudit(schema, vaultDir, { strict: false, vaultDir, schema });
    const summary2 = await runAutoFix(r2, schema, vaultDir, { dryRun: false });
    expect(summary2.fixed).toBe(0);
  });

  it('is idempotent: re-completing a task with a `next` does NOT spawn a duplicate', async () => {
    const taskPath = join(vaultDir, 'tasks', 'Recur.md');
    await writeFile(
      taskPath,
      `---
type: task
name: Recur
status: doing
deadline: 2026-03-01
---
`
    );

    const schema = await loadSchema(vaultDir);
    await editNoteFromJson(schema, vaultDir, taskPath, JSON.stringify({ status: 'done' }), {
      jsonMode: false,
    });
    expect(await listTasks(vaultDir)).toHaveLength(2);

    // Re-run the same completion: `next` is now set, so this is a no-op.
    await editNoteFromJson(
      schema,
      vaultDir,
      taskPath,
      JSON.stringify({ status: 'done', deadline: '2026-03-01' }),
      { jsonMode: false }
    );
    expect(await listTasks(vaultDir)).toHaveLength(2);
  });

  it('does not spawn when status is set to a non-trigger value', async () => {
    const taskPath = join(vaultDir, 'tasks', 'Stay open.md');
    await writeFile(
      taskPath,
      `---
type: task
name: Stay open
status: todo
deadline: 2026-03-01
---
`
    );
    const schema = await loadSchema(vaultDir);
    await editNoteFromJson(schema, vaultDir, taskPath, JSON.stringify({ status: 'doing' }), {
      jsonMode: false,
    });
    expect(await listTasks(vaultDir)).toHaveLength(1);
  });
});

describe('recurrence: fast path (bulk)', () => {
  let vaultDir: string;
  beforeEach(async () => {
    vaultDir = await setupVault(RECURRING_SCHEMA);
    await writeDefaultTaskTemplate(vaultDir);
    await mkdir(join(vaultDir, 'tasks'), { recursive: true });
  });
  afterEach(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  it('spawns a successor when bulk --set status=done transitions a task', async () => {
    const taskPath = join(vaultDir, 'tasks', 'Bulk task.md');
    await writeFile(
      taskPath,
      `---
type: task
name: Bulk task
status: doing
deadline: 2026-05-10
---
`
    );

    const schema = await loadSchema(vaultDir);
    const result = await executeBulk({
      typePath: 'task',
      operations: [{ type: 'set', field: 'status', value: 'done' }],
      whereExpressions: [],
      execute: true,
      backup: false,
      verbose: false,
      quiet: true,
      jsonMode: true,
      vaultDir,
      schema,
    });

    expect(result.errors).toEqual([]);
    const tasks = await listTasks(vaultDir);
    expect(tasks).toHaveLength(2);
    const successorName = tasks.find((f) => f !== 'Bulk task.md')!;
    const succFm = await readFrontmatter(join(vaultDir, 'tasks', successorName));
    expect(succFm['deadline']).toBe('2026-05-17');

    // The bulk-written `next` is also a clean, single-quoted wikilink (#107).
    const rawNext = await rawFieldLine(join(vaultDir, 'tasks', 'Bulk task.md'), 'next');
    expect(rawNext.startsWith("'")).toBe(false);
    expect(rawNext).toMatch(/^"\[\[[^"\\]+\]\]"$/);
  });

  it('atomic: a bulk completion whose spawn fails leaves the predecessor UNMUTATED', async () => {
    // Point the recurrence at a missing template so the spawn cannot succeed.
    const badSchema: Schema = JSON.parse(JSON.stringify(RECURRING_SCHEMA));
    badSchema.traits!.recurring!.recurrence!.template = 'does-not-exist';
    const badVault = await setupVault(badSchema);
    await mkdir(join(badVault, 'tasks'), { recursive: true });
    const taskPath = join(badVault, 'tasks', 'Bulk atomic.md');
    await writeFile(
      taskPath,
      `---
type: task
name: Bulk atomic
status: doing
deadline: 2026-05-10
---
`
    );

    try {
      const schema = await loadSchema(badVault);
      const result = await executeBulk({
        typePath: 'task',
        operations: [{ type: 'set', field: 'status', value: 'done' }],
        whereExpressions: [],
        execute: true,
        backup: false,
        verbose: false,
        quiet: true,
        jsonMode: true,
        vaultDir: badVault,
        schema,
      });

      // The spawn failure is reported...
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.join(' ')).toMatch(/does-not-exist|was not found/);

      // ...and the predecessor was NOT mutated (still doing, no successor).
      const fm = await readFrontmatter(taskPath);
      expect(fm['status']).toBe('doing');
      expect(fm['next'] ?? '').toBe('');
      expect(await listTasks(badVault)).toEqual(['Bulk atomic.md']);
    } finally {
      await rm(badVault, { recursive: true, force: true });
    }
  });
});

describe('recurrence: backstop (audit missing-successor)', () => {
  let vaultDir: string;
  beforeEach(async () => {
    vaultDir = await setupVault(RECURRING_SCHEMA);
    await writeDefaultTaskTemplate(vaultDir);
    await mkdir(join(vaultDir, 'tasks'), { recursive: true });
  });
  afterEach(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  it('flags a hand-completed task (done + empty next) and --fix spawns the successor', async () => {
    // Simulate completion OUTSIDE bwrb: status=done written directly, no `next`.
    const taskPath = join(vaultDir, 'tasks', 'Hand done.md');
    await writeFile(
      taskPath,
      `---
type: task
name: Hand done
status: done
deadline: 2026-07-01
---
`
    );

    const schema = await loadSchema(vaultDir);

    // needsSuccessor predicate matches.
    const fm = await readFrontmatter(taskPath);
    expect(needsSuccessor(schema, 'task', fm)).toBe(true);

    // Audit flags missing-successor.
    const results = await runAudit(schema, vaultDir, { strict: false, vaultDir, schema });
    const taskResult = results.find((r) => r.relativePath.endsWith('Hand done.md'));
    expect(taskResult).toBeDefined();
    expect(taskResult!.issues.some((i) => i.code === 'missing-successor')).toBe(true);

    // --fix spawns the missing successor (identical to fast path).
    const summary = await runAutoFix(results, schema, vaultDir, { dryRun: false });
    expect(summary.fixed).toBeGreaterThan(0);

    const tasks = await listTasks(vaultDir);
    expect(tasks).toHaveLength(2);
    const successorName = tasks.find((f) => f !== 'Hand done.md')!;
    const succFm = await readFrontmatter(join(vaultDir, 'tasks', successorName));
    expect(succFm['deadline']).toBe('2026-07-08'); // same offset as fast path
    expect(succFm['status']).not.toBe('done');

    // Predecessor now has a `next` → re-auditing flags nothing (idempotent).
    const results2 = await runAudit(schema, vaultDir, { strict: false, vaultDir, schema });
    const taskResult2 = results2.find((r) => r.relativePath.endsWith('Hand done.md'));
    expect(taskResult2?.issues.some((i) => i.code === 'missing-successor') ?? false).toBe(false);
  });

  it('backstop spawn writes a CLEAN, symmetric next/prev; audit clean; --fix converges (#107 blocker 1)', async () => {
    const taskPath = join(vaultDir, 'tasks', 'Backstop clean.md');
    await writeFile(
      taskPath,
      `---
type: task
name: Backstop clean
status: done
deadline: 2026-08-01
---
`
    );
    const schema = await loadSchema(vaultDir);

    const results = await runAudit(schema, vaultDir, { strict: false, vaultDir, schema });
    await runAutoFix(results, schema, vaultDir, { dryRun: false });

    const tasks = await listTasks(vaultDir);
    expect(tasks).toHaveLength(2);
    const successorName = tasks.find((f) => f !== 'Backstop clean.md')!;
    const succPath = join(vaultDir, 'tasks', successorName);

    const rawNext = await rawFieldLine(taskPath, 'next');
    expect(rawNext.startsWith("'")).toBe(false);
    expect(rawNext).not.toContain('\\"');
    expect(rawNext).toMatch(/^"\[\[[^"\\]+\]\]"$/);
    const nextValue = String((await readFrontmatter(taskPath))['next']);
    expect(nextValue).not.toContain('"');

    const rawPrev = await rawFieldLine(succPath, 'prev');
    expect(rawPrev).toMatch(/^"\[\[[^"\\]+\]\]"$/);

    // Audit clean post-spawn (no format-violation), and --fix converges.
    const after = await runAudit(schema, vaultDir, { strict: false, vaultDir, schema });
    expect(after.flatMap((r) => r.issues).some((i) => i.code === 'format-violation')).toBe(false);

    const r2 = await runAudit(schema, vaultDir, { strict: false, vaultDir, schema });
    const summary2 = await runAutoFix(r2, schema, vaultDir, { dryRun: false });
    expect(summary2.fixed).toBe(0);
  });

  it('fast path and backstop produce the SAME successor deadline', async () => {
    // Fast path
    const fastPath = join(vaultDir, 'tasks', 'Fast.md');
    await writeFile(
      fastPath,
      `---
type: task
name: Fast
status: doing
deadline: 2026-09-01
---
`
    );
    const schema = await loadSchema(vaultDir);
    await editNoteFromJson(schema, vaultDir, fastPath, JSON.stringify({ status: 'done' }), {
      jsonMode: false,
    });
    const fastTasks = await listTasks(vaultDir);
    const fastSucc = fastTasks.find((f) => f !== 'Fast.md')!;
    const fastDeadline = (await readFrontmatter(join(vaultDir, 'tasks', fastSucc)))['deadline'];

    // Backstop on an identical predecessor
    const handPath = join(vaultDir, 'tasks', 'Hand.md');
    await writeFile(
      handPath,
      `---
type: task
name: Hand
status: done
deadline: 2026-09-01
---
`
    );
    const results = await runAudit(schema, vaultDir, { strict: false, vaultDir, schema });
    await runAutoFix(results, schema, vaultDir, { dryRun: false });
    const allTasks = await listTasks(vaultDir);
    const handSucc = allTasks.find(
      (f) => f !== 'Fast.md' && f !== 'Hand.md' && f !== fastSucc
    )!;
    const handDeadline = (await readFrontmatter(join(vaultDir, 'tasks', handSucc)))['deadline'];

    expect(handDeadline).toBe(fastDeadline);
    expect(handDeadline).toBe('2026-09-08');
  });

  it('does not spawn duplicates on a second --fix run (idempotent backstop)', async () => {
    const taskPath = join(vaultDir, 'tasks', 'Once.md');
    await writeFile(
      taskPath,
      `---
type: task
name: Once
status: done
deadline: 2026-10-01
---
`
    );
    const schema = await loadSchema(vaultDir);

    const r1 = await runAudit(schema, vaultDir, { strict: false, vaultDir, schema });
    await runAutoFix(r1, schema, vaultDir, { dryRun: false });
    expect(await listTasks(vaultDir)).toHaveLength(2);

    const r2 = await runAudit(schema, vaultDir, { strict: false, vaultDir, schema });
    await runAutoFix(r2, schema, vaultDir, { dryRun: false });
    expect(await listTasks(vaultDir)).toHaveLength(2);
  });
});

describe('recurrence: invalid-recurrence audit', () => {
  let vaultDir: string;
  afterEach(async () => {
    if (vaultDir) await rm(vaultDir, { recursive: true, force: true });
  });

  it('flags a missing successor template as a config error', async () => {
    const schemaWithNamedTemplate: Schema = JSON.parse(JSON.stringify(RECURRING_SCHEMA));
    schemaWithNamedTemplate.traits!.recurring!.recurrence!.template = 'does-not-exist';
    vaultDir = await setupVault(schemaWithNamedTemplate);
    await mkdir(join(vaultDir, 'tasks'), { recursive: true });
    await writeFile(
      join(vaultDir, 'tasks', 'T.md'),
      `---
type: task
name: T
status: todo
deadline: 2026-01-01
---
`
    );
    const schema = await loadSchema(vaultDir);
    const results = await runAudit(schema, vaultDir, { strict: false, vaultDir, schema });
    const issues = results.flatMap((r) => r.issues);
    expect(issues.some((i) => i.code === 'invalid-recurrence')).toBe(true);
  });
});

describe('recurrence: atomic spawn failure (#107 blocker 2)', () => {
  let vaultDir: string;
  afterEach(async () => {
    if (vaultDir) await rm(vaultDir, { recursive: true, force: true });
  });

  it('missing template: predecessor stays UNMUTATED and the real error surfaces', async () => {
    const schemaWithNamedTemplate: Schema = JSON.parse(JSON.stringify(RECURRING_SCHEMA));
    schemaWithNamedTemplate.traits!.recurring!.recurrence!.template = 'does-not-exist';
    vaultDir = await setupVault(schemaWithNamedTemplate);
    await mkdir(join(vaultDir, 'tasks'), { recursive: true });

    const taskPath = join(vaultDir, 'tasks', 'Atomic.md');
    await writeFile(
      taskPath,
      `---
type: task
name: Atomic
status: doing
deadline: 2026-03-01
---
`
    );
    const schema = await loadSchema(vaultDir);

    // Completing must throw the real error...
    await expect(
      editNoteFromJson(schema, vaultDir, taskPath, JSON.stringify({ status: 'done' }), {
        jsonMode: false,
      })
    ).rejects.toThrow(/does-not-exist|was not found/);

    // ...and must NOT have mutated the predecessor (still doing, no `next`).
    const fm = await readFrontmatter(taskPath);
    expect(fm['status']).toBe('doing');
    expect(fm['next'] ?? '').toBe('');

    // No successor was created.
    expect(await listTasks(vaultDir)).toEqual(['Atomic.md']);
  });

  it('partial-date offset base: clear deterministic error, predecessor unmutated', async () => {
    // deadline granularity = month, so "2026-03" is a valid value that cannot be
    // offset by "deadline + 7d".
    const partialSchema: Schema = JSON.parse(JSON.stringify(RECURRING_SCHEMA));
    partialSchema.types!.task!.fields!.deadline = { prompt: 'date', granularity: 'month' };
    vaultDir = await setupVault(partialSchema);
    await writeDefaultTaskTemplate(vaultDir);
    await mkdir(join(vaultDir, 'tasks'), { recursive: true });

    const taskPath = join(vaultDir, 'tasks', 'PartialBase.md');
    await writeFile(
      taskPath,
      `---
type: task
name: PartialBase
status: doing
deadline: 2026-03
---
`
    );
    const schema = await loadSchema(vaultDir);

    await expect(
      editNoteFromJson(schema, vaultDir, taskPath, JSON.stringify({ status: 'done' }), {
        jsonMode: false,
      })
    ).rejects.toThrow(/Cannot compute recurrence offset.*partial date|partial date.*cannot be offset/i);

    const fm = await readFrontmatter(taskPath);
    expect(fm['status']).toBe('doing');
    expect(fm['next'] ?? '').toBe('');
    expect(await listTasks(vaultDir)).toEqual(['PartialBase.md']);
  });
});

describe('recurrence: back-compat (non-recurring type)', () => {
  let vaultDir: string;
  beforeEach(async () => {
    vaultDir = await setupVault(PLAIN_SCHEMA);
    await mkdir(join(vaultDir, 'notes'), { recursive: true });
  });
  afterEach(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  it('completing a non-recurring note never spawns anything', async () => {
    const notePath = join(vaultDir, 'notes', 'Plain.md');
    await writeFile(
      notePath,
      `---
type: note
name: Plain
status: open
---
`
    );
    const schema = await loadSchema(vaultDir);
    await editNoteFromJson(schema, vaultDir, notePath, JSON.stringify({ status: 'done' }), {
      jsonMode: false,
    });
    const notes = (await readdir(join(vaultDir, 'notes'))).filter((f) => f.endsWith('.md'));
    expect(notes).toHaveLength(1);

    // Audit raises no recurrence issues.
    const results = await runAudit(schema, vaultDir, { strict: false, vaultDir, schema });
    const issues = results.flatMap((r) => r.issues);
    expect(issues.some((i) => i.code === 'missing-successor')).toBe(false);
    expect(issues.some((i) => i.code === 'invalid-recurrence')).toBe(false);
  });
});

describe('recurrence: multi-spawn template (#630)', () => {
  let vaultDir: string;
  afterEach(async () => {
    if (vaultDir) await rm(vaultDir, { recursive: true, force: true });
  });

  it('files staggered instances in the CHILD type output_dir and audits clean', async () => {
    // A `project` parent type whose default template scaffolds 4 staggered tasks.
    // The child `task` type has a DIFFERENT output_dir than the parent — so the
    // instances must land in `tasks/`, not `projects/` (the deferred #630 half).
    const schema: Schema = {
      version: 2,
      types: {
        project: {
          output_dir: 'projects',
          fields: {
            name: { prompt: 'text', required: true },
          },
        },
        task: {
          output_dir: 'tasks',
          fields: {
            name: { prompt: 'text', required: true },
            deadline: { prompt: 'date' },
            status: { prompt: 'select', options: ['todo', 'done'], default: 'todo' },
          },
        },
      },
    };
    vaultDir = await setupVault(schema);

    // Parent template with staggered instances (date expressions via #603). The
    // `defaults` use the child type's REAL field (`name`), not `title`.
    const projTplDir = join(vaultDir, '.bwrb', 'templates', 'project');
    await mkdir(projTplDir, { recursive: true });
    await writeFile(
      join(projTplDir, 'write-an-article.md'),
      `---
type: template
template-for: project
instances:
  - { type: task, defaults: { name: "Outline", deadline: "@today+1d" } }
  - { type: task, defaults: { name: "Draft",   deadline: "@today+3d" } }
  - { type: task, defaults: { name: "Edit",    deadline: "@today+5d" } }
  - { type: task, defaults: { name: "Publish", deadline: "@today+7d" } }
---

# {name}
`
    );

    const loaded = await loadSchema(vaultDir);
    const tpl = await import('../../../src/lib/template.js').then((m) =>
      m.findTemplateByName(vaultDir, 'project', 'write-an-article')
    );
    expect(tpl).not.toBeNull();

    await createNoteFromJson(
      loaded,
      vaultDir,
      'project',
      JSON.stringify({ name: 'My Article' }),
      tpl
    );

    // The parent's directory holds ONLY the project note — no task instances.
    const projectFiles = (await readdir(join(vaultDir, 'projects')))
      .filter((f) => f.endsWith('.md'))
      .sort();
    expect(projectFiles).toEqual(['My Article.md']);

    // The 4 task instances are filed in the CHILD type's output_dir (`tasks/`),
    // each a distinct, disambiguated file (no `task.md` collapse — #630).
    const instanceFiles = await listTasks(vaultDir);
    expect(instanceFiles).toEqual(['Draft.md', 'Edit.md', 'Outline.md', 'Publish.md'].sort());

    // Deadlines are staggered (4 distinct values).
    const deadlines = new Set<string>();
    for (const f of instanceFiles) {
      const fm = await readFrontmatter(join(vaultDir, 'tasks', f));
      deadlines.add(String(fm['deadline']));
    }
    expect(deadlines.size).toBe(4);

    // `bwrb audit` is clean: no wrong-directory (correct output_dir), no
    // unknown-field/missing-required (correct child field `name`).
    const results = await runAudit(loaded, vaultDir, { strict: false, vaultDir, schema: loaded });
    const issues = results.flatMap((r) => r.issues);
    expect(issues.some((i) => i.code === 'wrong-directory')).toBe(false);
    expect(issues.some((i) => i.code === 'unknown-field')).toBe(false);
    expect(issues.some((i) => i.code === 'missing-required')).toBe(false);
  });
});
