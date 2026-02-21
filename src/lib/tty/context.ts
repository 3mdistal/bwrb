export interface TtyContext {
  isTTY: boolean;
  width?: number;
  colorEnabled: boolean;
}

const DEFAULT_TTY_WIDTH = 80;

function parseWidthOverride(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return undefined;
  const rounded = Math.floor(parsed);
  if (rounded <= 0) return undefined;
  return rounded;
}

export function getTtyContext(): TtyContext {
  const isTTY = Boolean(process.stdout.isTTY);
  const colorEnabled = isTTY;

  if (!isTTY) {
    return {
      isTTY,
      colorEnabled,
    };
  }

  const override = parseWidthOverride(process.env['BWRB_TERM_WIDTH']);
  const columns = process.stdout.columns;
  const width = override ?? (typeof columns === 'number' && columns > 0 ? columns : DEFAULT_TTY_WIDTH);

  return {
    isTTY,
    width,
    colorEnabled,
  };
}
