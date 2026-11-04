/**
 * The reference's JSON spellings, for the two places the transport layer prints a record reading: the
 * compact one-line form (a list or one object on a single line, `", "` between items and `": "` after
 * a key) and the two-space indented form.
 *
 * The engine hands back plain values with the key order already fixed, so the spelling is the only
 * thing left to get right: the same bytes as the reference tool's own dumps.
 */

/** One value in the reference's compact spelling (the default `json.dumps` separators). */
export function pyCompact(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (Array.isArray(value)) return `[${value.map(pyCompact).join(', ')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined);
  return `{${keys.map((key) => `${JSON.stringify(key)}: ${pyCompact(value[key])}`).join(', ')}}`;
}

/** One value in the reference's two-space indented spelling. */
export function pyIndented(value) {
  return JSON.stringify(value, null, 2);
}