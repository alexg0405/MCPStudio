# AGstudio

An FL Studio-style DAW that runs in Chrome (TypeScript, React, Web Audio + AudioWorklet), built so its owner
can keep adding features and, above all, their own instruments and effects as code plugins.

Read `docs/architecture.md` before making structural changes. The plugin author guide is `docs/plugin-sdk.md`.

## Commands

Node is at `~/.local/node/bin`, which is not on PATH. Prefix shell commands with
`export PATH="$HOME/.local/node/bin:$PATH";`.

- `npm run dev`: dev server (port 5390 by default, or `$PORT`).
- `npm run check`: everything CI would run: `tsc -b` (all four tsconfigs), `eslint .`, `vitest run` (unit + audio).
- `npm test`: unit tests only (Node). `npm run test:audio`: browser tests in headless Chrome (installed Chrome, no download).
- `npm run new:plugin -- --kind instrument|effect --style graph|worklet --id user.my-thing`: scaffold a user plugin.

## Layers (enforced by ESLint `no-restricted-imports` + separate tsconfigs)

| Folder | What | May import |
|---|---|---|
| `src/sdk` | Public plugin API (`@agstudio/sdk`, `/params`, `/worklet`, `/dsp`, `/ui`) | react only in `sdk/ui` |
| `src/core` | Model, ops, history, time, queries, commands/keymap, schema, io. **No DOM** (tsconfig.core has no DOM lib) | immer, `@agstudio/sdk/params` |
| `src/engine` | Web Audio engine, scheduler, reconcile, offline render | core, sdk |
| `src/plugins/builtin` | Built-in instruments/effects | `@agstudio/sdk*` and react only |
| `src/platform` | File System Access, OPFS, IndexedDB, Web Locks | core |
| `src/app` | Composition root (`services.ts`), stores, persistence, plugin discovery | core, sdk, engine, platform |
| `src/ui` | React shell, workspace, canvases, `features/*` | core, sdk, app, `@engine/api` (types) |
| `plugins/` | User plugins (folders starting with `_` are ignored) | `@agstudio/sdk*`, react |

Cross-layer imports always use aliases (`@core/…`, `@engine/…`, `@app/…`, `@ui/…`, `@agstudio/sdk…`), never `../../`.

## Rules that are easy to break

- **Every document change goes through History** (`core/history`): `transact()` for one-shot edits, `gesture()` for drags
  (one undo entry per drag). Never write the project store directly. View/session state is not undoable.
- **Long-lived objects are created in `app/services.ts`**, never in React effects (StrictMode runs them twice).
- **Hot paths bypass React**: playhead, meters, drags and canvas redraws run on `ui/frame-loop.ts` or imperative
  controllers. Idle playback should cause zero React commits.
- **Built-in plugins use only the public SDK.** If a built-in needs something, add it to the SDK.
- **Audio-thread code** (`*.worklet.ts`, `src/sdk/worklet`, `src/sdk/dsp`): no DOM, no `import.meta.hot`, no dynamic
  import, no fetch, no npm deps, no allocation inside `process()`. Load processors with
  `import url from './x.worklet.ts?worker&url'` (never `new URL('./x.ts', import.meta.url)`; it breaks in production).
- Ticks are integers at **PPQ 960** (a 1/16 step = 240 ticks). Convert to seconds only through the TempoMap.
- Assets must be self-hosted: the dev/preview servers send COOP/COEP headers (cross-origin isolation).

## Adding a feature

Create `src/ui/features/<name>/register.ts` exporting `register(services)`. It is picked up automatically
(`src/ui/features/index.ts`). Register window types (`registerWindowType`), commands (`services.commands.register`),
key bindings (`services.keymap.add`), menu items (`addMenuItems`), toolbar slots (`addToolbarSlot`) and browser sections
(`addBrowserSection`) there. Put pure logic in `src/core` with unit tests next to it (`*.test.ts`); browser-only
tests are `*.browser.test.ts` or live in `test/browser/`.

## Debugging

In dev, `window.__ag` is the services object (stores, history, commands, keymap, engine). Useful in the console and
for automated checks through the preview browser.
