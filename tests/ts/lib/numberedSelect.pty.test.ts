/**
 * PTY-based integration tests for NumberedSelectPrompt.
 *
 * These tests spawn real terminal processes to verify interactive behavior
 * that can't be tested with mocked stdin/stdout.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  spawnOvault,
  withOvault,
  Keys,
  TEST_VAULT_PATH,
  stripAnsi,
} from './pty-helpers.js';
import { existsSync } from 'fs';

// Skip PTY tests if running in CI without TTY support
const describePty = process.env.CI && !process.stdout.isTTY
  ? describe.skip
  : describe;

describePty('NumberedSelectPrompt PTY tests', () => {
  beforeAll(() => {
    // Verify test vault exists
    expect(existsSync(TEST_VAULT_PATH)).toBe(true);
  });

  describe('number key selection', () => {
    it('should select immediately on number key press without re-rendering', async () => {
      // This test verifies the fix for ovault-18j:
      // "Numbered select prompt renders repeatedly when selecting options"
      //
      // The bug: pressing a number key caused the options to render again
      // Expected: pressing a number should select immediately (no re-render)
      //
      // Detection strategy: Look for the numbered choice list pattern (e.g., "❯ 1  (skip)")
      // If re-rendering occurs, we'd see this list appear multiple times.
      // The confirmation line "✔ Select milestone: (skip)" is different - it doesn't
      // have the number prefix, so we can distinguish between render and confirmation.

      const proc = spawnOvault(['new', 'objective/task'], {
        cwd: TEST_VAULT_PATH,
      });

      try {
        // Wait for the task name prompt
        await proc.waitFor('Task name', 10000);

        // Enter a task name
        proc.write('Test Task for PTY\r');

        // Wait for the milestone selection prompt
        // This is a dynamic field that uses numberedSelect
        await proc.waitFor('milestone', 10000);

        // Let the prompt fully render
        await new Promise(resolve => setTimeout(resolve, 100));

        // Get output before pressing number key
        const outputBeforeSelect = proc.getOutput();

        // Look for the numbered list pattern "1  (skip)" or "❯ 1  (skip)"
        // This pattern only appears in the rendered choice list, not in the confirmation
        const listPatternBefore = (outputBeforeSelect.match(/1\s+\(skip\)/g) || []).length;
        expect(listPatternBefore).toBe(1);

        // Press "1" to select the first option (skip)
        proc.write('1');

        // Give it time to process the selection
        await new Promise(resolve => setTimeout(resolve, 300));

        // Get output after pressing number key
        const outputAfterSelect = proc.getOutput();

        // The numbered list pattern should still only appear once
        // If re-rendering occurs, we'd see "1  (skip)" appear again
        const listPatternAfter = (outputAfterSelect.match(/1\s+\(skip\)/g) || []).length;

        // Should still be just 1 (no re-render of the list)
        expect(listPatternAfter).toBe(1);

        // The confirmation line "✔ Select milestone: (skip)" should appear
        // Note: confirmation uses ": (skip)" not "1  (skip)"
        expect(outputAfterSelect).toMatch(/✔.*milestone.*\(skip\)/i);

        // Clean up - abort the rest of the prompts
        proc.write(Keys.CTRL_C);

      } finally {
        if (!proc.hasExited()) {
          proc.kill();
        }
      }
    }, 30000);

    it('should show checkmark after number key selection', async () => {
      const proc = spawnOvault(['new', 'objective/task'], {
        cwd: TEST_VAULT_PATH,
      });

      try {
        // Wait for task name prompt
        await proc.waitFor('Task name', 10000);
        proc.write('PTY Test Task\r');

        // Wait for milestone prompt
        await proc.waitFor('milestone', 10000);

        // Press 1 to select first option
        proc.write('1');

        // Wait a moment for selection to process
        await new Promise(resolve => setTimeout(resolve, 300));

        // After selection, we should see a checkmark (✔) in the output
        // indicating successful selection
        const output = proc.getRawOutput();

        // The checkmark might be in ANSI-escaped form
        // ✔ = \u2714 or could be rendered with green color codes
        const hasCheckmark = output.includes('✔') ||
                            output.includes('\u2714') ||
                            output.includes('✓');

        expect(hasCheckmark).toBe(true);

        // Abort remaining prompts
        proc.write(Keys.CTRL_C);

      } finally {
        if (!proc.hasExited()) {
          proc.kill();
        }
      }
    }, 30000);
  });

  describe('Ctrl+C abort', () => {
    it('should abort cleanly on Ctrl+C during selection', async () => {
      const proc = spawnOvault(['new', 'objective/task'], {
        cwd: TEST_VAULT_PATH,
      });

      try {
        // Wait for task name prompt
        await proc.waitFor('Task name', 10000);
        proc.write('Abort Test\r');

        // Wait for milestone prompt (a select prompt)
        await proc.waitFor('milestone', 10000);

        // Press Ctrl+C to abort
        proc.write(Keys.CTRL_C);

        // Wait for process to exit
        const exitCode = await proc.waitForExit(5000);

        // Process should exit (exit code may vary)
        expect(proc.hasExited()).toBe(true);

        // Output should show cancellation message
        const output = proc.getOutput();
        expect(
          output.includes('Cancelled') ||
          output.includes('cancelled') ||
          output.includes('✖')
        ).toBe(true);

      } finally {
        if (!proc.hasExited()) {
          proc.kill();
        }
      }
    }, 30000);
  });

  describe('first render preserves prior output', () => {
    it('should not erase output printed before the prompt', async () => {
      // This test verifies the fix from ovault-h4h description:
      // "on first render, it called clearPrompt() which erased lines
      //  printed BEFORE the prompt started"

      const proc = spawnOvault(['new', 'objective/task'], {
        cwd: TEST_VAULT_PATH,
      });

      try {
        // Wait for initial output (the "=== New objective ===" header)
        await proc.waitFor('New objective', 10000);

        // The header should remain visible throughout the interaction
        // Enter task name
        proc.write('Prior Output Test\r');

        // Wait for milestone prompt
        await proc.waitFor('milestone', 10000);

        // Check that the header is still visible
        const output = proc.getOutput();
        expect(output).toContain('New objective');

        // Also verify "Using template" is still visible
        expect(output).toContain('Using template');

        // Abort
        proc.write(Keys.CTRL_C);

      } finally {
        if (!proc.hasExited()) {
          proc.kill();
        }
      }
    }, 30000);
  });

  describe('arrow key navigation', () => {
    it('should navigate with arrow keys without corrupting display', async () => {
      const proc = spawnOvault(['new', 'objective/task'], {
        cwd: TEST_VAULT_PATH,
      });

      try {
        // Get to milestone prompt
        await proc.waitFor('Task name', 10000);
        proc.write('Navigation Test\r');
        await proc.waitFor('milestone', 10000);

        // Press down arrow a few times
        proc.write(Keys.DOWN);
        await new Promise(resolve => setTimeout(resolve, 100));
        proc.write(Keys.DOWN);
        await new Promise(resolve => setTimeout(resolve, 100));
        proc.write(Keys.UP);
        await new Promise(resolve => setTimeout(resolve, 100));

        // Now select with Enter
        proc.write(Keys.ENTER);
        await new Promise(resolve => setTimeout(resolve, 300));

        // Should see checkmark after selection
        const output = proc.getRawOutput();
        const hasCheckmark = output.includes('✔') ||
                            output.includes('\u2714') ||
                            output.includes('✓');
        expect(hasCheckmark).toBe(true);

        // Abort remaining prompts
        proc.write(Keys.CTRL_C);

      } finally {
        if (!proc.hasExited()) {
          proc.kill();
        }
      }
    }, 30000);

    it('should not re-render excessively during arrow navigation (ovault-18j)', async () => {
      // This test verifies the fix for ovault-18j:
      // Arrow key navigation should use differential updates, only changing
      // the specific lines affected (old selection and new selection),
      // rather than clearing and re-rendering the entire prompt.
      //
      // Fixed behavior: Only update the lines that changed (cursor movement)
      // The hint line should only appear once (in the initial render).

      const proc = spawnOvault(['new', 'objective/task'], {
        cwd: TEST_VAULT_PATH,
      });

      try {
        await proc.waitFor('Task name', 10000);
        proc.write('Arrow Nav Test\r');
        await proc.waitFor('milestone', 10000);

        // Let initial render complete
        await new Promise(resolve => setTimeout(resolve, 100));

        // Count initial renders (should be 1)
        const outputBefore = proc.getOutput();
        const hintCountBefore = (outputBefore.match(/navigate.*Enter confirm/g) || []).length;
        expect(hintCountBefore).toBe(1);

        // Press arrow keys
        proc.write(Keys.DOWN);
        await new Promise(resolve => setTimeout(resolve, 100));
        proc.write(Keys.DOWN);
        await new Promise(resolve => setTimeout(resolve, 100));

        const outputAfter = proc.getOutput();
        const hintCountAfter = (outputAfter.match(/navigate.*Enter confirm/g) || []).length;

        // FIXED: With differential updates, the hint line is not re-rendered
        // It should still be exactly 1 (the initial render only)
        expect(hintCountAfter).toBe(1);

        proc.write(Keys.CTRL_C);

      } finally {
        if (!proc.hasExited()) {
          proc.kill();
        }
      }
    }, 30000);
  });
});
