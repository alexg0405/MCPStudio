/**
 * The layer boundaries in CLAUDE.md are enforced by ESLint `no-restricted-imports` rules in
 * eslint.config.js. This lints small in-memory files "placed" in each layer and checks that a forbidden import is
 * reported (and an allowed one is not), so a refactor of the config cannot silently open a layer up.
 */
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({ cwd: root });
});

/** The messages of every `no-restricted-imports` report for `import … from '<spec>'` written at `file`. */
async function restricted(file: string, spec: string): Promise<string[]> {
  const [result] = await eslint.lintText(`import * as x from '${spec}';\nexport const y = x;\n`, {
    filePath: `${root}${file}`,
  });
  return (result?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-imports').map((m) => m.message);
}

// [file the import is written in, specifier, forbidden?]
const cases: [string, string, boolean][] = [
  // core: pure model + logic. No DOM-ish or app layers, only the SDK's params.
  ['src/core/x.ts', '@engine/api', true],
  ['src/core/x.ts', '@platform/idb', true],
  ['src/core/x.ts', '@app/services', true],
  ['src/core/x.ts', '@ui/theme', true],
  ['src/core/x.ts', 'react', true],
  ['src/core/x.ts', 'zustand', true],
  ['src/core/x.ts', '@agstudio/sdk', true],
  ['src/core/x.ts', '@agstudio/sdk/worklet', true],
  ['src/core/x.ts', '../engine/api', true],
  ['src/core/x.ts', '@agstudio/sdk/params', false],
  ['src/core/x.ts', 'immer', false],
  ['src/core/x.ts', '@core/model/types', false],
  // sdk: standalone; React only inside sdk/ui.
  ['src/sdk/x.ts', '@core/model/types', true],
  ['src/sdk/x.ts', '@engine/api', true],
  ['src/sdk/x.ts', '@app/services', true],
  ['src/sdk/x.ts', 'react', true],
  ['src/sdk/x.ts', 'zustand', true],
  ['src/sdk/x.ts', 'immer', true],
  ['src/sdk/x.ts', '../core/model/types', true],
  ['src/sdk/ui/x.tsx', 'react', false],
  ['src/sdk/ui/x.tsx', '@core/model/types', true],
  ['src/sdk/ui/x.tsx', 'zustand', true],
  // engine: Web Audio, no UI, stores or platform.
  ['src/engine/x.ts', '@ui/theme', true],
  ['src/engine/x.ts', '@app/services', true],
  ['src/engine/x.ts', '@platform/idb', true],
  ['src/engine/x.ts', 'react', true],
  ['src/engine/x.ts', 'zustand', true],
  ['src/engine/x.ts', '../app/services', true],
  ['src/engine/x.ts', '@core/model/types', false],
  ['src/engine/x.ts', '@agstudio/sdk', false],
  // platform: browser storage, depends on core only.
  ['src/platform/x.ts', '@engine/api', true],
  ['src/platform/x.ts', '@app/services', true],
  ['src/platform/x.ts', '@ui/theme', true],
  ['src/platform/x.ts', 'react', true],
  ['src/platform/x.ts', '@core/model/types', false],
  // app: composition root and stores; never the UI, never React.
  ['src/app/x.ts', '@ui/theme', true],
  ['src/app/x.ts', 'react', true],
  ['src/app/x.ts', '../ui/theme', true],
  ['src/app/x.ts', '@engine/engine', false],
  ['src/app/x.ts', '@platform/idb', false],
  ['src/app/x.ts', 'zustand', false],
  // ui: reaches the engine through app services (types from @engine/api only) and never platform.
  ['src/ui/x.tsx', '@engine/engine', true],
  ['src/ui/x.tsx', '@engine/render-offline', true],
  ['src/ui/x.tsx', '@platform/idb', true],
  ['src/ui/x.tsx', '../../core/model/types', true],
  ['src/ui/x.tsx', '@engine/api', false],
  ['src/ui/x.tsx', '@app/services', false],
  ['src/ui/x.tsx', '@core/model/types', false],
  ['src/ui/x.tsx', 'react', false],
  // plugins (built-in, user, templates): the public SDK, react and their own files.
  ['src/plugins/builtin/x/index.ts', '@core/model/types', true],
  ['src/plugins/builtin/x/index.ts', '@engine/api', true],
  ['src/plugins/builtin/x/index.ts', '@app/services', true],
  ['src/plugins/builtin/x/index.ts', '@ui/theme', true],
  ['src/plugins/builtin/x/index.ts', '@platform/idb', true],
  ['src/plugins/builtin/x/index.ts', 'zustand', true],
  ['src/plugins/builtin/x/index.ts', 'immer', true],
  ['src/plugins/builtin/x/index.ts', '../../../../core/model/types', true],
  ['src/plugins/builtin/x/index.ts', '@agstudio/sdk', false],
  ['src/plugins/builtin/x/index.ts', '@agstudio/sdk/params', false],
  ['src/plugins/builtin/x/index.ts', 'react', false],
  ['src/plugins/builtin/x/index.ts', './params', false],
  ['plugins/user.my-thing/index.ts', '@core/model/types', true],
  ['plugins/user.my-thing/index.ts', '@app/services', true],
  ['plugins/user.my-thing/index.ts', '@agstudio/sdk', false],
  ['templates/instrument-graph/index.ts', '@core/model/types', true],
  ['templates/instrument-graph/index.ts', '@agstudio/sdk', false],
];

describe('layer lint rules (eslint.config.js)', () => {
  for (const [file, spec, forbidden] of cases)
    it(`${file} ${forbidden ? 'may not' : 'may'} import ${spec}`, async () => {
      const messages = await restricted(file, spec);
      if (forbidden) expect(messages.length, `expected a restricted-import error for '${spec}' in ${file}`).toBeGreaterThan(0);
      else expect(messages).toEqual([]);
    });
});
