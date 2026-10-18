/** What the WAV encoder and the PCM decoder share: the format tags and the decoded result type. */

/** What `decodePcm` returns for a WAV or AIFF file. */
export interface DecodedPcm {
  /** The file's own rate (no resampling happens here). */
  sampleRate: number;
  /** One array per channel, nominally in [-1, 1). */
  channels: Float32Array[];
  /** Sustain loop in frames, `end` exclusive (from WAV `smpl` or AIFF `INST` + `MARK`). */
  loop?: { start: number; end: number };
  /** MIDI note at which the sample plays at its original pitch (WAV `smpl` unity note, AIFF `INST` base note). */
  rootKey?: number;
}

/** `wFormatTag` values of the WAV `fmt ` chunk (Microsoft's registry). */
export const WAVE_FORMAT_PCM = 1;
export const WAVE_FORMAT_IEEE_FLOAT = 3;
/** The real format is then in the first two bytes of the extensible format's sub-format GUID. */
export const WAVE_FORMAT_EXTENSIBLE = 0xfffe;
