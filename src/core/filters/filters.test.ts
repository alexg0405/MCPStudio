import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { tempoMapOf } from '../automation/tempo';
import { createEmptyProject } from '../model/defaults';
import { MASTER, type AudioClipChannel, type ChannelId, type Clip, type ClipId, type LaneId, type MarkerId, type PatternId, type Project, type SampleId } from '../model/types';
import { addMarker } from '../ops/markers';
import { changePartTempo, cutPart, emptyInsert, filtersOver, removeSoundFilter } from '../ops/filters';
import { addInsert } from '../ops/mixer';
import { makeInsert } from '../model/defaults';
import { FILTERS, findFilter, lengthNote, pitchLabel, speedCents, speedOf } from './presets';
import { clipsTarget, defaultTarget, filterPart, markerTarget, rangeTarget, songTarget, spotTarget, targetLabel } from './target';

const BAR = 3840;

/** A 16-bar song: one pattern clip per 4 bars on track 1, one 16-bar clip on track 2, a marker at bar 9. */
function song(): Project {
  const base = createEmptyProject();
  const pid = base.patternOrder[0] as PatternId;
  const [l1, l2] = base.playlist.laneOrder as LaneId[];
  return produce(base, (d) => {
    d.transport.bpm = 120;
    for (let i = 0; i < 4; i++)
      d.playlist.clips[`c${i}` as ClipId] = { kind: 'pattern', id: `c${i}` as ClipId, laneId: l1!, start: i * 4 * BAR, length: 4 * BAR, patternId: pid, offset: 0 };
    d.playlist.clips['long' as ClipId] = { kind: 'pattern', id: 'long' as ClipId, laneId: l2!, start: 0, length: 16 * BAR, patternId: pid, offset: 0 };
    addMarker(d, 0, 'Intro');
    addMarker(d, 8 * BAR, 'Chorus');
  });
}

const ids = (prefix: string) => {
  let n = 0;
  return () => `${prefix}${n++}` as ClipId;
};

describe('filter presets', () => {
  it('has unique ids, a description and only built-in effects', () => {
    expect(new Set(FILTERS.map((f) => f.id)).size).toBe(FILTERS.length);
    for (const f of FILTERS) {
      expect(f.description.length).toBeGreaterThan(5);
      expect(f.group === 'speed').toBe(speedOf(f) !== 1);
      for (const fx of f.fx) expect(fx.plugin).toMatch(/^agstudio\./);
      // A tone filter does something: an effect or a reverse.
      if (f.group === 'tone') expect(f.fx.length > 0 || f.reverse).toBe(true);
    }
  });

  it('finds filters by id, name and the words people use', () => {
    expect(findFilter('nightcore')?.id).toBe('nightcore');
    expect(findFilter('Slowed + Reverb')?.id).toBe('slowed-reverb');
    expect(findFilter('slowed and reverb')?.id).toBe('slowed-reverb');
    expect(findFilter('phone call')?.id).toBe('telephone');
    expect(findFilter('Daycore')?.id).toBe('daycore');
    expect(findFilter('bitcrush')?.id).toBe('8-bit');
    expect(findFilter('kazoo')).toBeUndefined();
  });

  it('turns speed into pitch like a record: Nightcore is about +4 semitones', () => {
    const nightcore = findFilter('nightcore')!;
    expect(speedCents(speedOf(nightcore))).toBeCloseTo(386.3, 1);
    expect(pitchLabel(1.25)).toBe('+3.9 semitones');
    expect(pitchLabel(0.85)).toBe('−2.8 semitones');
    expect(pitchLabel(1)).toBeNull();
    expect(lengthNote(nightcore)).toMatch(/shorter/);
    expect(lengthNote(findFilter('telephone')!)).toMatch(/timing stays/);
  });
});

describe('filter targets', () => {
  it('names the part: clips, bars, a section, the whole song', () => {
    const p = song();
    const clips = clipsTarget(p, ['c1' as ClipId])!;
    expect(clips).toMatchObject({ kind: 'clips', from: 4 * BAR, to: 8 * BAR });
    expect(targetLabel(p, clips)).toBe('this clip');
    expect(targetLabel(p, clipsTarget(p, ['c1', 'c2'] as ClipId[])!)).toBe('2 clips');
    expect(targetLabel(p, rangeTarget(p, 4 * BAR, 8 * BAR)!)).toBe('bars 5–8');
    const chorus = Object.values(p.playlist.markers).find((m) => m.name === 'Chorus')!.id as MarkerId;
    expect(targetLabel(p, markerTarget(p, chorus)!)).toBe('“Chorus” (bars 9–16)');
    expect(targetLabel(p, songTarget(p)!)).toBe('the whole song');
    // A range over the whole song is the song.
    expect(rangeTarget(p, 0, 16 * BAR)?.kind).toBe('song');
    // A spot: its section, else its bar.
    expect(spotTarget(p, 9 * BAR)).toMatchObject({ name: 'Chorus', from: 8 * BAR, to: 16 * BAR });
    const bare = produce(p, (d) => {
      d.playlist.markers = {};
    });
    expect(spotTarget(bare, 5 * BAR + 100)).toMatchObject({ kind: 'range', from: 5 * BAR, to: 6 * BAR });
  });

  it('prefers the selection, then the loop region, then the whole song', () => {
    const p = song();
    expect(defaultTarget(p, { selection: ['c2' as ClipId], loop: { start: 0, end: BAR } })?.kind).toBe('clips');
    expect(defaultTarget(p, { selection: [], loop: { start: 0, end: BAR } })).toMatchObject({ kind: 'range', from: 0, to: BAR });
    expect(defaultTarget(p, { selection: [], loop: null })?.kind).toBe('song');
    expect(defaultTarget(createEmptyProject(), {})).toBeNull();
    // Muted clips don't count.
    const muted = produce(p, (d) => {
      d.playlist.clips['c2' as ClipId]!.muted = true;
    });
    expect(clipsTarget(muted, ['c2' as ClipId])).toBeNull();
  });

  it('a speed filter takes every track over whole steps; a tone filter on clips only them', () => {
    const p = song();
    const t = clipsTarget(p, ['c1' as ClipId])!;
    const tone = filterPart(p, t, false);
    expect(tone.only(p.playlist.clips['c1' as ClipId]!)).toBe(true);
    expect(tone.only(p.playlist.clips['long' as ClipId]!)).toBe(false);
    const speed = filterPart(p, { kind: 'range', from: 4 * BAR + 10, to: 8 * BAR - 10 }, true);
    expect([speed.from, speed.to]).toEqual([4 * BAR, 8 * BAR]);
    expect(speed.only(p.playlist.clips['long' as ClipId]!)).toBe(true);
  });
});

describe('cutting a part out and putting it back', () => {
  it('splits clips at the edges and keeps them whole for later', () => {
    const p = song();
    const tempo = tempoMapOf(p, 'song');
    let cut!: ReturnType<typeof cutPart>;
    const q = produce(p, (d) => {
      cut = cutPart(d, 4 * BAR, 8 * BAR, tempo, (c) => c.kind !== 'automation', ids('x'));
      for (const id of cut.inside) delete d.playlist.clips[id];
    });
    // c1 sits inside; the long clip is cut into three, its middle taken.
    expect(cut.originals.map((c) => c.id).sort()).toEqual(['c1', 'long']);
    expect(cut.originals.find((c) => c.id === 'long')).toMatchObject({ start: 0, length: 16 * BAR });
    expect(q.playlist.clips['c1' as ClipId]).toBeUndefined();
    expect(q.playlist.clips['long' as ClipId]).toMatchObject({ start: 0, length: 4 * BAR });
    const right = q.playlist.clips[cut.pieces[0]!] as Clip & { offset: number };
    expect(right).toMatchObject({ start: 8 * BAR, length: 8 * BAR, offset: 8 * BAR });
    // Nothing plays in bars 5–8 any more; c0, c2, c3 are untouched.
    for (const c of Object.values(q.playlist.clips)) expect(c.start >= 8 * BAR || c.start + c.length <= 4 * BAR).toBe(true);
    expect(q.playlist.clips['c2' as ClipId]).toBe(p.playlist.clips['c2' as ClipId]);
  });

  /** Applies a filter record the way app/filters does (without the render). */
  const filtered = (p: Project, from: number, to: number, speed: number, whole = false) =>
    produce(p, (d) => {
      const tempo = tempoMapOf(p, 'song');
      const cut = cutPart(d, from, to, tempo, (c) => c.kind !== 'automation');
      for (const id of cut.inside) delete d.playlist.clips[id];
      const ins = makeInsert('ins_f' as never, 'Nightcore');
      addInsert(d, ins);
      const ch: AudioClipChannel = {
        kind: 'audioClip',
        id: 'ch_f' as ChannelId,
        name: 'Nightcore (bars 5–8)',
        color: '#888888',
        muted: false,
        solo: false,
        volume: 1,
        pan: 0,
        output: ins.id,
        sampleId: 'smp_f' as SampleId,
        filter: { preset: 'nightcore', from, to, originals: cut.originals, pieces: cut.pieces, insert: { id: ins.id, made: true, name: 'Nightcore', slots: [] } },
      };
      if (speed !== 1) {
        const t = changePartTempo(d, from, to, speed, tempo, { wholeSong: whole, name: 'Nightcore', color: '#888888' });
        ch.filter!.tempo = t.tempo;
        ch.filter!.originals.push(...t.cut.originals);
        ch.filter!.pieces.push(...t.cut.pieces);
      }
      d.samples['smp_f' as SampleId] = { id: 'smp_f' as SampleId, name: 'f', source: { kind: 'builtin', generator: 'kit/kick', version: 1 } };
      d.channels[ch.id] = ch;
      d.channelOrder.push(ch.id);
      d.playlist.clips['f' as ClipId] = { kind: 'audio', id: 'f' as ClipId, laneId: p.playlist.laneOrder[0]!, start: from, length: to - from, channelId: ch.id, offsetSec: 0 };
    });

  it('Remove filter puts back exactly what was there', () => {
    const p = song();
    const q = filtered(p, 4 * BAR, 8 * BAR, 1.25);
    expect(q.mixer.inserts['ins_f' as never]).toBeDefined();
    const back = produce(q, (d) => {
      expect(removeSoundFilter(d, 'ch_f' as ChannelId)).toBe(true);
    });
    expect(back.playlist.clips).toEqual(p.playlist.clips);
    expect(back.channels).toEqual(p.channels);
    expect(back.channelOrder).toEqual(p.channelOrder);
    expect(back.mixer).toEqual(p.mixer);
    expect(back.transport).toEqual(p.transport);
  });

  it('a speed filter changes the part’s tempo, and only the part’s', () => {
    const p = song();
    const q = filtered(p, 4 * BAR, 8 * BAR, 1.25);
    const t = tempoMapOf(q, 'song');
    expect(t.bpmAt(2 * BAR)).toBe(120);
    expect(t.bpmAt(4 * BAR)).toBe(150);
    expect(t.bpmAt(8 * BAR - 1)).toBe(150);
    expect(t.bpmAt(8 * BAR)).toBe(120);
    expect(t.bpmAt(15 * BAR)).toBe(120);
    // Bars 5–8 take 80 % of the time; everything after starts that much earlier.
    const before = tempoMapOf(p, 'song');
    const part = (m: typeof t) => m.tickToSeconds(8 * BAR) - m.tickToSeconds(4 * BAR);
    expect(part(t) / part(before)).toBeCloseTo(0.8, 6);
    expect(before.tickToSeconds(12 * BAR) - t.tickToSeconds(12 * BAR)).toBeCloseTo(0.2 * part(before), 6);
    // The whole song without tempo automation just gets a new tempo.
    const all = filtered(p, 0, 16 * BAR, 1.25, true);
    expect(all.transport.bpm).toBe(150);
    expect(Object.values(all.channels).some((c) => c.kind === 'automation')).toBe(false);
    const back = produce(all, (d) => void removeSoundFilter(d, 'ch_f' as ChannelId));
    expect(back.transport.bpm).toBe(120);
  });

  it('a speed filter follows tempo automation already there, and puts it back', () => {
    const p = song();
    // A tempo clip over bars 7–12 holding 100 BPM.
    const withTempo = produce(p, (d) => {
      d.channels['ch_t' as ChannelId] = {
        kind: 'automation',
        id: 'ch_t' as ChannelId,
        name: 'Tempo',
        color: '#888888',
        muted: false,
        solo: false,
        target: { kind: 'tempo' },
        points: [
          { tick: 0, value: 0.5 },
          { tick: 6 * BAR, value: 0.5 },
        ],
        range: { min: 50, max: 150 },
      };
      d.channelOrder.push('ch_t' as ChannelId);
      d.playlist.clips['t' as ClipId] = { kind: 'automation', id: 't' as ClipId, laneId: p.playlist.laneOrder[3]!, start: 6 * BAR, length: 6 * BAR, channelId: 'ch_t' as ChannelId, offset: 0 };
    });
    const before = tempoMapOf(withTempo, 'song');
    expect([before.bpmAt(5 * BAR), before.bpmAt(7 * BAR)]).toEqual([120, 100]);
    const q = filtered(withTempo, 4 * BAR, 8 * BAR, 1.25);
    const t = tempoMapOf(q, 'song');
    expect(t.bpmAt(5 * BAR)).toBe(150);
    expect(t.bpmAt(7 * BAR)).toBe(125);
    expect(t.bpmAt(9 * BAR)).toBe(100);
    expect(t.bpmAt(13 * BAR)).toBe(100);
    const back = produce(q, (d) => void removeSoundFilter(d, 'ch_f' as ChannelId));
    expect(back.playlist.clips).toEqual(withTempo.playlist.clips);
    expect(back.channels).toEqual(withTempo.channels);
  });

  it('knows when a later filter was made over a filter', () => {
    const p = filtered(song(), 4 * BAR, 8 * BAR, 1);
    expect(filtersOver(p, 'ch_f' as ChannelId)).toEqual([]);
    const later = produce(p, (d) => {
      const ch = { ...(d.channels['ch_f' as ChannelId] as AudioClipChannel), id: 'ch_g' as ChannelId };
      ch.filter = { preset: 'telephone', from: 0, to: 16 * BAR, originals: [{ ...d.playlist.clips['f' as ClipId]! } as Clip], pieces: [] };
      d.channels[ch.id] = ch;
    });
    expect(filtersOver(later, 'ch_f' as ChannelId).map((c) => c.id)).toEqual(['ch_g']);
  });

  it('borrows an empty mixer track, never a used one', () => {
    const p = song();
    const first = emptyInsert(p)!;
    expect(p.mixer.inserts[first]!.name).toMatch(/^Insert \d+$/);
    const used = produce(p, (d) => {
      d.mixer.inserts[first]!.name = 'Drums';
    });
    expect(emptyInsert(used)).not.toBe(first);
    expect(emptyInsert(used)).not.toBe(MASTER);
  });
});
