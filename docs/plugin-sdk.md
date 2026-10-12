# Writing AGstudio plugins

AGstudio's instruments and effects are plugins: TypeScript modules written against `@agstudio/sdk`.
The built-ins (Sampler, 3xOsc, Pluck, and later the mixer effects) use exactly the same API you do,
so anything they can do, your plugins can do.

## Quick start

```bash
npm run new:plugin -- --kind instrument --style graph --id user.my-synth
```

That creates `plugins/my-synth/`. With `npm run dev` running it appears in the browser panel
(Plugins → click to add a channel). Edit it and save: it hot-reloads and keeps its knob settings.

- `--kind instrument|effect`. Effects go in mixer insert slots (the mixer arrives in M5).
- `--style graph` builds the sound from native Web Audio nodes (oscillators, filters, gains). This is
  the easiest style, it's cheap on CPU, and every built-in except Pluck uses it.
- `--style worklet` writes your own per-sample DSP in an AudioWorklet kernel (Karplus-Strong,
  custom filters, granular, anything). See `src/plugins/builtin/pluck` for a full example.

Plugins live in `plugins/<folder>/index.ts` (or `.tsx`). Folders starting with `_` are ignored, so
rename a folder to `_my-synth` to disable it. A plugin that fails to load shows up in red in the
browser panel with the error; the rest of the app keeps working.

Plugins are trusted code: they run in the app's JavaScript context, just like the built-ins.

## Anatomy of a plugin (graph style)

```ts
import { dbToGain, defineInstrument, GraphVoices, mtof, p } from '@agstudio/sdk';

export default defineInstrument({
  id: 'user.sub-bass',          // never change once projects use it
  name: 'Sub Bass',
  version: 1,                   // bump on breaking param/state changes (see migrate)
  category: 'Synths',
  params: {
    wave: p.enum(['sine', 'triangle'], 'sine'),
    release: p.float(0.005, 2, 0.15, { scale: 'log', unit: 's' }),
    level: p.float(-60, 6, -6, { scale: 'db', unit: 'dB' }),
  },
  create({ audioContext: ac, params }) {
    const out = new GainNode(ac);
    params.level.bind(out.gain, dbToGain);           // the knob drives the AudioParam, smoothed
    const voices = new GraphVoices(ac, out, { max: 8 });
    return {
      output: out,
      noteOn({ time, key, velocity, noteId }) {
        const t = Math.max(time, ac.currentTime);
        const osc = new OscillatorNode(ac, { type: params.wave.value, frequency: mtof(key) });
        const vca = new GainNode(ac, { gain: 0 });
        osc.connect(vca);
        vca.gain.setValueAtTime(0, t);
        vca.gain.linearRampToValueAtTime(velocity, t + 0.004);
        osc.start(t);
        voices.add(noteId, {
          start: t, sources: [osc], out: vca,
          release: (rt) => {
            vca.gain.cancelAndHoldAtTime(rt);
            vca.gain.setTargetAtTime(0, rt, params.release.value / 5);
            return rt + params.release.value;
          },
        });
      },
      noteOff: ({ noteId, time }) => voices.release(noteId, time),
      allNotesOff: (time, hard) => voices.releaseAll(time, hard),
      dispose: () => { voices.disposeAll(); out.disconnect(); },
    };
  },
});
```

### Params

Declare them with `p.float(min, max, default, opts)`, `p.int`, `p.enum(options, default)` and `p.bool`.
Options: `label`, `unit` (`'Hz' | 'dB' | 'ms' | 's' | '%' | 'st' | 'ct' | 'x' | 'beats'`), `scale`
(`'linear' | 'log' | 'db'`, which controls how knob travel maps to values), `group` (a section in the
generated editor), `hint` (hint bar text) and `smoothing` (seconds).

The **host owns the values**. They live in the project, so undo, presets, saving and hot reload
come for free. Your plugin only reads them:

| API | Use |
|---|---|
| `params.x.value` | current value (read at note time) |
| `params.x.bind(audioParam, map?)` | drive an AudioParam, smoothed (no zipper noise) |
| `params.x.signal(map?)` | one shared smoothed source; `.connect(audioParam)` it to every voice so sounding notes follow the knob. Set the target's own value to 0. `.node` lets you route it through your own nodes |
| `params.x.onChange((v, time) => …)` | anything else (switching modes, rebuilding curves) |

Unit `%` means the value is 0–1 and displayed as a percentage.

### Notes and timing

`noteOn` and `noteOff` arrive **ahead of time** (the engine schedules ~120 ms ahead). Always
schedule at `e.time` and never "now". A note-off whose time is at or before its note-on means the
note was cancelled (for example, the user deleted it before it played). `GraphVoices.release()`
handles that for you. `GraphVoices` also limits polyphony, steals voices without clicks and cleans
up finished voices.

`allNotesOff(time, hard)` happens on stop (release) and on panic or plugin swap (`hard`: silence quickly).

### The host

`create(host)` receives:

| Member | |
|---|---|
| `audioContext` | realtime **or offline** (export): never create your own context |
| `params` | the handles above |
| `state` / `updateState(next)` | small JSON state for non-param data; `updateState` becomes an undoable edit and comes back through `setState()` |
| `samples` | named sample slots: `get(slot)`, `load(slot)`, `onChange(slot, cb)`, `name(slot)`. Declare `sampleSlots: ['main']` and the editor shows a sample picker |
| `channel.rootKey` | the channel's root note (steps play at it; samplers play original pitch there) |
| `transport.bpm`, `transport.onTempo(cb)` | for tempo-synced effects |
| `offline` | true while exporting |
| `signal` | an AbortSignal aborted on dispose |
| `worklet(opts)` | create your processor node (see below) |

## Worklet plugins (custom DSP)

Three files:

```
plugins/my-synth/
  params.ts        // shared: params + id (imported by both threads)
  index.ts         // main thread: defineWorkletInstrument({ ..., processor })
  dsp.worklet.ts   // audio thread: kernel class + registerKernel(ID, params, Kernel)
```

```ts
// index.ts
import { defineWorkletInstrument } from '@agstudio/sdk';
import processor from './dsp.worklet.ts?worker&url';   // exactly this import form
import { ID, params } from './params';
export default defineWorkletInstrument({ id: ID, name: 'My Synth', version: 1, params, processor });
```

```ts
// dsp.worklet.ts
import { InstrumentKernel, registerKernel, VoicePool, at, type ParamBlock } from '@agstudio/sdk/worklet';
import { ID, params } from './params';

class MySynth extends InstrumentKernel<typeof params> {
  noteOn(key: number, velocity: number, noteId: number, pan: number) { /* start a voice */ }
  noteOff(noteId: number, key: number) { /* release it */ }
  render(out: Float32Array[], from: number, to: number, p: ParamBlock<typeof params>) {
    // ADD into out[0]/out[1] for frames [from, to). at(p.level, i) reads a param at frame i.
  }
}
registerKernel(ID, params, MySynth);
```

The SDK owns the actual `AudioWorkletProcessor`. It splits each block at note events, so
`render(from, to)` runs between events and notes start on their exact sample. It also:
- catches exceptions: a faulted instrument goes silent and a faulted effect is bypassed, and you get a toast;
- silences NaN/Infinity output and calls your `reset()`;
- handles block sizes other than 128.

Effects extend `EffectKernel` and implement `process(input, output, n, params)`. In param blocks,
enums arrive as the option index and booleans as 0/1.

Optional kernel hooks: `setState(state)`, `onMessage(msg)` (from `port.send`), `onSample(slot, channels, sampleRate)`
(sample slots are copied to the audio thread for you), `reset()`, `allNotesOff(hard)`.
Use `this.host.rand()` for randomness (seeded, so exports repeat exactly) and `this.host.post(msg)`
to talk back to the main thread (rarely: at most ~30 times a second).

### Rules for audio-thread code

- No DOM, `fetch`, timers, dynamic `import()`, `import.meta.hot` or npm packages. `@agstudio/sdk/worklet`
  and your own files are fine.
- Don't allocate inside `render()`/`process()`. Create arrays and voices in the constructor, use index
  loops, and keep voice objects monomorphic (initialize every field in the class body).
- Flush tiny feedback values (`flush(x)` from the SDK) so silence never turns into denormals.
- Keep pure DSP in a separate `kernel.ts` (or `*.kernel.ts`) if you want to unit-test it in Node,
  like `src/plugins/builtin/pluck/kernel.ts`. Don't put React components in kernel or params files.

## Hot reload

| You edit | What happens |
|---|---|
| `index.ts`, or a custom UI | the plugin's instances are rebuilt in place (~10 ms); settings are kept |
| `dsp.worklet.ts`, or files only it imports | audio restarts with a fresh AudioContext (~0.2 s gap); settings are kept |
| `params.ts` (shared by both threads) | the page reloads; your project is restored automatically (click once to re-enable audio) |
| add or delete a plugin folder | it appears in or disappears from the browser; channels using a deleted plugin keep their settings and show "missing" |

## Custom editors

Without `ui`, the host generates a knob panel from your params (grouped by `group`). To draw your
own, pass a React component:

```tsx
import { Knob } from '@agstudio/sdk/ui';
function MyUI({ specs, values, beginEdit, setParam, endEdit }: PluginUIProps<typeof params>) {
  return <Knob spec={specs.cutoff} value={values.cutoff}
    onBegin={() => beginEdit('cutoff')} onChange={(v) => setParam('cutoff', v)} onEnd={() => endEdit('cutoff')} />;
}
export default defineInstrument({ ..., ui: MyUI });
```

`beginEdit` → `setParam`… → `endEdit` makes one undo step. A UI that throws shows an error card
with the generated panel underneath. `plugins/example-supersaw` is a complete example.

## Presets and versions

`presets: [{ name, params: { … } }]` adds a preset menu to the editor. Params a preset leaves out go
back to their defaults.

When you change params or state incompatibly, bump `version` and add
`migrate({ version, params, state }) => ({ params, state })`. Projects saved with older versions are
upgraded when they load.

## Testing

- Pure kernels: plain Vitest in Node (`src/plugins/builtin/pluck/kernel.test.ts` checks tuning by
  autocorrelation).
- Whole plugins: browser tests render offline in headless Chrome (`test/browser/worklet.test.ts`).
  `npm run test:audio` runs them; `npm run check` runs everything.
