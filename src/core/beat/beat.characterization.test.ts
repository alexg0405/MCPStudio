/**
 * Characterization of the offline beat generator and the beat-spec validator: a fingerprint (a hash of
 * the whole result, plus its title, message and track names) of the beat written for every style, for a
 * spread of prompts (keys, tempos, density words, 808s, melodies, no hats, drums only), and for performed
 * drums, 808 lines and melodies; then the validator's output (spec and warnings) for generated beats
 * and a few thousand seeded corruptions of them.
 *
 * It exists so the generator can be reorganised without changing a single note. If a deliberate change makes
 * it fail, review the cause and regenerate the snapshot with `vitest -u`.
 */
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../io/hash';
import { mulberry32 } from '../voice/test-signals';
import { generateLocalBeat, mergeOfflinePrompt, parsePrompt, type LocalBeatInput, type PerformedEvent } from './local';
import { validateBeatSpec } from './spec';
import { STYLES } from './style';

async function fingerprint(value: unknown): Promise<string> {
  const hash = await sha256Hex(new TextEncoder().encode(JSON.stringify(value)));
  return hash.slice(0, 16);
}

const STYLE_PHRASES: Record<string, string> = {
  trap: 'dark trap beat',
  drill: 'uk drill',
  boombap: 'boom bap',
  lofi: 'lo-fi chill',
  house: 'house',
  edm: 'edm festival',
  reggaeton: 'reggaeton dembow',
  afro: 'afrobeats',
  pop: 'pop radio',
  bigroom: 'big room',
  proghouse: 'progressive house',
  futurebass: 'future bass',
  dubstep: 'dubstep riddim',
  melodicdub: 'melodic dubstep',
  techhouse: 'tech house',
  trance: 'trance',
  dnb: 'drum and bass',
};

function drumEvents(seed: number, kinds: PerformedEvent['kind'][]): PerformedEvent[] {
  const rand = mulberry32(seed);
  const events: PerformedEvent[] = [];
  for (let step = 0; step < 32; step += 2) {
    if (rand() < 0.4) continue;
    events.push({
      step: step + (rand() < 0.2 ? 1 : 0),
      lengthSteps: 1,
      kind: kinds[Math.floor(rand() * kinds.length)] as PerformedEvent['kind'],
      strength: 0.3 + rand() * 0.7,
      pitch: null,
      pitchEnd: null,
    });
  }
  return events;
}

function hummedEvents(seed: number, glide: boolean): PerformedEvent[] {
  const rand = mulberry32(seed);
  const events: PerformedEvent[] = [];
  let step = 0;
  while (step < 28) {
    const pitch = 40 + Math.round(rand() * 14) + (rand() < 0.5 ? 0.2 : 0);
    const lengthSteps = 1 + Math.floor(rand() * 5);
    events.push({
      step,
      lengthSteps,
      kind: 'tonal',
      strength: 0.2 + rand() * 0.8,
      pitch,
      pitchEnd: glide && rand() < 0.4 ? pitch + 3 : pitch,
    });
    step += lengthSteps + (rand() < 0.3 ? 1 : 0);
  }
  return events;
}

function cases(): { label: string; input: LocalBeatInput }[] {
  const list: { label: string; input: LocalBeatInput }[] = [];
  const add = (label: string, prompt: string, bpm = 120, performance?: LocalBeatInput['performance']) =>
    list.push({ label, input: { prompt, bpm, performance } });
  for (const style of STYLES) add(`style ${style}`, STYLE_PHRASES[style] as string);
  for (const style of STYLES)
    add(`style ${style} busy in A minor`, `${STYLE_PHRASES[style]} busy in A minor at 128 bpm`);
  for (const style of ['trap', 'boombap', 'house', 'dnb', 'dubstep', 'pop', 'lofi']) {
    add(`style ${style} simple, no hats`, `${STYLE_PHRASES[style]} simple no hats`);
    add(`style ${style} 808s in C major`, `${STYLE_PHRASES[style]} with 808s in C major`);
    add(`style ${style} drums only`, `${STYLE_PHRASES[style]} drums only at 90`);
    add(`style ${style} melody`, `${STYLE_PHRASES[style]} with a lead melody in D# minor`);
  }
  add('nothing named', 'something nice');
  add('808 only', 'heavy 808s');
  add('neuro dnb', 'neurofunk reese drum and bass');
  add('flat key', 'lofi in Bb major, calm');
  add('tempo out of range', 'trap at 20 bpm');
  add('last tempo wins', 'trap at 100 bpm, make it 150 bpm');
  add('same tempo as project', 'trap at 120 bpm', 120);
  add('empty', '');
  for (const style of ['trap', 'drill', 'house', 'dnb', 'lofi', 'trance', 'afro']) {
    add(`${style} beatboxed`, STYLE_PHRASES[style] as string, 120, {
      events: drumEvents(3, ['kick', 'snare', 'hat']),
      role: 'drums',
      bars: 2,
    });
    add(`${style} beatboxed kicks only`, STYLE_PHRASES[style] as string, 120, {
      events: drumEvents(4, ['kick']),
      role: 'auto',
      bars: 1,
    });
    add(`${style} hummed 808`, STYLE_PHRASES[style] as string, 120, {
      events: hummedEvents(5, true),
      role: '808',
      bars: 2,
    });
    add(`${style} hummed auto`, `${STYLE_PHRASES[style]} in F minor`, 120, {
      events: hummedEvents(6, false),
      role: 'auto',
      bars: 4,
    });
    add(`${style} hummed melody`, `${STYLE_PHRASES[style]} melody in G minor`, 120, {
      events: hummedEvents(7, true),
      role: 'melody',
      bars: 2,
    });
  }
  add('no events', 'trap', 120, { events: [], role: 'drums', bars: 2 });
  add('mixed events', 'trap', 120, {
    events: [...drumEvents(8, ['kick', 'snare']), ...hummedEvents(9, false)],
    role: 'auto',
    bars: 2,
  });
  return list;
}

describe('beat generator characterization', () => {
  it('writes the same beat for every prompt and performance', async () => {
    const lines: string[] = [];
    for (const { label, input } of cases()) {
      const spec = generateLocalBeat(input);
      const validated = validateBeatSpec(spec);
      const notes = spec.tracks.reduce((sum, t) => sum + t.notes.length, 0);
      lines.push(
        `${label}: ${await fingerprint(spec)} ${await fingerprint(validated)} | ${spec.title} | ${spec.bars} bars ${notes} notes | ${spec.tracks.map((t) => t.name).join('/')} | ${spec.message}`,
      );
    }
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('./__snapshots__/beat-generator.txt');
  });

  it('reads prompts the same way', () => {
    const prompts = [
      'dark trap 808s at 140 in F minor',
      'make it busier, 90s hip hop',
      'lofi in Bb major',
      'in c#',
      'play in a flat minor at 75 beats per minute',
      'drums only please, no hi-hats',
      'something simple and calm',
      'e minor',
      'a',
      'at 300',
    ];
    const lines = prompts.map((p) => `${p}: ${JSON.stringify(parsePrompt(p))}`);
    lines.push(`merged: ${mergeOfflinePrompt('trance in D minor, no hats', 'now make it drill at 150 bpm')}`);
    lines.push(`merged same style: ${mergeOfflinePrompt('trap in D minor', 'busier please')}`);
    expect(lines.join('\n') + '\n').toMatchSnapshot();
  });

  it('validates corrupted beats the same way', async () => {
    const base = generateLocalBeat({ prompt: 'trap 808s with a melody in F minor', bpm: 140 });
    const rand = mulberry32(99);
    const junk: unknown[] = [null, undefined, 'x', -5, 1e9, NaN, {}, [], { step: 1 }, true];
    const corrupt = (value: unknown, depth: number): unknown => {
      if (Array.isArray(value)) {
        const copy = value.map((v) => (rand() < 0.15 ? junk[Math.floor(rand() * junk.length)] : corrupt(v, depth + 1)));
        if (rand() < 0.1)
          copy.splice(Math.floor(rand() * (copy.length + 1)), 0, junk[Math.floor(rand() * junk.length)]);
        return copy;
      }
      if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) {
          const r = rand();
          if (r < 0.06) continue;
          out[k] = r < 0.2 ? junk[Math.floor(rand() * junk.length)] : corrupt(v, depth + 1);
        }
        return out;
      }
      if (typeof value === 'number' && rand() < 0.2) return value * (rand() < 0.5 ? -3 : 1000.37);
      return value;
    };
    const lines: string[] = [];
    let accepted = 0;
    for (let i = 0; i < 400; i++) {
      const result = validateBeatSpec(i === 0 ? base : corrupt(base, 0));
      if (!('error' in result)) accepted++;
      lines.push(await fingerprint(result));
    }
    lines.push(`accepted ${accepted} of 400`);
    expect(lines.length).toBe(401);
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('./__snapshots__/beat-validator.txt');
  });
});
