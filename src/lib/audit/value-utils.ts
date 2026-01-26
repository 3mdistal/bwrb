function formatYamlDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function normalizeYamlValue(value: unknown): unknown {
  if (value instanceof Date) {
    return formatYamlDate(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeYamlValue(item));
  }

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      result[key] = normalizeYamlValue(inner);
    }
    return result;
  }

  return value;
}

export function isEffectivelyEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string' && value.trim().length === 0) return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (value instanceof Date) return false;

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.keys(value as Record<string, unknown>).length === 0;
  }

  return false;
}

export function extractYamlNodeValue(node: unknown): unknown {
  if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    const toJson = record['toJSON'];
    if (typeof toJson === 'function') {
      try {
        return normalizeYamlValue((toJson as () => unknown)());
      } catch {
        // Fall through
      }
    }

    if ('value' in record) {
      return normalizeYamlValue(record['value']);
    }
  }

  return normalizeYamlValue(node);
}

export function detectEol(raw: string): '\n' | '\r\n' {
  const index = raw.indexOf('\n');
  if (index > 0 && raw[index - 1] === '\r') {
    return '\r\n';
  }
  return '\n';
}
