#!/usr/bin/env node
// Scaffolds a plugin into plugins/<folder> from templates/.
//   npm run new:plugin -- --kind instrument --style graph --id user.my-synth [--name "My Synth"]
//   npm run new:plugin -- --kind note-script --id user.my-tool [--name "My Tool"]
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, all) => {
    if (arg.startsWith('--')) acc.push([arg.slice(2), all[i + 1]?.startsWith('--') ? 'true' : (all[i + 1] ?? 'true')]);
    return acc;
  }, []),
);

const kind = args.kind ?? 'instrument';
const script = kind === 'note-script';
const style = args.style ?? 'graph';
const id = args.id;
const fail = (msg) => {
  console.error(
    `\n  ${msg}\n\n  Usage: npm run new:plugin -- --kind instrument|effect --style graph|worklet --id user.my-synth [--name "My Synth"]` +
      `\n         npm run new:plugin -- --kind note-script --id user.my-tool [--name "My Tool"]\n`,
  );
  process.exit(1);
};

if (!['instrument', 'effect', 'note-script'].includes(kind))
  fail(`--kind must be "instrument", "effect" or "note-script" (got "${kind}")`);
if (!script && !['graph', 'worklet'].includes(style)) fail(`--style must be "graph" or "worklet" (got "${style}")`);
if (!id || !/^[a-z0-9][a-z0-9._-]*$/i.test(id)) fail('--id is required, e.g. user.my-synth (letters, digits, . _ -)');

const folder = id.split('.').pop();
const name =
  args.name ??
  folder
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
const template = join(root, 'templates', script ? 'note-script' : `${kind}-${style}`);
const target = join(root, 'plugins', folder);
if (existsSync(target)) fail(`plugins/${folder} already exists`);

cpSync(template, target, { recursive: true });
const fill = (dir) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) fill(path);
    else
      writeFileSync(
        path,
        readFileSync(path, 'utf8').replaceAll('__PLUGIN_ID__', id).replaceAll('__PLUGIN_NAME__', name),
      );
  }
};
fill(target);

console.log(
  script
    ? `
  Created plugins/${folder} (note script) with id "${id}".

  - With "npm run dev" running it already shows up in the piano roll's Tools menu (and Edit > Piano roll tools).
  - Edit plugins/${folder}/index.ts; the menu picks up your changes when you save.
  - Guide: docs/plugin-sdk.md ("Note scripts")
`
    : `
  Created plugins/${folder} (${kind}, ${style}) with id "${id}".

  - With "npm run dev" running it already shows up in the browser panel under Plugins.
  - Edit plugins/${folder}/${style === 'worklet' ? 'dsp.worklet.ts' : 'index.ts'}; changes hot-reload and keep your settings.
  - Guide: docs/plugin-sdk.md
`,
);
