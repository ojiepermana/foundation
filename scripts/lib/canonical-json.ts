// Canonical JSON text for build artifacts such as openapi.json (spec 0008, AC-2).
// Keys come from Object.keys(value).sort(), which compares UTF-16 code units and never the locale.
// The text is written straight from that sorted key array: a rebuilt object would always put
// integer keys such as "9" and "10" first, so JSON.stringify on it cannot keep code unit order.
// Layout matches JSON.stringify(value, null, 2), array order is kept, and the text ends with one newline.
export function canonicalJson(value: unknown): string {
  return write(value, '') + '\n';
}

function write(value: unknown, indent: string): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalJson accepts JSON values only');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const inner = indent + '  ';
    return `[\n${Array.from(value, item => inner + write(item, inner)).join(',\n')}\n${indent}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.length === 0) return '{}';
    const inner = indent + '  ';
    return `{\n${keys.map(key => `${inner}${JSON.stringify(key)}: ${write(record[key], inner)}`).join(',\n')}\n${indent}}`;
  }
  throw new TypeError('canonicalJson accepts JSON values only');
}
