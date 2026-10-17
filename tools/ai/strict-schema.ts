/**
 * OpenAI's strict structured outputs (what `codex exec --output-schema` sends) take a narrower JSON schema than
 * AGstudio's answer schemas, which were written for Claude: strict mode wants every property of an object in
 * `required` (an optional one is spelled "may be null"), takes no `const` (a one-value `enum` instead) and a
 * few keywords it rejects.
 *
 * `toStrictSchema` makes that copy, `stripNulls` undoes it on the reply: the original schemas have no null
 * types, so a null in the answer always means "left out", and deleting it gives back exactly the shape the page
 * validates and the op appliers read. Pure; unit-tested in test/unit/strict-schema.test.ts.
 */

type Json = Record<string, unknown>;

/** Keywords strict mode rejects (the page's validator enforces what they would have said). */
const DROPPED = new Set(['minLength', 'maxLength', 'uniqueItems', 'default', 'examples', 'format', 'pattern']);

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function convert(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(convert);
  if (!isObject(node)) return node;
  if (node.type === 'null' || (Array.isArray(node.type) && node.type.includes('null')))
    throw new Error('A null type in the original schema would be confused with "left out".');
  const out: Json = {};
  for (const [key, value] of Object.entries(node)) {
    if (DROPPED.has(key)) continue;
    if (key === 'const') {
      out.enum = [value];
    } else if (key === 'oneOf' || key === 'anyOf') {
      out.anyOf = (value as unknown[]).map(convert);
    } else if (key === 'properties' && isObject(value)) {
      out.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, convert(v)]));
    } else if (key === 'items' || key === 'additionalProperties') {
      out[key] = typeof value === 'boolean' ? value : convert(value);
    } else if (key === '$defs' && isObject(value)) {
      out.$defs = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, convert(v)]));
    } else {
      out[key] = value;
    }
  }
  if (isObject(out.properties) || out.type === 'object') {
    const properties = (isObject(out.properties) ? out.properties : {}) as Json;
    const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
    out.properties = Object.fromEntries(
      Object.entries(properties).map(([k, v]) => [k, required.has(k) ? v : nullable(v)]),
    );
    out.required = Object.keys(properties);
    out.additionalProperties = false;
  }
  return out;
}

/** The same schema, but the value may also be null (the description stays on the outside). */
function nullable(schema: unknown): unknown {
  if (!isObject(schema)) return schema;
  const { description, ...rest } = schema;
  const withNull = Array.isArray(rest.anyOf)
    ? { ...rest, anyOf: [...(rest.anyOf as unknown[]), { type: 'null' }] }
    : { anyOf: [rest, { type: 'null' }] };
  return description === undefined ? withNull : { description, ...withNull };
}

/** An answer schema in OpenAI's strict form. */
export function toStrictSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return convert(schema) as Record<string, unknown>;
}

/** The reply with every null property deleted (null in an array stays: the original has none to restore). */
export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (!isObject(value)) return value;
  const out: Json = {};
  for (const [k, v] of Object.entries(value)) if (v !== null) out[k] = stripNulls(v);
  return out;
}
