/**
 * Pad sounds from the recording itself: each drum kind's clean example (`PlannedPad`) is cut out of the clip's sound, given a
 * short fade at the end so it does not click, and stored through the sample store as a 24-bit WAV, ready to go into the Drum
 * Pads' sample slots. The recording is not changed.
 */
import { padSlot } from '@core/samples/kit';
import { encodeWav } from '@core/io/wav';
import type { PlannedPad } from '@core/audio/transcribe';
import type { SampleRef } from '@core/model/types';
import { importSampleBytes } from '../persistence/sample-import';
import type { Source } from './source';

/** The fade at the end of a cut (s). */
const FADE_OUT_SEC = 0.006;
/** The fade at its start (s): a cut taken from the middle of a sound must not click on. */
const FADE_IN_SEC = 0.001;

/** The name of each kind for a pad's sample ("Kick", "Open hat"). */
const KIND_NAMES: Readonly<Record<string, string>> = { kick: 'Kick', snare: 'Snare', clap: 'Clap', hat: 'Hat', 'open-hat': 'Open hat', tom: 'Tom', cymbal: 'Cymbal', perc: 'Perc' };

/** One cut of the sound: every channel from `fromSec` to `toSec`, faded at both ends. */
export function cutOf(source: Source, pad: Pick<PlannedPad, 'fromSec' | 'toSec'>): Float32Array[] {
  const rate = source.data.sampleRate;
  const total = source.data.channels[0]?.length ?? 0;
  const from = Math.max(0, Math.min(total, Math.round(pad.fromSec * rate)));
  const to = Math.max(from + 1, Math.min(total, Math.round(pad.toSec * rate)));
  const fadeIn = Math.min(to - from, Math.round(FADE_IN_SEC * rate));
  const fadeOut = Math.min(to - from, Math.round(FADE_OUT_SEC * rate));
  return source.data.channels.map((channel) => {
    const out = channel.slice(from, to);
    for (let i = 0; i < fadeIn; i++) out[i] = (out[i] as number) * (i / fadeIn);
    for (let i = 0; i < fadeOut; i++) out[out.length - 1 - i] = (out[out.length - 1 - i] as number) * (i / fadeOut);
    return out;
  });
}

/** What was stored for one pad: which sample slot of the Drum Pads it goes in, and the sample. */
export interface StoredPad {
  slot: string;
  sample: SampleRef;
}

/** Cuts and stores the pads' sounds. `name` is the recording's name, used to name each sample. */
export async function storePads(source: Source, pads: readonly PlannedPad[], name: string): Promise<StoredPad[]> {
  const stored: StoredPad[] = [];
  for (const pad of pads) {
    const channels = cutOf(source, pad);
    const bytes = encodeWav(channels, source.data.sampleRate, { bitDepth: 24 });
    const label = `${name} ${KIND_NAMES[pad.kind] ?? pad.kind}`.slice(0, 100);
    const ref = await importSampleBytes(bytes, `${label}.wav`);
    const frames = channels[0]?.length ?? 0;
    stored.push({
      slot: padSlot(pad.pad),
      sample: { ...ref, durationSec: frames / source.data.sampleRate, sampleRate: source.data.sampleRate, channels: channels.length },
    });
  }
  return stored;
}
