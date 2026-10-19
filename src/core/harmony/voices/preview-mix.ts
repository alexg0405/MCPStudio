/**
 * The preview of harmonies in the dialog: the lead and the voices mixed to stereo the way their channels will mix (level in dB,
 * equal-power pan), so the musician can hear the stack, and the lead alone, before anything is added to the song.
 */

/** A voice in the preview mix. */
export interface PreviewVoice {
  /** The voice's audio (planar), as long as the lead's part. */
  channels: readonly Float32Array[];
  levelDb: number;
  /** −1 (left) … 1 (right). */
  pan: number;
}

/** The loudest the preview may be: it is turned down to this when the mix would pass it. */
const PREVIEW_CEILING = 0.95;

/** Planar audio as mono (the average of its channels). */
function toMono(channels: readonly Float32Array[]): Float32Array {
  const length = channels[0]?.length ?? 0;
  const mono = new Float32Array(length);
  const share = 1 / Math.max(1, channels.length);
  for (const channel of channels) for (let i = 0; i < length; i++) mono[i] = (mono[i] as number) + (channel[i] as number) * share;
  return mono;
}

/** Equal-power gains (left, right) of a pan position. */
export function panGains(pan: number): { left: number; right: number } {
  const angle = ((Math.max(-1, Math.min(1, pan)) + 1) * Math.PI) / 4;
  return { left: Math.cos(angle), right: Math.sin(angle) };
}

/** Both ears of a preview. */
export type StereoPreview = [Float32Array, Float32Array];

/** The two things the dialog lets the musician compare, at the same level. */
export interface PreviewMixes {
  leadOnly: StereoPreview;
  withHarmonies: StereoPreview;
}

/**
 * The lead (kept as it is: a stereo lead stays stereo, a mono one goes to both sides) alone, and with each voice at its level and
 * pan. Both are turned down by the same amount when the stack would pass the ceiling, so switching between them changes only the harmonies.
 */
export function previewMix(lead: readonly Float32Array[], voices: readonly PreviewVoice[]): PreviewMixes {
  const length = lead[0]?.length ?? 0;
  const leftLead = Float32Array.from(lead[0] ?? new Float32Array(0));
  const rightLead = Float32Array.from(lead[1] ?? lead[0] ?? new Float32Array(0));
  const left = Float32Array.from(leftLead);
  const right = Float32Array.from(rightLead);
  for (const voice of voices) {
    const mono = toMono(voice.channels);
    const gain = Math.pow(10, voice.levelDb / 20);
    const pan = panGains(voice.pan);
    // Equal power puts a centred voice 3 dB down in each ear; scaling by √2 keeps a centred voice at its channel level.
    const l = gain * pan.left * Math.SQRT2;
    const r = gain * pan.right * Math.SQRT2;
    for (let i = 0; i < length; i++) {
      left[i] = (left[i] as number) + (mono[i] as number) * l;
      right[i] = (right[i] as number) + (mono[i] as number) * r;
    }
  }
  let peak = 0;
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(left[i] as number), Math.abs(right[i] as number));
  const scale = peak > PREVIEW_CEILING ? PREVIEW_CEILING / peak : 1;
  if (scale !== 1) {
    for (const buffer of [left, right, leftLead, rightLead]) for (let i = 0; i < length; i++) buffer[i] = (buffer[i] as number) * scale;
  }
  return { leadOnly: [leftLead, rightLead], withHarmonies: [left, right] };
}
