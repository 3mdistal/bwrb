import sliceAnsi from 'slice-ansi';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';

export type TextAlign = 'left' | 'right';

export interface TruncateOptions {
  ellipsis?: string;
}

export interface WrapOptions {
  indent?: string;
  hangingIndent?: string;
  breakWords?: boolean;
}

export function visibleWidth(text: string): number {
  return stringWidth(stripAnsi(text));
}

export function truncateAnsi(text: string, width: number, options: TruncateOptions = {}): string {
  if (width <= 0) return '';

  const ellipsis = options.ellipsis ?? '...';
  if (visibleWidth(text) <= width) return text;

  const ellipsisWidth = visibleWidth(ellipsis);
  if (width <= ellipsisWidth) {
    return sliceAnsi(ellipsis, 0, width);
  }

  const targetWidth = width - ellipsisWidth;
  let low = 0;
  let high = text.length;
  let best = '';

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = sliceAnsi(text, 0, mid);
    const candidateWidth = visibleWidth(candidate);

    if (candidateWidth <= targetWidth) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best + ellipsis;
}

export function padAnsi(text: string, width: number, align: TextAlign = 'left'): string {
  const current = visibleWidth(text);
  if (current >= width) return text;
  const pad = ' '.repeat(width - current);
  return align === 'right' ? pad + text : text + pad;
}

export function wrapAnsi(text: string, width: number, options: WrapOptions = {}): string[] {
  if (width <= 0) return [];

  const indent = options.indent ?? '';
  const hangingIndent = options.hangingIndent ?? indent;
  const breakWords = options.breakWords ?? false;

  const indentWidth = visibleWidth(indent);
  const hangingWidth = visibleWidth(hangingIndent);
  const firstMax = Math.max(1, width - indentWidth);
  const nextMax = Math.max(1, width - hangingWidth);

  const plain = stripAnsi(text).replace(/\s+/g, ' ').trim();
  if (!plain) {
    return [indent];
  }

  const lines: string[] = [];
  const words = plain.split(' ');
  let currentPrefix = indent;
  let currentMax = firstMax;
  let current = '';

  const flush = (): void => {
    lines.push(currentPrefix + current);
    currentPrefix = hangingIndent;
    currentMax = nextMax;
    current = '';
  };

  for (const word of words) {
    if (!word) continue;

    if (!current) {
      if (visibleWidth(word) <= currentMax) {
        current = word;
        continue;
      }

      if (!breakWords) {
        current = truncateAnsi(word, currentMax, { ellipsis: '...' });
        flush();
        continue;
      }

      let remaining = word;
      while (remaining) {
        const segment = truncateAnsi(remaining, currentMax, { ellipsis: '' });
        current = segment;
        flush();
        remaining = remaining.slice(segment.length);
      }
      continue;
    }

    const candidate = `${current} ${word}`;
    if (visibleWidth(candidate) <= currentMax) {
      current = candidate;
      continue;
    }

    flush();

    if (visibleWidth(word) <= currentMax) {
      current = word;
    } else if (!breakWords) {
      current = truncateAnsi(word, currentMax, { ellipsis: '...' });
      flush();
    } else {
      let remaining = word;
      while (remaining) {
        const segment = truncateAnsi(remaining, currentMax, { ellipsis: '' });
        current = segment;
        flush();
        remaining = remaining.slice(segment.length);
      }
    }
  }

  if (current) {
    flush();
  }

  return lines;
}
