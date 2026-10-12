/**
 * Example user plugin: a supersaw (several detuned saw waves per note) built from native Web Audio
 * nodes, with a custom editor. Copy this folder to start your own, or run
 *   npm run new:plugin -- --kind instrument --style graph --id user.my-synth
 * Edit anything here while `npm run dev` runs: the plugin hot-reloads and keeps its settings.
 */
import { dbToGain, defineInstrument, GraphVoices, mtof, p, type PluginUIProps } from '@agstudio/sdk';
import { Knob } from '@agstudio/sdk/ui';

const params = {
  saws: p.int(1, 9, 7, { label: 'Saws', group: 'Oscillators', hint: 'Saw waves per note' }),
  detune: p.float(0, 100, 22, { label: 'Detune', unit: 'ct', group: 'Oscillators' }),
  spread: p.float(0, 1, 0.8, { label: 'Spread', unit: '%', group: 'Oscillators', hint: 'Stereo width of the saws' }),
  cutoff: p.float(40, 18000, 6000, { label: 'Cutoff', unit: 'Hz', scale: 'log', group: 'Filter' }),
  resonance: p.float(0.1, 12, 0.7, { label: 'Resonance', scale: 'log', group: 'Filter' }),
  attack: p.float(0.001, 3, 0.01, { label: 'Attack', unit: 's', scale: 'log', group: 'Envelope' }),
  release: p.float(0.01, 5, 0.4, { label: 'Release', unit: 's', scale: 'log', group: 'Envelope' }),
  level: p.float(-36, 6, -12, { label: 'Level', unit: 'dB', scale: 'db', group: 'Output' }),
};

type Specs = typeof params;

/** A custom editor: any React component works; the SDK's Knob matches the host's look. */
function SupersawUI({ specs, values, beginEdit, setParam, endEdit }: PluginUIProps<Specs>) {
  const knob = (id: keyof Specs, size = 42) => (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 56 }}>
      <Knob
        spec={specs[id]}
        value={values[id]}
        size={size}
        onBegin={() => beginEdit(id)}
        onChange={(v) => setParam(id, v)}
        onEnd={() => endEdit(id)}
        onCommit={(v) => setParam(id, v)}
      />
      <span style={{ fontSize: 10, color: 'var(--ag-text-dim)' }}>{specs[id].label}</span>
    </div>
  );
  return (
    <div style={{ padding: 14 }}>
      <div
        style={{ fontSize: 22, fontWeight: 200, letterSpacing: '0.2em', color: 'var(--ag-accent)', marginBottom: 12 }}
      >
        SUPERSAW
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
        {knob('saws')}
        {knob('detune', 56)}
        {knob('spread')}
        {knob('cutoff', 56)}
        {knob('resonance')}
        {knob('attack')}
        {knob('release')}
        {knob('level')}
      </div>
    </div>
  );
}

export default defineInstrument({
  id: 'user.example-supersaw',
  name: 'Supersaw (example)',
  version: 1,
  category: 'Synths',
  description: 'Example user plugin: detuned saw stack with a custom editor.',
  params,
  ui: SupersawUI,

  create({ audioContext: ac, params: P }) {
    const out = new GainNode(ac);
    P.level.bind(out.gain, dbToGain);
    const voices = new GraphVoices(ac, out, { max: 12 });
    // Shared, smoothed control signals: turning a knob updates every sounding note.
    const detune = P.detune.signal();
    const cutoff = P.cutoff.signal();
    const q = P.resonance.signal();

    return {
      output: out,
      tailTime: 1,

      noteOn({ time, key, velocity, noteId }) {
        const t = Math.max(time, ac.currentTime);
        const n = P.saws.value;
        const filter = new BiquadFilterNode(ac, { type: 'lowpass', frequency: 0, Q: 0 });
        const vca = new GainNode(ac, { gain: 0 });
        filter.connect(vca);
        const cleanup = [cutoff.connect(filter.frequency), q.connect(filter.Q)];
        const sources: AudioScheduledSourceNode[] = [];
        const nodes: AudioNode[] = [filter];
        for (let i = 0; i < n; i++) {
          // Spread each saw from -1..1 in detune and stereo position.
          const pos = n === 1 ? 0 : (i / (n - 1)) * 2 - 1;
          const osc = new OscillatorNode(ac, { type: 'sawtooth', frequency: mtof(key), detune: 0 });
          const amount = new GainNode(ac, { gain: pos });
          detune.node.connect(amount).connect(osc.detune);
          const pan = new StereoPannerNode(ac, { pan: pos * P.spread.value });
          const g = new GainNode(ac, { gain: 1 / Math.sqrt(n) });
          osc.connect(g).connect(pan).connect(filter);
          osc.start(t);
          sources.push(osc);
          nodes.push(amount, pan, g);
          cleanup.push(() => detune.node.disconnect(amount));
        }
        vca.gain.setValueAtTime(0, t);
        vca.gain.linearRampToValueAtTime(velocity, t + P.attack.value);
        voices.add(noteId, {
          start: t,
          sources,
          out: vca,
          nodes,
          cleanup,
          release: (rt) => {
            const r = P.release.value;
            vca.gain.cancelAndHoldAtTime(rt);
            vca.gain.setTargetAtTime(0, rt, r / 5);
            return rt + r;
          },
        });
      },

      noteOff: ({ noteId, time }) => voices.release(noteId, time),
      allNotesOff: (time, hard) => voices.releaseAll(time, hard),
      dispose: () => {
        voices.disposeAll();
        out.disconnect();
      },
    };
  },
});
