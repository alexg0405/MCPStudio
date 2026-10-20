/**
 * Time-stretching without changing pitch: WSOLA (waveform-similarity overlap-add, Verhelst &
 * Roelands 1993). The output is built from Hann-windowed frames of the input, overlapped by half a
 * frame. Each frame is taken near where the stretch says it should come from, shifted by up to
 * ±tolerance to the spot that best continues the previous frame's waveform, so periodic sounds keep
 * their period (their pitch) and the frames join without phase cancellation.
 *
 * Transients (drum hits) are kept whole: plain WSOLA reads a hit into two overlapping frames at
 * slightly different times when slowing down (a flam, or a doubled click) and can skip it when
 * speeding up, and moves it by up to the tolerance. Around each detected attack the input is
 * played at its own speed instead (a run of frames that continue each other exactly, which
 * overlap-add back to the original samples), centred on the hit's stretched time, and the stretch
 * is made up in the gaps between hits (Grofit & Lavner 2008 describe the same idea). Hits closer
 * together than that allows keep the strongest ones.
 *
 * The similarity search runs on a decimated mono mix (coarse) and is refined at the full rate; every
 * channel uses the same frame positions, so the stereo image holds. Pure TypeScript (Worker or Node).
 *
 * The code is split by job in `wsola/`: `onsets.ts` (finding attacks), `zones.ts` (which to keep),
 * `time-map.ts` (output frame to input frame), `similarity.ts` (the search), `mono.ts` (the mix) and
 * `stretch.ts` (the overlap-add) and `warp.ts` (the same overlap-add along a time map that changes speed: vocal alignment). This file keeps the import path every caller uses.
 */
export { detectOnsets, detectOnsetsLazy, type MonoReader, type Onset } from './wsola/onsets';
export { stretchStream, timeStretch, type StretchOptions, type StretchSink } from './wsola/stretch';
export { WarpTimeMap, warpChannels, warpStream } from './wsola/warp';
