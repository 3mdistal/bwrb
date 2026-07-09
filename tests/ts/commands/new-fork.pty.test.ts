import { describe, expect, it } from 'vitest';
import {
  Keys,
  readVaultFile,
  shouldSkipPtyTests,
  vaultFileExists,
  withTempVault,
} from '../lib/pty-helpers.js';

const describePty = shouldSkipPtyTests() ? describe.skip : describe;

describePty('new --fork interactive naming', () => {
  it('offers the source-derived default and creates it on Enter', async () => {
    await withTempVault(
      ['new', '--fork', 'Source'],
      async (proc, vaultPath) => {
        await proc.waitFor('Fork name:', 10_000);
        await proc.waitFor('Source (fork)', 5_000);
        proc.write(Keys.ENTER);
        await proc.waitFor('Created fork: Ideas/Source (fork).md', 10_000);

        expect(await vaultFileExists(vaultPath, 'Ideas/Source (fork).md')).toBe(true);
        const content = await readVaultFile(vaultPath, 'Ideas/Source (fork).md');
        expect(content).toContain('name: Source (fork)');
        expect(content).toContain('forked-from: 11111111-1111-4111-8111-111111111111');
      },
      {
        schema: {
          version: 2,
          types: {
            idea: {
              output_dir: 'Ideas',
              fields: {
                type: { value: 'idea' },
                status: { prompt: 'select', options: ['raw'], default: 'raw' },
              },
              field_order: ['type', 'status'],
            },
          },
        },
        files: [{
          path: 'Ideas/Source.md',
          content: `---
type: idea
id: 11111111-1111-4111-8111-111111111111
name: Source
status: raw
---
Original body
`,
        }],
      }
    );
  }, 30_000);
});
