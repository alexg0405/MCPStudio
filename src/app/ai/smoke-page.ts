/**
 * The plugin builder's test page (plugin-test.html, in a hidden iframe): loads a draft from
 * plugins/_drafts/<folder>/, checks its definitions, renders it offline (an instrument plays a short
 * phrase; an effect processes a synth chord) and reports to the app what went wrong.
 */
import { produce } from 'immer';
import { defaultValues, type PluginDef } from '@agstudio/sdk';
import { createEmptyProject, makeInstrumentChannel, makePluginInstance } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import type { NoteId, PatternId, Project } from '@core/model/types';
import { addChannel, setChannelProp } from '@core/ops/channels';
import { addFxSlot } from '@core/ops/mixer';
import { addNotes } from '@core/ops/notes';
import { renderOffline } from '@engine/render-offline';
import { registerBuiltinPlugins } from '@app/plugins/discover';
import { PluginRegistry } from '@app/plugins/registry';
import type { SmokeReport } from './builder';

const SR = 48000;
const params = new URLSearchParams(location.search);
const folder = params.get('folder') ?? '';
const nonce = params.get('nonce') ?? '';

const errors: string[] = [];
const keep = (what: unknown) => {
  const text = what instanceof Error ? `${what.name}: ${what.message}` : String(what);
  if (errors.length < 8 && !errors.includes(text)) errors.push(text);
};
const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  keep(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(' '));
  consoleError(...args);
};
window.addEventListener('error', (e) => keep(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => keep(e.reason));

/** A one-bar phrase at 120 BPM: a few notes and a chord, some overlapping. */
const PHRASE: [tick: number, length: number, key: number][] = [
  [0, 480, 48],
  [480, 480, 55],
  [960, 960, 60],
  [960, 960, 64],
  [960, 960, 67],
  [2400, 480, 72],
  [2880, 960, 62],
];

function projectFor(def: PluginDef, source: PluginDef | undefined): { project: Project; patternId: PatternId } {
  const base = createEmptyProject();
  const patternId = base.patternOrder[0] as PatternId;
  const project = produce(base, (d) => {
    d.transport.bpm = 120;
    const insertId = d.mixer.order[1]!;
    const player = def.kind === 'instrument' ? def : source;
    if (!player) return;
    const ch = makeInstrumentChannel(player.name, makePluginInstance(player.id, player.version, defaultValues(player.params)));
    addChannel(d, ch);
    setChannelProp(d, ch.id, 'output', insertId);
    addNotes(
      d,
      patternId,
      ch.id,
      PHRASE.map(([tick, length, key]) => ({ id: newId.note() as NoteId, tick, length, key, velocity: 0.8 })),
    );
    if (def.kind === 'effect') addFxSlot(d, insertId, makePluginInstance(def.id, def.version, defaultValues(def.params)));
  });
  return { project, patternId };
}

async function test(): Promise<SmokeReport> {
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(folder)) return { problems: ['No plugin folder was given.'], peakDb: null };
  const path = `/plugins/_drafts/${folder}/index.ts`;
  let mod: { default?: unknown };
  try {
    mod = (await import(/* @vite-ignore */ path)) as { default?: unknown };
  } catch (e) {
    return { problems: [`The plugin didn't load: ${e instanceof Error ? e.message : String(e)}`], peakDb: null };
  }
  const registry = new PluginRegistry();
  registerBuiltinPlugins(registry);
  const exported = Array.isArray(mod.default) ? mod.default : [mod.default];
  registry.sync(
    'user',
    exported.map((def, i) => ({ path: `${path}#${i}`, def })),
  );
  const problems = registry.loadErrors().map((e) => `The definition is invalid: ${e.error}`);
  const defs = exported.filter((d): d is PluginDef => !!d && typeof d === 'object' && !!registry.get((d as PluginDef).id));
  if (defs.length === 0 && problems.length === 0) problems.push('index.ts has no plugin definition as its default export.');
  let peak = 0;
  for (const def of defs) {
    const faults: string[] = [];
    const { project, patternId } = projectFor(def, registry.get('agstudio.3xosc'));
    let rendered: Awaited<ReturnType<typeof renderOffline>>;
    try {
      rendered = await renderOffline(project, {
        plugins: registry,
        view: { mode: 'pattern', patternId, loop: null },
        bars: 1,
        sampleRate: SR,
        tail: 1,
        onPluginFault: (_owner, _id, err) => faults.push(err instanceof Error ? err.message : String(err)),
      });
    } catch (e) {
      problems.push(`${def.name} failed to render: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    for (const f of faults) problems.push(`${def.name} failed while playing: ${f}`);
    if (!rendered.synced) problems.push(`${def.name}'s audio code didn't answer in time.`);
    let bad = 0;
    let p = 0;
    for (let c = 0; c < rendered.buffer.numberOfChannels; c++) {
      const data = rendered.buffer.getChannelData(c);
      for (let i = 0; i < data.length; i++) {
        const x = data[i] as number;
        if (!Number.isFinite(x)) bad++;
        else if (Math.abs(x) > p) p = Math.abs(x);
      }
    }
    peak = Math.max(peak, p);
    if (bad > 0) problems.push(`${def.name} produced invalid samples (NaN or Infinity).`);
    // The master's safety limiter caps the output just under 0 dBFS: hitting it means far too loud.
    if (p >= 0.95) problems.push(`${def.name} is far too loud at its default settings (it hits the master limiter).`);
    if (p < 1e-4)
      problems.push(
        def.kind === 'instrument'
          ? `${def.name} made no sound when playing notes.`
          : `${def.name} let no audio through (a synth chord went in, silence came out).`,
      );
  }
  return { problems: [...problems, ...errors.map((e) => `Error while testing: ${e}`)], peakDb: peak > 0 ? 20 * Math.log10(peak) : null };
}

void test().then(
  (report) => parent.postMessage({ nonce, report }, location.origin),
  (e: unknown) =>
    parent.postMessage(
      { nonce, report: { problems: [`The test failed: ${e instanceof Error ? e.message : String(e)}`], peakDb: null } },
      location.origin,
    ),
);
