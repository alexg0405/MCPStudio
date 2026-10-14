import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import { defineConfig, globalIgnores } from 'eslint/config';

// Layer boundaries (see CLAUDE.md). Cross-layer imports must go through aliases so these rules can see them.
const climb = (layers) => ({
  regex: `^(\\.\\./)+(${layers.join('|')})(/|$)`,
  message: 'Import other layers through their alias (@core/*, @engine/*, …), never by climbing directories.',
});
const noReact = { group: ['react', 'react/*', 'react-dom', 'react-dom/*'], message: 'This layer is React-free.' };
const noZustand = { group: ['zustand', 'zustand/*'], message: 'Stores live in src/app.' };
const noImmer = { group: ['immer'], message: 'Plugins get state from the host, not from Immer.' };
const restrict = (...patterns) => ({ 'no-restricted-imports': ['error', { patterns }] });

export default defineConfig([
  // .claude holds helper-agent worktrees (whole copies of the repo): they lint themselves.
  // plugins/_* : AI drafts and backups (the plugin builder checks drafts itself).
  globalIgnores(['dist', 'coverage', 'node_modules', '.claude', 'plugins/_*']),
  js.configs.recommended,
  tseslint.configs.recommended,
  { languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } } },
  reactHooks.configs.flat['recommended-latest'],
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
    },
  },
  {
    files: ['scripts/**/*.mjs', 'vite.config.ts', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
  },

  // sdk: the public plugin API. Standalone; React only inside sdk/ui.
  {
    files: ['src/sdk/**'],
    rules: restrict(
      { regex: '^@(core|engine|platform|app|ui)(/|$)', message: 'The SDK must not depend on app internals.' },
      noZustand,
      noImmer,
      climb(['core', 'engine', 'platform', 'app', 'ui', 'plugins']),
    ),
  },
  {
    files: ['src/sdk/**'],
    ignores: ['src/sdk/ui/**'],
    rules: restrict(
      { regex: '^@(core|engine|platform|app|ui)(/|$)', message: 'The SDK must not depend on app internals.' },
      noReact,
      noZustand,
      noImmer,
      climb(['core', 'engine', 'platform', 'app', 'ui', 'plugins']),
    ),
  },
  // core: pure model + logic.
  {
    files: ['src/core/**'],
    rules: restrict(
      noReact,
      noZustand,
      { regex: '^@(engine|platform|app|ui)(/|$)', message: 'core must not depend on other layers.' },
      { regex: '^@agstudio/sdk(?!/params$)', message: 'core may only import @agstudio/sdk/params.' },
      climb(['engine', 'platform', 'app', 'ui', 'plugins', 'sdk']),
    ),
  },
  // engine: Web Audio, no UI or stores.
  {
    files: ['src/engine/**'],
    rules: restrict(
      noReact,
      noZustand,
      { regex: '^@(platform|app|ui)(/|$)', message: 'engine may only depend on core and sdk.' },
      climb(['platform', 'app', 'ui', 'plugins', 'core', 'sdk']),
    ),
  },
  // platform: browser storage / file APIs.
  {
    files: ['src/platform/**'],
    rules: restrict(
      noReact,
      noZustand,
      { regex: '^@(engine|app|ui)(/|$)', message: 'platform may only depend on core.' },
      climb(['engine', 'app', 'ui', 'plugins', 'core', 'sdk']),
    ),
  },
  // app: composition root, stores, persistence. Never imports UI.
  {
    files: ['src/app/**'],
    rules: restrict(
      noReact,
      { regex: '^@ui(/|$)', message: 'app must not depend on ui.' },
      climb(['ui', 'plugins', 'core', 'engine', 'platform', 'sdk']),
    ),
  },
  // ui: talks to the engine only through app services (types from @engine/api are fine).
  {
    files: ['src/ui/**'],
    rules: restrict(
      {
        regex: '^@engine/(?!api$)',
        message: 'ui reaches the engine through app services; import types from @engine/api.',
      },
      { regex: '^@platform(/|$)', message: 'ui reaches platform APIs through app services.' },
      climb(['engine', 'platform', 'app', 'core', 'sdk', 'plugins']),
    ),
  },
  // Plugins (built-in, user, templates): the public SDK only. This is what keeps the SDK honest.
  {
    files: ['src/plugins/**', 'plugins/**', 'templates/**'],
    rules: restrict(
      {
        regex: '^@(core|engine|platform|app|ui)(/|$)',
        message: 'Plugins may only import @agstudio/sdk*, react and their own files.',
      },
      noZustand,
      noImmer,
      { regex: '^(\\.\\./){3,}', message: 'Plugins may only import their own files.' },
    ),
  },
]);
