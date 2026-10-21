import { describe, expect, it } from 'vitest';
import { ACTION_OPS, ACTIONS_SCHEMA, readAnswer } from '@app/ai/schema';
import { BUILDER_PROMPT, BUILDER_SCHEMA, readBuilderAnswer } from '@app/ai/builder-prompt';
import { STUDIO_PROMPT } from '@app/ai/prompt';
import { SYSTEM_PROMPT } from '@app/assistant/claude';
import { BEAT_JSON_SCHEMA, validateBeatSpec } from '@core/beat/spec';
import { stripNulls, toStrictSchema } from '../../tools/ai/strict-schema.ts';
import { MAX_SYSTEM_CHARS } from '../../tools/ai/types.ts';

/**
 * The conversion of AGstudio's answer schemas into OpenAI's strict form for the Codex backend: the rules, a round
 * trip through the page's real validators (a strict reply, null-stripped, must be what the page already accepts) and
 * OpenAI's documented limits for strict structured outputs.
 */
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const SCHEMAS: [string, J][] = [
  ['Studio (ACTIONS_SCHEMA)', ACTIONS_SCHEMA as J],
  ['plugin builder (BUILDER_SCHEMA)', BUILDER_SCHEMA as J],
  ['beat (BEAT_JSON_SCHEMA)', BEAT_JSON_SCHEMA as J],
];

describe('toStrictSchema rules', () => {
  const strict = toStrictSchema({
    type: 'object',
    additionalProperties: false,
    properties: {
      op: { type: 'string', const: 'x' },
      need: { type: 'string' },
      maybe: { type: 'number', description: 'Optional number.' },
      either: { anyOf: [{ type: 'number' }, { type: 'string' }], description: 'A or B.' },
      list: { type: 'array', items: { type: 'object', properties: { a: { type: 'string' } } } },
      sub: { type: 'object', additionalProperties: false, properties: { z: { type: 'integer' } }, required: ['z'] },
      kind: { type: 'string', enum: ['p', 'q'] },
    },
    required: ['op', 'need'],
  }) as J;

  it('requires every property, in the original order', () => {
    expect(strict.required).toEqual(['op', 'need', 'maybe', 'either', 'list', 'sub', 'kind']);
    expect(strict.additionalProperties).toBe(false);
    expect(strict.properties.list.anyOf[0].items.required).toEqual(['a']);
    expect(strict.properties.list.anyOf[0].items.additionalProperties).toBe(false);
  });

  it('turns an optional property into a nullable one and leaves required ones alone', () => {
    expect(strict.properties.need).toEqual({ type: 'string' });
    expect(strict.properties.maybe).toEqual({ description: 'Optional number.', anyOf: [{ type: 'number' }, { type: 'null' }] });
    expect(strict.properties.sub.anyOf[1]).toEqual({ type: 'null' });
    expect(strict.properties.kind).toEqual({ anyOf: [{ type: 'string', enum: ['p', 'q'] }, { type: 'null' }] });
  });

  it('appends null to an existing anyOf instead of nesting', () => {
    expect(strict.properties.either).toEqual({
      description: 'A or B.',
      anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'null' }],
    });
  });

  it('writes const as a one-value enum', () => {
    expect(strict.properties.op).toEqual({ type: 'string', enum: ['x'] });
    expect(JSON.stringify(strict)).not.toContain('"const"');
  });

  it('does not touch the original, and drops keywords strict mode rejects', () => {
    const original = { type: 'object', properties: { s: { type: 'string', const: 'a', minLength: 1 } } };
    const copy = JSON.parse(JSON.stringify(original));
    const out = toStrictSchema(original) as J;
    expect(original).toEqual(copy);
    expect(out.properties.s.anyOf[0]).toEqual({ type: 'string', enum: ['a'] });
  });

  it('refuses a schema that already has null (it could not tell null from left out)', () => {
    expect(() => toStrictSchema({ type: 'object', properties: { a: { type: ['string', 'null'] } } })).toThrow(/null/);
    expect(() => toStrictSchema({ type: 'object', properties: { a: { anyOf: [{ type: 'null' }] } } })).toThrow(/null/);
  });

  it('is a copy of the original schemas for the page: they have no null types to begin with', () => {
    for (const [, s] of SCHEMAS) expect(() => toStrictSchema(s)).not.toThrow();
  });
});

describe('stripNulls', () => {
  it('deletes null properties at every depth, keeps everything else', () => {
    expect(stripNulls({ a: 1, b: null, c: { d: null, e: [{ f: null, g: 0 }], h: false, i: '' } })).toEqual({
      a: 1,
      c: { e: [{ g: 0 }], h: false, i: '' },
    });
    expect(stripNulls(null)).toBeNull();
    expect(stripNulls('x')).toBe('x');
  });
});

// ---- a small JSON-schema checker and an instance generator, enough for the keywords these schemas use ----

function valid(schema: J, v: unknown): boolean {
  if (schema.anyOf) return (schema.anyOf as J[]).some((s) => valid({ ...schema, anyOf: undefined, ...s }, v));
  if (schema.enum && !schema.enum.some((e: unknown) => e === v)) return false;
  if ('const' in schema && schema.const !== v) return false;
  switch (schema.type) {
    case 'null':
      return v === null;
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number';
    case 'integer':
      return Number.isInteger(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'array':
      return Array.isArray(v) && v.every((x) => valid(schema.items ?? {}, x));
    case 'object': {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
      const o = v as J;
      const props = (schema.properties ?? {}) as J;
      if (schema.additionalProperties === false && Object.keys(o).some((k) => !(k in props))) return false;
      if (((schema.required ?? []) as string[]).some((k) => !(k in o))) return false;
      return Object.entries(o).every(([k, x]) => !(k in props) || valid(props[k], x));
    }
    default:
      return true;
  }
}

/** One instance of a schema: `max` fills every property, otherwise only the required ones. */
function make(schema: J, max: boolean, branch = 0): unknown {
  if (schema.anyOf) return make({ ...schema, anyOf: undefined, ...schema.anyOf[branch % schema.anyOf.length] }, max);
  if (schema.enum) return schema.enum[0];
  if ('const' in schema) return schema.const;
  switch (schema.type) {
    case 'string':
      return 'x';
    case 'number':
      return 1.5;
    case 'integer':
      return 2;
    case 'boolean':
      return true;
    case 'array':
      return [make(schema.items, max)];
    default: {
      const props = (schema.properties ?? {}) as J;
      const required = new Set((schema.required ?? []) as string[]);
      return Object.fromEntries(
        Object.entries(props)
          .filter(([k]) => max || required.has(k))
          .map(([k, s]) => [k, make(s as J, max)]),
      );
    }
  }
}

/** What a strict-mode model sends: every property the instance left out is spelled null. */
function fillNulls(schema: J, v: unknown): unknown {
  if (schema.anyOf) {
    const hit = (schema.anyOf as J[]).find((s) => valid({ ...schema, anyOf: undefined, ...s }, v));
    return hit ? fillNulls({ ...schema, anyOf: undefined, ...hit }, v) : v;
  }
  if (Array.isArray(v)) return v.map((x) => fillNulls(schema.items ?? {}, x));
  if (typeof v !== 'object' || v === null) return v;
  const props = (schema.properties ?? {}) as J;
  const o = v as J;
  return Object.fromEntries(Object.keys(props).map((k) => [k, k in o ? fillNulls(props[k], o[k]) : null]));
}

function roundTrip(schema: J, instance: unknown) {
  const strict = toStrictSchema(schema);
  expect(valid(schema, instance)).toBe(true);
  const reply = fillNulls(schema, instance);
  expect(valid(strict, reply)).toBe(true);
  const back = stripNulls(reply);
  expect(back).toEqual(instance);
  return back;
}

describe('round trip through the page validators', () => {
  const ops = ACTION_OPS as unknown as J[];
  it('knows all the ops it is checking', () => {
    expect(ops.length).toBeGreaterThanOrEqual(50);
  });

  it('every Studio op, with only its required fields and with all of them, comes back as sent', () => {
    for (const max of [false, true]) {
      for (const op of ops) {
        const name = op.properties.op.const as string;
        const answer = { message: 'Done.', actions: [make(op, max)] };
        const back = roundTrip(ACTIONS_SCHEMA as J, answer);
        const read = readAnswer(back);
        expect(read, `${name} (max ${max})`).not.toHaveProperty('error');
        if ('answer' in read) {
          expect(read.dropped).toBe(0);
          expect(read.answer.actions).toHaveLength(1);
          expect(read.answer.actions[0]!.op).toBe(name);
        }
      }
    }
  });

  it('the plugin builder answer is read the same', () => {
    for (const max of [false, true]) {
      const answer = make(BUILDER_SCHEMA as J, max);
      const back = roundTrip(BUILDER_SCHEMA as J, answer);
      expect(readBuilderAnswer(back)).toEqual(readBuilderAnswer(answer));
      expect(readBuilderAnswer(back)).toHaveProperty('value');
    }
  });

  it('the beat gets the same verdict from validateBeatSpec', () => {
    for (const max of [false, true]) {
      const beat = make(BEAT_JSON_SCHEMA as J, max);
      const back = roundTrip(BEAT_JSON_SCHEMA as J, beat);
      expect(validateBeatSpec(back)).toEqual(validateBeatSpec(beat));
    }
    // a realistic beat: optional fields left out inside tracks and notes
    const real = {
      title: 'Night drive',
      message: 'A dark, bouncy trap loop.',
      bars: 2,
      tracks: [
        { name: 'Kick', sound: 'kick', notes: [{ step: 0 }, { step: 7, vel: 0.7 }] },
        { name: '808', sound: '808', params: { glide: 0.09 }, notes: [{ step: 0, len: 7, key: 29 }] },
      ],
    };
    const back = roundTrip(BEAT_JSON_SCHEMA as J, real);
    expect(validateBeatSpec(back)).toEqual(validateBeatSpec(real));
    expect(validateBeatSpec(back)).toHaveProperty('spec');
  });
});

// ---- OpenAI's documented limits for strict structured outputs ----

interface Measure {
  properties: number;
  depth: number;
  nameChars: number;
  enumValues: number;
  maxEnumValues: number;
  maxEnumChars: number;
  problems: string[];
}

/** Walks a strict schema: sizes against the limits, and everything strict mode would reject. */
function measure(root: J): Measure {
  const m: Measure = { properties: 0, depth: 0, nameChars: 0, enumValues: 0, maxEnumValues: 0, maxEnumChars: 0, problems: [] };
  const UNSUPPORTED = ['oneOf', 'allOf', 'not', 'const', 'if', 'then', 'else', 'patternProperties', 'minLength', 'maxLength', 'default'];
  const walk = (n: unknown, depth: number, path: string): void => {
    if (typeof n !== 'object' || n === null) return;
    const s = n as J;
    for (const k of UNSUPPORTED) if (k in s) m.problems.push(`${path}: "${k}" is not supported`);
    let d = depth;
    if (s.type === 'object' || s.properties) {
      d += 1;
      m.depth = Math.max(m.depth, d);
      const keys = Object.keys(s.properties ?? {});
      if (s.additionalProperties !== false) m.problems.push(`${path}: additionalProperties must be false`);
      if (JSON.stringify(s.required ?? []) !== JSON.stringify(keys)) m.problems.push(`${path}: not every property is required`);
      m.properties += keys.length;
      for (const k of keys) {
        m.nameChars += k.length;
        walk(s.properties[k], d, `${path}.${k}`);
      }
    }
    if (Array.isArray(s.enum)) {
      const chars = s.enum.reduce((a: number, v: unknown) => a + String(v).length, 0);
      m.enumValues += s.enum.length;
      m.nameChars += chars;
      m.maxEnumValues = Math.max(m.maxEnumValues, s.enum.length);
      m.maxEnumChars = Math.max(m.maxEnumChars, chars);
    }
    if (s.items) walk(s.items, d, `${path}[]`);
    if (Array.isArray(s.anyOf)) s.anyOf.forEach((b: unknown, i: number) => walk(b, d, `${path}|${i}`));
  };
  if (root.type !== 'object' || root.anyOf) m.problems.push('the root must be an object, not anyOf');
  walk(root, 0, '$');
  return m;
}

describe('OpenAI strict-mode limits', () => {
  // Documented limits (platform.openai.com, Structured Outputs, "Supported schemas"): up to 5000 object properties in
  // total with up to 10 levels of nesting; up to 120 000 characters across all property names, enum values and const
  // values; up to 1000 enum values in total (older text of the page said 500: the Studio schema is at ~470 today, so
  // if the real limit turns out to be 500 this is where to look); a single enum of more than 250 values may hold at most
  // 15 000 characters. The prompt limits are AGstudio's own (tools/ai/server.ts).
  const LIMITS = { properties: 5000, depth: 10, nameChars: 120_000, enumValues: 1000, bigEnumChars: 15_000 };

  for (const [name, schema] of SCHEMAS) {
    it(`${name} fits`, () => {
      const m = measure(toStrictSchema(schema));
      expect(m.problems).toEqual([]);
      expect(m.properties).toBeLessThanOrEqual(LIMITS.properties);
      expect(m.depth).toBeLessThanOrEqual(LIMITS.depth);
      expect(m.nameChars).toBeLessThanOrEqual(LIMITS.nameChars);
      expect(m.enumValues).toBeLessThanOrEqual(LIMITS.enumValues);
      if (m.maxEnumValues > 250) expect(m.maxEnumChars).toBeLessThanOrEqual(LIMITS.bigEnumChars);
    });
  }

  it('the Studio schema is far from the limits that matter most (room for new ops)', () => {
    const m = measure(toStrictSchema(ACTIONS_SCHEMA as J));
    expect(m.properties).toBeLessThan(LIMITS.properties / 2);
    expect(m.depth).toBeLessThanOrEqual(LIMITS.depth - 3);
    expect(m.enumValues).toBeLessThan(LIMITS.enumValues);
  });

  it('the measure itself notices a schema strict mode would reject', () => {
    const bad = measure({ type: 'object', properties: { a: { type: 'string', const: 'x' } }, required: [] });
    expect(bad.problems.join('\n')).toMatch(/additionalProperties[\s\S]*not every property[\s\S]*const/);
  });

  it('the system prompts fit the AI server’s system-prompt limit', () => {
    for (const prompt of [STUDIO_PROMPT, BUILDER_PROMPT, SYSTEM_PROMPT]) expect(prompt.length).toBeLessThan(MAX_SYSTEM_CHARS);
  });
});
