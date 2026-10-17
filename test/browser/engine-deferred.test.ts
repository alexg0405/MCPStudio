/**
 * The audio engine starts after the first paint (`deferEngine`, what the app's entry point asks for): until then the
 * host answers calmly and nothing creates an AudioContext; a key, MIDI or play that comes first makes the engine and
 * waits for its instruments, so it sounds instead of vanishing. Real engine, headless Chrome.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { addInstrumentChannel } from '@app/actions/channels';
import { registerBuiltinPlugins } from '@app/plugins/discover';
import { PluginRegistry } from '@app/plugins/registry';
import { memoryPresetStorage } from '@app/presets';
import { createServices, type Services } from '@app/services';
import { createEmptyProject } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import type { ChannelId, PatternId } from '@core/model/types';
import { addNote } from '@core/ops/notes';
import { innerEngine } from '../helpers/latency';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const made: Services[] = [];
afterEach(async () => {
  for (const s of made.splice(0)) await s.engine.dispose();
});

function boot(): { s: Services; channel: ChannelId; pattern: PatternId } {
  const plugins = new PluginRegistry();
  registerBuiltinPlugins(plugins);
  const s = createServices({ plugins, project: createEmptyProject(), presetStorage: memoryPresetStorage(), deferEngine: true });
  made.push(s);
  const channel = addInstrumentChannel(s, 'agstudio.wavetable') as ChannelId;
  s.session.getState().selectChannel(channel);
  return { s, channel, pattern: s.view.getState().currentPatternId as PatternId };
}

const host = (s: Services) => s.engine as unknown as { started: boolean };

describe('deferred engine', () => {
  it('makes no AudioContext until it is needed, then hands it the project', async () => {
    const { s, channel } = boot();
    expect(host(s).started).toBe(false);
    expect(s.engine.state).toBe('suspended');
    expect(s.engine.stats().sampleRate).toBeGreaterThan(0);
    // The page can be used meanwhile: edits are remembered for the engine.
    s.history.transact('Note', (d) =>
      addNote(d, s.view.getState().currentPatternId as PatternId, channel, { id: newId.note(), tick: 0, length: 960, key: 60, velocity: 1 }),
    );
    expect(host(s).started).toBe(false);
    await s.engine.resume();
    expect(host(s).started).toBe(true);
    await s.engine.ready();
    const inner = innerEngine(s.engine);
    expect(inner.ctx.state).toBeDefined();
    expect((inner as unknown as { strips: Map<string, unknown> }).strips.has(channel)).toBe(true);
  });

  it('plays a note pressed before the engine existed once its instrument has loaded', async () => {
    const { s, channel } = boot();
    expect(host(s).started).toBe(false);
    const played: number[] = [];
    // A key straight away: it makes the engine, whose instrument is still loading.
    s.live.noteOn(60, 0.8, { source: 'typing' });
    expect(host(s).started).toBe(true);
    const inner = innerEngine(s.engine);
    const on = inner.previewNoteOn.bind(inner);
    inner.previewNoteOn = (c, k, v) => (played.push(k), on(c, k, v));
    expect(played).toEqual([]);
    await s.engine.ready();
    await sleep(50);
    // It reached the engine after the sounds were in (a held key: still sounding).
    expect(played).toEqual([60]);
    expect(channel).toBeTruthy();
    s.live.noteOff(60, 0.5, { source: 'typing' });
  });

  it('plays when play is pressed straight away, once the sounds have loaded', async () => {
    const { s, channel, pattern } = boot();
    s.history.transact('Note', (d) =>
      addNote(d, pattern, channel, { id: newId.note(), tick: 0, length: 960, key: 60, velocity: 1 }),
    );
    s.engine.play(0);
    expect(s.engine.playing).toBe(true);
    await s.engine.ready();
    await sleep(100);
    expect(innerEngine(s.engine).playing).toBe(true);
    s.engine.stop();
    expect(s.engine.playing).toBe(false);
  });
});
