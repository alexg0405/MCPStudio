/**
 * What the plugin builder tells Claude: how AGstudio plugins are written (the SDK guide and the
 * templates, verbatim), the rules the checks enforce, and the answer format.
 */
import sdkGuide from '../../../docs/plugin-sdk.md?raw';
import effectGraph from '../../../templates/effect-graph/index.ts?raw';
import effectWorkletDsp from '../../../templates/effect-worklet/dsp.worklet.ts?raw';
import effectWorkletIndex from '../../../templates/effect-worklet/index.ts?raw';
import effectWorkletParams from '../../../templates/effect-worklet/params.ts?raw';
import instrumentGraph from '../../../templates/instrument-graph/index.ts?raw';
import instrumentWorkletDsp from '../../../templates/instrument-worklet/dsp.worklet.ts?raw';
import instrumentWorkletIndex from '../../../templates/instrument-worklet/index.ts?raw';
import instrumentWorkletParams from '../../../templates/instrument-worklet/params.ts?raw';

const template = (name: string, files: Record<string, string>) =>
  `<template name="${name}">\n${Object.entries(files)
    .map(([path, text]) => `<file path="${path}">\n${text.trim()}\n</file>`)
    .join('\n')}\n</template>`;

export const BUILDER_PROMPT = `You write plugins for AGstudio, an FL Studio-style DAW that runs in the browser, on its public plugin SDK. The musician describes an instrument or an effect; you answer with the complete plugin as files, in the required JSON format. AGstudio then checks your files (names, imports, TypeScript), renders a test (an instrument plays notes; an effect processes a synth) and sends back any problems for you to fix.

Rules (the checks enforce them):
- The plugin id is "user.<name>" with a lowercase name of letters, digits and dashes, e.g. "user.tape-stop".
- Files are flat (no folders): index.ts (the definition as the default export), plus params.ts and dsp.worklet.ts for worklet plugins, optionally kernel.ts (pure DSP) and README.md. Nothing else.
- Imports: @agstudio/sdk and its modules (/params, /ui, /notes, /worklet), react, and the plugin's own files ("./params", "./kernel"). Audio-thread files (*.worklet.ts) import only @agstudio/sdk/worklet and @agstudio/sdk/params, plus the plugin's own kernel or params files.
- Load an audio-thread processor exactly like this: import processor from './dsp.worklet.ts?worker&url';
- No network, browser storage, eval/new Function or dynamic import.
- Audio-thread code: no allocation inside render()/process(), no DOM. Flush tiny feedback values (flush()).
- Prefer the graph style (native Web Audio nodes) when the sound can be built from them; use a worklet kernel when it needs per-sample DSP.
- Make it easy to understand: a one-sentence description, a category, and for every param a plain label, a unit where it has one, a short hint saying what it does, and a group. Give it two to four presets with descriptive names.
- It must work: an instrument responds to noteOn/noteOff (release voices, no hanging notes), an effect passes audio. Keep a sane level (peaks under 0 dBFS at default settings), no NaN, no clicks, and dispose every node.
- When the checks report problems, fix all of them and send every file again, complete (not a diff).
- The message: one or two friendly sentences for the musician about what the plugin does and how to use it.

The plugin SDK guide:
<guide>
${sdkGuide.trim()}
</guide>

Templates (the starting points AGstudio's own scaffolder uses; __PLUGIN_ID__ and __PLUGIN_NAME__ get replaced):
${template('effect-graph', { 'index.ts': effectGraph })}
${template('effect-worklet', { 'index.ts': effectWorkletIndex, 'params.ts': effectWorkletParams, 'dsp.worklet.ts': effectWorkletDsp })}
${template('instrument-graph', { 'index.ts': instrumentGraph })}
${template('instrument-worklet', {
  'index.ts': instrumentWorkletIndex,
  'params.ts': instrumentWorkletParams,
  'dsp.worklet.ts': instrumentWorkletDsp,
})}`;

export const BUILDER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message: { type: 'string', description: 'One or two sentences for the musician about the plugin.' },
    plugin: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'user.<lowercase-name-with-dashes>' },
        name: { type: 'string', description: 'The name the musician sees.' },
        kind: { type: 'string', enum: ['instrument', 'effect'] },
        files: {
          type: 'array',
          description: 'Every file of the plugin, complete.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', description: 'A flat file name: index.ts, params.ts, dsp.worklet.ts…' },
              content: { type: 'string' },
            },
            required: ['path', 'content'],
          },
        },
      },
      required: ['id', 'name', 'kind', 'files'],
    },
  },
  required: ['message', 'plugin'],
} as const;

export interface BuiltPluginFiles {
  id: string;
  name: string;
  kind: 'instrument' | 'effect';
  files: { path: string; content: string }[];
}

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'plugin';

/** Checks the shape of a builder answer (the server checks the files themselves). */
export function readBuilderAnswer(
  raw: unknown,
): { value: { message: string; plugin: BuiltPluginFiles } } | { error: string } {
  const o = raw as { message?: unknown; plugin?: Record<string, unknown> } | null;
  const p = o?.plugin;
  if (!p || typeof p !== 'object') return { error: 'the answer has no plugin' };
  const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 60) : 'New plugin';
  const kind = p.kind === 'instrument' || p.kind === 'effect' ? p.kind : null;
  if (!kind) return { error: 'the plugin kind must be "instrument" or "effect"' };
  const files = Array.isArray(p.files)
    ? p.files.filter(
        (f): f is { path: string; content: string } =>
          !!f && typeof f === 'object' && typeof f.path === 'string' && typeof f.content === 'string',
      )
    : [];
  if (files.length === 0) return { error: 'the plugin has no files' };
  // An id that breaks the rule is rebuilt from the name (the files may spell it either way).
  const id = typeof p.id === 'string' && /^user\.[a-z][a-z0-9-]{1,40}$/.test(p.id) ? p.id : `user.${slug(name)}`;
  return {
    value: {
      message: typeof o?.message === 'string' ? o.message : '',
      plugin: { id, name, kind, files: files.map((f) => ({ path: f.path, content: f.content })) },
    },
  };
}
