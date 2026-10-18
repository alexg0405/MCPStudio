/** Checks tool-call arguments against the tool's JSON Schema (the subset the AGstudio tools use). */

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** True when `value` has the JSON Schema type `type` (an unknown type name accepts anything). */
function hasType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return isObject(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}

/** The problem with the value's type, or null when it is fine. `where` names the value in the message. */
function typeProblem(schema: Json, value: unknown, where: string): string | null {
  const type = schema.type;
  if (typeof type === 'string' && !hasType(value, type)) {
    return `${where} must be ${/^[aeiou]/.test(type) ? 'an' : 'a'} ${type}`;
  }
  if (Array.isArray(type) && !type.some((t) => typeof t === 'string' && hasType(value, t))) {
    return `${where} must be ${type.join(' or ')}`;
  }
  return null;
}

/** Checks tool arguments against the tool's JSON Schema (the parts the tools use). Returns the problems. */
export function validateArguments(schema: unknown, value: unknown, path = ''): string[] {
  if (!isObject(schema)) return [];
  const where = path || 'the arguments';
  const wrongType = typeProblem(schema, value, where);
  if (wrongType) return [wrongType];

  const problems: string[] = [];
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    problems.push(`${where} must be one of: ${schema.enum.map(String).join(', ')}`);
  }
  if (typeof value === 'number') problems.push(...rangeProblems(schema, value, where));
  if (isObject(value) && isObject(schema.properties)) {
    problems.push(...propertyProblems(schema, schema.properties, value, path));
  }
  return problems;
}

function rangeProblems(schema: Json, value: number, where: string): string[] {
  const problems: string[] = [];
  if (typeof schema.minimum === 'number' && value < schema.minimum)
    problems.push(`${where} must be at least ${schema.minimum}`);
  if (typeof schema.maximum === 'number' && value > schema.maximum)
    problems.push(`${where} must be at most ${schema.maximum}`);
  return problems;
}

/** Missing required properties, unknown ones (when the schema forbids them) and problems inside known ones. */
function propertyProblems(schema: Json, properties: Json, value: Json, path: string): string[] {
  const prefix = path ? `${path}.` : '';
  const problems: string[] = [];
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (typeof key === 'string' && value[key] === undefined) problems.push(`${prefix}${key} is required`);
  }
  for (const [key, propertyValue] of Object.entries(value)) {
    const propertySchema = properties[key];
    if (propertySchema === undefined) {
      if (schema.additionalProperties === false) problems.push(`${prefix}${key} is not a known option`);
    } else if (propertyValue !== undefined) {
      problems.push(...validateArguments(propertySchema, propertyValue, `${prefix}${key}`));
    }
  }
  return problems;
}
