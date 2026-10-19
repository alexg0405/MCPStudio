/**
 * Audio-thread rule: no allocation inside `process()`. V8 allocates a number box for any double a
 * non-inlined call returns, so heap measurements can't tell that from a real allocation; this reads
 * the kernel's source instead and refuses what allocates on purpose: `new`, array and object
 * literals, closures, template strings, spreads and the array methods that build arrays.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** Kernels checked (the vocal-chain effects). Add a kernel file here when it is written to this rule. */
const KERNELS = ['de-esser', 'doubler', 'harmonizer'];

/** The text of a kernel's `process(` method with comments and string-free code only. */
function processBody(source: string): string {
  const start = source.search(/^ {2}process\(/m);
  expect(start, 'no process() method').toBeGreaterThanOrEqual(0);
  const rest = source.slice(start);
  const end = rest.search(/^ {2}\}$/m);
  return rest
    .slice(0, end + 4)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

const FORBIDDEN: [string, RegExp][] = [
  ['new', /\bnew\s/],
  ['an array literal', /(^|[=(,:?&|]|\breturn)\s*\[/m],
  ['an object literal', /(^|[=(,:?&|]|\breturn)\s*\{/m],
  ['a closure', /=>|\bfunction\b/],
  ['a template string', /`/],
  ['a spread', /\.\.\./],
  ['an array method', /\.(map|filter|slice|concat|push|pop|splice|reduce|forEach|from|of)\(/],
  ['a global that allocates', /\b(Array|Object|JSON|String|Math\.hypot)\b/],
];

describe('process() of the vocal-chain kernels', () => {
  it.each(KERNELS)('%s allocates nothing in process()', (name) => {
    const body = processBody(readFileSync(new URL(`../../src/plugins/builtin/${name}/kernel.ts`, import.meta.url), 'utf8'));
    expect(body.length).toBeGreaterThan(200);
    for (const [what, pattern] of FORBIDDEN) expect(body, `${name}: process() has ${what}`).not.toMatch(pattern);
  });

  it('the checker itself catches what it should', () => {
    const bad = 'class K {\n  process() {\n    const a = [1, 2];\n    const f = new Float32Array(4);\n  }\n}\n';
    const body = processBody(bad.replace('  }\n}', '  }\n  }'));
    expect(body).toMatch(FORBIDDEN[0]![1]);
    expect(body).toMatch(FORBIDDEN[1]![1]);
  });
});
