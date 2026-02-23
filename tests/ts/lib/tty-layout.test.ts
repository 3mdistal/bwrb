import { describe, it, expect } from 'vitest';
import chalk from 'chalk';
import { truncateAnsi, visibleWidth, wrapAnsi } from '../../../src/lib/tty/layout.js';

describe('tty layout helpers', () => {
  it('truncateAnsi keeps visible width within limit with ANSI text', () => {
    const input = `${chalk.green('Hello')} ${chalk.yellow('world')} from bwrb`;
    const truncated = truncateAnsi(input, 12, { ellipsis: '...' });
    expect(visibleWidth(truncated)).toBeLessThanOrEqual(12);
    expect(truncated).toContain('...');
  });

  it('truncateAnsi handles very narrow widths', () => {
    expect(truncateAnsi('abcdef', 0)).toBe('');
    expect(visibleWidth(truncateAnsi('abcdef', 2))).toBeLessThanOrEqual(2);
  });

  it('wrapAnsi applies hanging indent and preserves width', () => {
    const lines = wrapAnsi(
      'this is a long line of text that should wrap cleanly',
      20,
      { indent: '  key: ', hangingIndent: '       ' }
    );

    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]?.startsWith('  key: ')).toBe(true);
    expect(lines[1]?.startsWith('       ')).toBe(true);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(20);
    }
  });
});
