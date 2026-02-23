import { padAnsi, truncateAnsi, type TextAlign, visibleWidth, wrapAnsi } from './layout.js';
import type { TtyContext } from './context.js';

const COLUMN_GAP = '  ';

export interface TableColumn {
  key: string;
  title: string;
  minWidth?: number;
  maxWidth?: number;
  weight?: number;
  priority?: number;
  align?: TextAlign;
  mode?: 'truncate' | 'wrap';
  canDrop?: boolean;
  style?: (text: string) => string;
}

export interface RenderTableOptions {
  columns: TableColumn[];
  rows: Array<Record<string, string>>;
  context: TtyContext;
}

interface WorkingColumn {
  index: number;
  key: string;
  title: string;
  width: number;
  minWidth: number;
  maxWidth: number;
  weight: number;
  priority: number;
  align: TextAlign;
  mode: 'truncate' | 'wrap';
  canDrop: boolean;
  style?: (text: string) => string;
}

function getCellValue(row: Record<string, string>, key: string): string {
  const value = row[key];
  return value ?? '';
}

function computeNaturalWidth(column: TableColumn, rows: Array<Record<string, string>>): number {
  let width = visibleWidth(column.title);
  for (const row of rows) {
    const value = getCellValue(row, column.key);
    width = Math.max(width, visibleWidth(value));
  }
  return width;
}

function totalWidth(columns: WorkingColumn[]): number {
  if (columns.length === 0) return 0;
  const content = columns.reduce((sum, col) => sum + col.width, 0);
  const gaps = (columns.length - 1) * visibleWidth(COLUMN_GAP);
  return content + gaps;
}

function shrinkColumns(columns: WorkingColumn[], maxWidth: number): void {
  while (totalWidth(columns) > maxWidth) {
    const shrinkable = columns
      .filter(col => col.width > col.minWidth)
      .sort((a, b) => {
        if (a.priority !== b.priority) return b.priority - a.priority;
        return b.index - a.index;
      });

    if (shrinkable.length === 0) {
      break;
    }

    const next = shrinkable[0]!;
    next.width -= 1;
  }
}

function dropColumns(columns: WorkingColumn[], maxWidth: number): WorkingColumn[] {
  let active = [...columns];

  while (active.length > 1 && totalWidth(active) > maxWidth) {
    const droppable = active
      .filter(col => col.canDrop)
      .sort((a, b) => {
        if (a.priority !== b.priority) return b.priority - a.priority;
        return b.index - a.index;
      });

    if (droppable.length === 0) {
      break;
    }

    const toDrop = droppable[0]!;
    active = active.filter(col => col.index !== toDrop.index);
  }

  return active;
}

function distributeExtra(columns: WorkingColumn[], maxWidth: number): void {
  let remaining = maxWidth - totalWidth(columns);
  if (remaining <= 0) return;

  while (remaining > 0) {
    const growable = columns.filter(col => col.width < col.maxWidth);
    if (growable.length === 0) break;

    const totalWeight = growable.reduce((sum, col) => sum + col.weight, 0);
    let grew = 0;

    for (const col of growable) {
      if (remaining <= 0) break;
      const slice = Math.max(1, Math.floor((remaining * col.weight) / Math.max(1, totalWeight)));
      const room = col.maxWidth - col.width;
      const inc = Math.min(room, slice, remaining);
      if (inc > 0) {
        col.width += inc;
        remaining -= inc;
        grew += inc;
      }
    }

    if (grew === 0) {
      break;
    }
  }
}

function buildColumns(columns: TableColumn[], rows: Array<Record<string, string>>): WorkingColumn[] {
  return columns.map((column, index) => {
    const natural = computeNaturalWidth(column, rows);
    const minWidth = Math.max(1, column.minWidth ?? 1);
    const maxWidth = Math.max(minWidth, column.maxWidth ?? Number.MAX_SAFE_INTEGER);
    const initial = Math.min(maxWidth, Math.max(minWidth, natural));
    const working: WorkingColumn = {
      index,
      key: column.key,
      title: column.title,
      width: initial,
      minWidth,
      maxWidth,
      weight: Math.max(1, column.weight ?? 1),
      priority: column.priority ?? 0,
      align: column.align ?? 'left',
      mode: column.mode ?? 'truncate',
      canDrop: column.canDrop ?? false,
    };

    if (column.style) {
      working.style = column.style;
    }

    return working;
  });
}

function formatCell(value: string, column: WorkingColumn): string[] {
  if (column.mode === 'wrap') {
    const wrapped = wrapAnsi(value, column.width, { breakWords: false });
    return wrapped.length > 0 ? wrapped.map(line => padAnsi(line, column.width, column.align)) : [padAnsi('', column.width, column.align)];
  }
  const truncated = truncateAnsi(value, column.width, { ellipsis: '...' });
  return [padAnsi(truncated, column.width, column.align)];
}

export function renderTable({ columns, rows, context }: RenderTableOptions): string[] {
  if (!context.isTTY) {
    const header = columns.map(col => col.title).join('\t');
    const lines = [header];
    for (const row of rows) {
      lines.push(columns.map(col => getCellValue(row, col.key)).join('\t'));
    }
    return lines;
  }

  const maxWidth = context.width ?? 80;
  let active = buildColumns(columns, rows);
  active = dropColumns(active, maxWidth);
  shrinkColumns(active, maxWidth);
  distributeExtra(active, maxWidth);
  shrinkColumns(active, maxWidth);

  const lines: string[] = [];
  const header = active
    .map(col => {
      const text = padAnsi(truncateAnsi(col.title, col.width, { ellipsis: '...' }), col.width, col.align);
      return col.style ? col.style(text) : text;
    })
    .join(COLUMN_GAP);
  lines.push(header);

  for (const row of rows) {
    const perColumn = active.map(col => {
      const value = getCellValue(row, col.key);
      return formatCell(value, col);
    });
    const rowHeight = perColumn.reduce((max, parts) => Math.max(max, parts.length), 1);

    for (let lineIndex = 0; lineIndex < rowHeight; lineIndex++) {
      const line = active
        .map((col, colIndex) => {
          const part = perColumn[colIndex]![lineIndex] ?? padAnsi('', col.width, col.align);
          return part;
        })
        .join(COLUMN_GAP);
      lines.push(line);
    }
  }

  return lines;
}
