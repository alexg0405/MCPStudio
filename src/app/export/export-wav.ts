import type { RenderResult } from '@engine/render-offline';

/**
 * What every audio export shares: trimming a render to the music (pre-roll and the mixer's delay
 * compensation off the front, the silence after the last tail off the end), and the export's
 * error and progress types. The pipeline itself is audio-export.ts.
 */
export type WavFormat = 'pcm16' | 'pcm24' | 'float32';

export class ExportError extends Error {}

export interface ExportProgress {
  stage: 'render' | 'encode';
  /** 0..1 over the whole export. */
  fraction: number;
}

/** Below this the tail counts as silence (-90 dBFS, under one 16-bit step). */
const SILENCE = 10 ** (-90 / 20);

/** The music from its first beat to the end of the last audible tail. */
export function trimRender(buffer: AudioBuffer, preRoll: number, musicSeconds: number): Float32Array[] {
  const sr = buffer.sampleRate;
  const start = Math.min(buffer.length, Math.round(preRoll * sr));
  const musicEnd = Math.min(buffer.length, start + Math.ceil(musicSeconds * sr));
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  let end = musicEnd;
  for (const ch of channels) {
    for (let i = ch.length - 1; i >= end; i--) {
      if (Math.abs(ch[i] as number) > SILENCE) {
        end = i + 1;
        break;
      }
    }
  }
  end = Math.min(buffer.length, end + Math.round(0.01 * sr));
  return channels.map((ch) => ch.slice(start, end));
}

/**
 * What an export keeps of a render: from where the music is heard (after the pre-roll and the
 * mixer's delay compensation, which holds the whole mix back) to the end of its tail.
 */
export function trimExport(result: RenderResult, musicSeconds: number): Float32Array[] {
  return trimRender(result.buffer, result.preRoll + result.latency, musicSeconds);
}
