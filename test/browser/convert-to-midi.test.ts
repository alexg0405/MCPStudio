/**
 * Convert to MIDI through the real engine (headless Chrome): the audition of a drum loop (the notes through Drum Pads with the
 * recording's own hits) sounds like the loop, and a melody written as notes and played by the Pluck is heard at the pitches that
 * were sung. The listening and planning themselves are checked in core/audio/transcribe and app/transcribe.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { addAudioClip } from '@app/actions/samples';
import { opfsSampleProvider } from '@app/persistence/project-io';
import { importSampleBytes } from '@app/persistence/sample-import';
import { createServices, type Services } from '@app/services';
import { buildAudition } from '@app/transcribe/audition';
import { convertToMidi } from '@app/transcribe/convert';
import { detectDrums } from '@core/audio/transcribe/drums';
import { detectMelody } from '@core/audio/transcribe/melody';
import { settingsFor } from '@core/audio/transcribe';
import { encodeWav } from '@core/io/wav';
import type { AudioClip, ClipId } from '@core/model/types';
import { renderOffline } from '@engine/render-offline';
import { BEATS, drumLoop, scoreHits, scoreNotes, sungMelody, TRANSCRIBE_RATE } from '../helpers/transcribe-signals';

const SR = TRANSCRIBE_RATE;

/** Services with one audio clip (a stored 24-bit WAV of `sound`) at the start of the song, at 120 BPM. */
async function withClip(sound: Float32Array, name: string): Promise<{ s: Services; clipId: ClipId }> {
  const s = createServices({});
  s.history.transact('Tempo', (d) => void (d.transport.bpm = 120));
  const ref = { ...(await importSampleBytes(encodeWav([sound], SR, { bitDepth: 24 }), `${name}.wav`)), durationSec: sound.length / SR, sampleRate: SR, channels: 1 };
  const lane = s.doc.getState().project.playlist.laneOrder[0]!;
  addAudioClip(s, ref, lane, 0);
  const clip = Object.values(s.doc.getState().project.playlist.clips).find((c): c is AudioClip => c.kind === 'audio')!;
  return { s, clipId: clip.id };
}

/** A decoded mono copy of WAV bytes. */
async function decode(bytes: Uint8Array): Promise<Float32Array> {
  const buffer = await new OfflineAudioContext(1, 1, SR).decodeAudioData(bytes.slice().buffer as ArrayBuffer);
  return buffer.getChannelData(0);
}

describe('convert to MIDI in the engine', () => {
  const services: Services[] = [];
  afterAll(async () => {
    for (const s of services) await s.engine.dispose();
  });

  it('the audition of a drum loop sounds like the loop: the same hits, the same kinds, within 15 ms, 90 % or more', async () => {
    const loop = drumLoop({ bpm: 120, bars: 2, patterns: [BEATS.house ?? []] });
    const { s, clipId } = await withClip(loop.mono, 'House');
    services.push(s);
    const audition = await buildAudition(s, { clip: clipId, settings: settingsFor('drums'), target: { kind: 'new' } });
    expect(audition.seconds).toBeGreaterThan(3.5);
    const rate = s.engine.sampleRate;
    const audio = await decode(audition.wav.audio);
    const midi = await decode(audition.wav.midi);
    // The audio side is the loop as the engine plays it; the MIDI side must have the same hits at the same moments.
    const wanted = detectDrums(audio, rate).hits;
    const got = detectDrums(midi, rate).hits;
    const score = scoreHits(wanted, got, 0.015);
    expect(wanted.length).toBeGreaterThanOrEqual(18);
    expect(Math.round((100 * score.rightKind) / wanted.length), score.problems.slice(0, 8).join('; ')).toBeGreaterThanOrEqual(90);
    // Nothing of the project changed while listening.
    expect(Object.values(s.doc.getState().project.playlist.clips).filter((c) => c.kind === 'pattern')).toHaveLength(0);
  });

  it('a sung melody written as notes and played by the FM synth is heard at the pitches that were sung', async () => {
    const line = sungMelody({ steps: [[60, 0.6, 0.1], [64, 0.6, 0.1], [67, 0.6, 0.1], [72, 0.7, 0.1], [69, 0.6, 0.1], [65, 0.8]] , start: 0.1 });
    const { s, clipId } = await withClip(line.mono, 'Sung');
    services.push(s);
    const result = await convertToMidi(s, { clip: clipId, settings: settingsFor('melody'), target: { kind: 'new', plugin: 'agstudio.fm' }, muteOriginal: true });
    expect(result.notes).toBe(6);
    const rendered = await renderOffline(s.doc.getState().project, {
      plugins: s.plugins,
      samples: opfsSampleProvider(),
      view: { mode: 'song', patternId: null, loop: null },
      bars: 2,
      sampleRate: SR,
      tail: 0.4,
    });
    const start = Math.round((rendered.preRoll + rendered.latency) * SR);
    const heard = detectMelody(rendered.buffer.getChannelData(0).slice(start), SR).map((n) => ({ fromSec: n.fromSec, pitch: n.pitch }));
    const score = scoreNotes(line.notes, heard, 0.06, 0.6);
    expect(Math.round((100 * score.right) / score.played), score.problems.join('; ')).toBeGreaterThanOrEqual(90);
  });
});
