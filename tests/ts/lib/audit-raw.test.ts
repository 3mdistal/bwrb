import { describe, it, expect } from 'vitest';
import { splitLinesPreserveEol } from '../../../src/lib/audit/raw.js';

function assertReconstruction(input: string): void {
  const lines = splitLinesPreserveEol(input);
  const roundTripped = lines.map((line) => line.text + line.eol).join('');
  expect(roundTripped).toBe(input);
}

function assertMonotonicOffsets(input: string): void {
  const lines = splitLinesPreserveEol(input);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    expect(line.startOffset).toBeLessThanOrEqual(line.endOffset);
    expect(line.lineNumber).toBe(i + 1);

    if (i > 0) {
      const prev = lines[i - 1]!;
      expect(line.startOffset).toBe(prev.endOffset + prev.eol.length);
    }
  }
}

describe('splitLinesPreserveEol', () => {
  it('handles empty input', () => {
    const lines = splitLinesPreserveEol('');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      text: '',
      eol: '',
      lineNumber: 1,
      startOffset: 0,
      endOffset: 0,
    });
    assertReconstruction('');
    assertMonotonicOffsets('');
  });

  it('handles input without a terminal newline', () => {
    const input = 'alpha\nbeta';
    const lines = splitLinesPreserveEol(input);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ text: 'alpha', eol: '\n', lineNumber: 1, startOffset: 0, endOffset: 5 });
    expect(lines[1]).toMatchObject({ text: 'beta', eol: '', lineNumber: 2, startOffset: 6, endOffset: 10 });
    assertReconstruction(input);
    assertMonotonicOffsets(input);
  });

  it('handles input with a trailing newline', () => {
    const input = 'alpha\n';
    const lines = splitLinesPreserveEol(input);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ text: 'alpha', eol: '\n', lineNumber: 1, startOffset: 0, endOffset: 5 });
    expect(lines[1]).toMatchObject({ text: '', eol: '', lineNumber: 2, startOffset: 6, endOffset: 6 });
    assertReconstruction(input);
    assertMonotonicOffsets(input);
  });

  it('handles consecutive blank lines', () => {
    const input = 'a\n\n\n';
    const lines = splitLinesPreserveEol(input);

    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatchObject({ text: 'a', eol: '\n' });
    expect(lines[1]).toMatchObject({ text: '', eol: '\n' });
    expect(lines[2]).toMatchObject({ text: '', eol: '\n' });
    expect(lines[3]).toMatchObject({ text: '', eol: '' });
    assertReconstruction(input);
    assertMonotonicOffsets(input);
  });

  it('preserves LF and CRLF line endings', () => {
    const lfInput = 'a\nb\n';
    const crlfInput = 'a\r\nb\r\n';

    const lfLines = splitLinesPreserveEol(lfInput);
    const crlfLines = splitLinesPreserveEol(crlfInput);

    expect(lfLines.map((line) => line.eol)).toEqual(['\n', '\n', '']);
    expect(crlfLines.map((line) => line.eol)).toEqual(['\r\n', '\r\n', '']);
    assertReconstruction(lfInput);
    assertReconstruction(crlfInput);
    assertMonotonicOffsets(lfInput);
    assertMonotonicOffsets(crlfInput);
  });

  it('preserves mixed EOL styles and lone CR', () => {
    const input = 'a\r\nb\nc\rd';
    const lines = splitLinesPreserveEol(input);

    expect(lines.map((line) => ({ text: line.text, eol: line.eol }))).toEqual([
      { text: 'a', eol: '\r\n' },
      { text: 'b', eol: '\n' },
      { text: 'c', eol: '\r' },
      { text: 'd', eol: '' },
    ]);
    assertReconstruction(input);
    assertMonotonicOffsets(input);
  });
});
