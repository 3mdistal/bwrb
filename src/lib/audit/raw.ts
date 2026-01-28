export type RawLine = {
  text: string;
  eol: string;
  lineNumber: number;
  startOffset: number;
  endOffset: number;
};

export function splitLinesPreserveEol(input: string): RawLine[] {
  const lines: RawLine[] = [];
  let start = 0;
  let lineNumber = 1;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch !== '\n' && ch !== '\r') continue;

    const eolStart = i;
    let eol = ch;
    if (ch === '\r' && input[i + 1] === '\n') {
      eol = '\r\n';
      i++;
    }

    lines.push({
      text: input.slice(start, eolStart),
      eol,
      lineNumber,
      startOffset: start,
      endOffset: eolStart,
    });

    start = i + 1;
    lineNumber++;
  }

  lines.push({
    text: input.slice(start),
    eol: '',
    lineNumber,
    startOffset: start,
    endOffset: input.length,
  });

  return lines;
}

export function parseSimpleYamlKeyValueLine(
  line: string
): { indent: number; key: string; rest: string } | null {
  const match = line.match(/^([ \t]*)([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
  if (!match) return null;

  return {
    indent: match[1]!.length,
    key: match[2]!,
    rest: match[3]!,
  };
}

export function isBlockScalarHeader(restTrimStart: string): boolean {
  return /^[>|](?:[1-9])?(?:[+-])?\s*(#.*)?$/.test(restTrimStart);
}
