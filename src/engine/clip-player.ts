import { GraphVoices, type InstrumentInstance } from '@agstudio/sdk';

/**
 * The "instrument" of an audio-clip channel: plays the channel's sample from the clip's trim
 * point (`NoteOn.offset`) until the clip ends (its noteOff), with short fades.
 */
export function createClipPlayer(ctx: BaseAudioContext, buffer: () => AudioBuffer | null): InstrumentInstance {
  const out = new GainNode(ctx);
  const voices = new GraphVoices(ctx, out, { max: 8 });
  return {
    output: out,
    tailTime: 0.05,
    noteOn({ time, noteId, offset }) {
      const buf = buffer();
      if (!buf) return;
      const t = Math.max(time, ctx.currentTime);
      // Late events start further into the sample so they stay in time.
      const off = Math.max(0, (offset ?? 0) + (t - time));
      if (off >= buf.duration) return;
      const src = new AudioBufferSourceNode(ctx, { buffer: buf });
      const vca = new GainNode(ctx, { gain: 0 });
      src.connect(vca);
      vca.gain.setValueAtTime(0, t);
      vca.gain.linearRampToValueAtTime(1, t + 0.002);
      src.start(t, off);
      voices.add(noteId, {
        start: t,
        sources: [src],
        out: vca,
        end: t + (buf.duration - off),
        release: (rt) => {
          vca.gain.cancelAndHoldAtTime(rt);
          vca.gain.linearRampToValueAtTime(0, rt + 0.004);
          return rt + 0.005;
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
}
