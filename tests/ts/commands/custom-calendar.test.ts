import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { runCLI, TEST_SCHEMA } from '../fixtures/setup.js';

describe('custom calendars', () => {
  let vaultDir: string;

  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), 'bwrb-custom-calendar-'));
    await mkdir(join(vaultDir, '.bwrb'), { recursive: true });
    await mkdir(join(vaultDir, 'Events'), { recursive: true });
    await writeFile(
      join(vaultDir, '.bwrb', 'schema.json'),
      JSON.stringify(calendarSchema(), null, 2)
    );
  });

  afterEach(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  it('sorts and filters calendar dates by linear hours and emits JSON metadata', async () => {
    await writeEvent('Future', { when: 'AR 3019-09-02 266:50' });
    await writeEvent('Early AR', { when: 'AR 960-06-01' });
    await writeEvent('Old BH', { when: 'BH 12-01-01' });

    const sorted = await runCLI(['list', 'event', '--sort', 'when', '--output', 'json'], vaultDir);
    expect(sorted.exitCode).toBe(0);
    const rows = JSON.parse(sorted.stdout) as Array<{
      _name: string;
      when: { value: string; calendar: string; linear: number };
    }>;
    expect(rows.map((row) => row._name)).toEqual(['Old BH', 'Early AR', 'Future']);
    expect(rows[0]!.when.value).toBe('BH 12-01-01');
    expect(rows[0]!.when.calendar).toBe('tmi');
    expect(rows[0]!.when.linear).toBeLessThan(0);
    expect(rows[2]!.when.value).toBe('AR 3019-09-02 266:50');

    const filtered = await runCLI(
      ['list', 'event', '--where', "when > 'AR 1000-01-01'", '--output', 'json'],
      vaultDir
    );
    expect(filtered.exitCode).toBe(0);
    const filteredRows = JSON.parse(filtered.stdout) as Array<{ _name: string }>;
    expect(filteredRows.map((row) => row._name)).toEqual(['Future']);
  });

  it('validates calendar ranges during creation and audit', async () => {
    const created = await runCLI(
      [
        'new',
        'event',
        '--no-template',
        '--json',
        JSON.stringify({ name: 'Bad', when: 'AR 3019-14-01' }),
      ],
      vaultDir
    );
    expect(created.exitCode).not.toBe(0);
    expect(created.stdout + created.stderr).toContain('month');
    expect(created.stdout + created.stderr).toContain('1-12');

    await writeEvent('Hand Edited', { when: 'AR 3019-14-01' });
    const audit = await runCLI(['audit', 'event', '--output', 'json'], vaultDir);
    expect(audit.exitCode).not.toBe(0);
    const output = JSON.parse(audit.stdout) as {
      files: Array<{ issues: Array<{ code: string; message: string }> }>;
    };
    const issue = output.files.flatMap((file) => file.issues).find((item) => item.code === 'invalid-date-format');
    expect(issue?.message).toContain('month');
    expect(issue?.message).toContain('1-12');
  });

  it('rejects calendar schemas with more than two eras', async () => {
    const schema = calendarSchema();
    const calendars = (schema.config as { calendars: Record<string, { eras: unknown[] }> }).calendars;
    calendars.tmi!.eras = [
      { name: 'Before Humans', shortName: 'BH', backwards: true },
      { name: 'After Humans', shortName: 'AR' },
      { name: 'Far Future', shortName: 'FF' },
    ];
    await writeFile(join(vaultDir, '.bwrb', 'schema.json'), JSON.stringify(schema, null, 2));

    const rejected = await runCLI(['list', 'event'], vaultDir);
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.stderr + rejected.stdout).toContain(
      'Custom calendar eras support at most 2 eras'
    );
  });

  it('applies type-level calendar_default to date fields', async () => {
    await writeEvent('Defaulted', { inherited_when: 'AR 1-01-01' });
    const listed = await runCLI(['list', 'event', '--fields', 'inherited_when', '--output', 'json'], vaultDir);
    expect(listed.exitCode).toBe(0);
    const rows = JSON.parse(listed.stdout) as Array<{
      inherited_when: { value: string; calendar: string; linear: number };
    }>;
    expect(rows[0]!.inherited_when).toMatchObject({
      value: 'AR 1-01-01',
      calendar: 'tmi',
      linear: 0,
    });
  });

  it('uses calendar day length for relative-date d offsets and degrades w offsets during list', async () => {
    await writeEvent('Anchor', { when: 'AR 1-01-01' });
    await writeEvent('Plus Hours', {
      position: [{ kind: 'equal', ref: '[[Anchor]]', field: 'when', offset: '340h' }],
    });
    await writeEvent('Plus Days', {
      position: [{ kind: 'equal', ref: '[[Anchor]]', field: 'when', offset: '2d' }],
    });

    const sorted = await runCLI(['list', 'event', '--sort', 'position', '--output', 'json'], vaultDir);
    expect(sorted.exitCode).toBe(0);
    const rows = JSON.parse(sorted.stdout) as Array<{
      _name: string;
      position?: { resolved: string; calendar?: string; linear?: number };
    }>;
    const plusHours = rows.find((row) => row._name === 'Plus Hours')!;
    const plusDays = rows.find((row) => row._name === 'Plus Days')!;
    expect(plusHours.position).toMatchObject({
      resolved: 'AR 1-01-02 4:00',
      calendar: 'tmi',
      linear: 340,
    });
    expect(plusDays.position).toMatchObject({
      resolved: 'AR 1-02-01',
      calendar: 'tmi',
      linear: 672,
    });

    await writeEvent('Bad Week', {
      position: [{ kind: 'equal', ref: '[[Anchor]]', field: 'when', offset: '1w' }],
    });
    const listed = await runCLI(['list', 'event', '--fields', 'position', '--output', 'json'], vaultDir);
    expect(listed.exitCode).toBe(0);
    const listedRows = JSON.parse(listed.stdout) as Array<{
      _name: string;
      position?: { resolved: string | null; resolution: string };
    }>;
    expect(listedRows.map((row) => row._name)).toEqual(
      expect.arrayContaining(['Anchor', 'Plus Hours', 'Plus Days', 'Bad Week'])
    );
    expect(listedRows.find((row) => row._name === 'Bad Week')!.position).toMatchObject({
      resolved: null,
      resolution: 'invalid-offset',
    });

    const textListed = await runCLI(['list', 'event', '--fields', 'position'], vaultDir);
    expect(textListed.exitCode).toBe(0);
    expect(textListed.stdout).toContain('Bad Week');
  });

  it('rejects JSON writes when a relative-date w offset resolves to a calendar chain', async () => {
    await writeEvent('Anchor', { when: 'AR 1-01-01' });

    const created = await runCLI(
      [
        'new',
        'event',
        '--no-template',
        '--json',
        JSON.stringify({
          name: 'Bad Week',
          position: [{ kind: 'equal', ref: '[[Anchor]]', field: 'when', offset: '1w' }],
        }),
      ],
      vaultDir
    );
    expect(created.exitCode).not.toBe(0);
    const createdOutput = JSON.parse(created.stdout) as { errors: Array<{ message: string }> };
    expect(createdOutput.errors[0]!.message).toContain('unsupported calendar offset unit "w"');

    await writeEvent('Editable', { position: [{ kind: 'equal', ref: '[[Anchor]]', field: 'when', offset: '1d' }] });
    const edited = await runCLI(
      [
        'edit',
        'Editable',
        '--json',
        JSON.stringify({
          position: [{ kind: 'equal', ref: '[[Anchor]]', field: 'when', offset: '1w' }],
        }),
      ],
      vaultDir
    );
    expect(edited.exitCode).not.toBe(0);
    const editedOutput = JSON.parse(edited.stdout) as { errors: Array<{ message: string }> };
    expect(editedOutput.errors[0]!.message).toContain('unsupported calendar offset unit "w"');

    const unresolved = await runCLI(
      [
        'new',
        'event',
        '--no-template',
        '--json',
        JSON.stringify({
          name: 'Lazy Bad Week',
          position: [{ kind: 'equal', ref: '[[Missing Anchor]]', field: 'when', offset: '1w' }],
        }),
      ],
      vaultDir
    );
    expect(unresolved.exitCode).toBe(0);
  });

  it('carries rounded calendar minutes across the day boundary', async () => {
    await writeEvent('Anchor', { when: 'AR 1-01-01' });
    await writeEvent('Boundary', {
      position: [
        {
          kind: 'equal',
          ref: '[[Anchor]]',
          field: 'when',
          offset: { amount: 20159.9994, unit: 'min' },
        },
      ],
    });

    const listed = await runCLI(['list', 'event', '--fields', 'position', '--output', 'json'], vaultDir);
    expect(listed.exitCode).toBe(0);
    const rows = JSON.parse(listed.stdout) as Array<{
      _name: string;
      position?: { resolved: string; calendar?: string; linear?: number };
    }>;
    const boundary = rows.find((row) => row._name === 'Boundary')!;
    expect(boundary.position).toMatchObject({
      resolved: 'AR 1-01-02',
      calendar: 'tmi',
    });
    expect(boundary.position?.linear).toBeCloseTo(335.99999, 5);
  });

  async function writeEvent(
    name: string,
    fields: { when?: string; inherited_when?: string; position?: unknown }
  ): Promise<void> {
    const lines = ['---', 'type: event', `name: ${JSON.stringify(name)}`];
    if (fields.when) lines.push(`when: ${JSON.stringify(fields.when)}`);
    if (fields.inherited_when) lines.push(`inherited_when: ${JSON.stringify(fields.inherited_when)}`);
    if (fields.position !== undefined) {
      lines.push(`position: ${JSON.stringify(fields.position)}`);
    }
    lines.push('---', '');
    await writeFile(join(vaultDir, 'Events', `${name}.md`), lines.join('\n'));
  }
});

function calendarSchema(): Record<string, unknown> {
  return {
    ...TEST_SCHEMA,
    config: {
      ...TEST_SCHEMA.config,
      calendars: {
        tmi: {
          label: 'TMI lunar calendar',
          hoursInDay: 336,
          eras: [
            { name: 'Before Humans', shortName: 'BH', backwards: true },
            { name: 'After Humans', shortName: 'AR' },
          ],
          months: Array.from({ length: 12 }, (_, index) => ({
            name: `Month ${index + 1}`,
            shortName: `M${index + 1}`,
            days: 2,
          })),
        },
      },
    },
    types: {
      ...TEST_SCHEMA.types,
      event: {
        output_dir: 'Events',
        filename: '{name}',
        calendar_default: 'tmi',
        fields: {
          name: { prompt: 'text', required: true },
          when: { prompt: 'date', calendar: 'tmi' },
          inherited_when: { prompt: 'date' },
          position: { prompt: 'relative-date', source: 'event' },
        },
      },
    },
  };
}
