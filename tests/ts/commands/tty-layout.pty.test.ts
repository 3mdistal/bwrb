import { describe, it, expect, afterEach } from 'vitest';
import {
  withTempVault,
  shouldSkipPtyTests,
  killAllPtyProcesses,
  type TempVaultFile,
  visibleWidth,
} from '../lib/pty-helpers.js';

const describePty = shouldSkipPtyTests() ? describe.skip : describe;

const NARROW_COLS = 40;

function assertNoOverflow(lines: string[], cols: number): void {
  for (const line of lines) {
    if (!line.trim()) continue;
    expect(visibleWidth(line), `overflow line: ${JSON.stringify(line)}`).toBeLessThanOrEqual(cols);
  }
}

describePty('tty-aware layout overflow checks', () => {
  afterEach(() => {
    killAllPtyProcesses();
  });

  it('keeps dashboard list within terminal width', async () => {
    const files: TempVaultFile[] = [
      {
        path: '.bwrb/dashboards.json',
        content: JSON.stringify({
          dashboards: {
            'very-long-dashboard-name-for-width-test': {
              type: 'objective/milestone',
              path: 'Projects/Some/Ridiculously/Long/Path/**',
              where: [
                "status == 'active'",
                "priority == 'high'",
              ],
              body: 'super long dashboard body query phrase',
              fields: ['status', 'priority', 'owner', 'estimate'],
            },
          },
        }, null, 2),
      },
    ];

    await withTempVault(
      ['dashboard', 'list'],
      async (proc) => {
        const exitCode = await proc.waitForExit();
        expect(exitCode).toBe(0);
        assertNoOverflow(proc.getLines(), NARROW_COLS);
      },
      { files, cols: NARROW_COLS }
    );
  }, 20000);

  it('keeps template list within terminal width', async () => {
    const files: TempVaultFile[] = [
      {
        path: '.bwrb/templates/idea/long-template-name-for-testing.md',
        content: `---
type: template
template-for: idea
description: Template with a very long description that should be truncated for narrow terminals in text mode output
---

# {title}
`,
      },
    ];

    await withTempVault(
      ['template', 'list'],
      async (proc) => {
        const exitCode = await proc.waitForExit();
        expect(exitCode).toBe(0);
        assertNoOverflow(proc.getLines(), NARROW_COLS);
      },
      { files, cols: NARROW_COLS }
    );
  }, 20000);

  it('keeps list --fields output within terminal width', async () => {
    const files: TempVaultFile[] = [
      {
        path: 'Ideas/TTY Width Stress.md',
        content: `---
type: idea
status: this-status-value-is-deliberately-long-to-force-truncation
priority: extraordinarily-high-priority-value-for-layout-testing
---

Body
`,
      },
    ];

    await withTempVault(
      ['list', '--type', 'idea', '--fields', 'status,priority'],
      async (proc) => {
        const exitCode = await proc.waitForExit();
        expect(exitCode).toBe(0);
        assertNoOverflow(proc.getLines(), NARROW_COLS);
      },
      { files, cols: NARROW_COLS }
    );
  }, 20000);

  it('keeps schema list outputs within terminal width', async () => {
    const schema = {
      version: 2,
      types: {
        meta: {},
        objective: {
          output_dir: 'Objectives/With/A/Very/Long/Directory/Path/For/Width/Tests',
          fields: {
            status: {
              prompt: 'select',
              required: true,
              options: ['raw', 'active', 'blocked', 'done', 'deferred', 'someday'],
            },
          },
        },
        milestone: {
          extends: 'objective',
          output_dir: 'Objectives/Milestones/Another/Very/Long/Directory/Name',
          fields: {
            owner: { prompt: 'text', default: 'someone with a very long default name' },
          },
        },
      },
    };

    await withTempVault(
      ['schema', 'list', '--verbose'],
      async (proc) => {
        const exitCode = await proc.waitForExit();
        expect(exitCode).toBe(0);
        assertNoOverflow(proc.getLines(), NARROW_COLS);
      },
      { schema, cols: NARROW_COLS }
    );

    await withTempVault(
      ['schema', 'list', 'type', 'milestone'],
      async (proc) => {
        const exitCode = await proc.waitForExit();
        expect(exitCode).toBe(0);
        assertNoOverflow(proc.getLines(), NARROW_COLS);
      },
      { schema, cols: NARROW_COLS }
    );

    await withTempVault(
      ['schema', 'list', 'fields'],
      async (proc) => {
        const exitCode = await proc.waitForExit();
        expect(exitCode).toBe(0);
        assertNoOverflow(proc.getLines(), NARROW_COLS);
      },
      { schema, cols: NARROW_COLS }
    );
  }, 30000);
});
