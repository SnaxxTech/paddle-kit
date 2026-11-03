/**
 * A jsonb value as read back. Before v0.9.0 the kit's writes through postgres-js stored JSON *text* as a jsonb
 * string (postgres-js JSON-encodes a parameter Postgres types as jsonb), so such a row reads back as a string that
 * holds JSON. It is parsed when it holds an object or an array; any other string is returned as it is.
 * ponytail: an old row holding a JSON-encoded number or string stays a string; rewrite it if one matters.
 */
export function jsonValue<T = unknown>(v: unknown): T {
  if (typeof v !== 'string' || !/^\s*[[{]/.test(v)) return v as T;
  try {
    const parsed = JSON.parse(v);
    return (parsed !== null && typeof parsed === 'object' ? parsed : v) as T;
  } catch {
    return v as T;
  }
}
