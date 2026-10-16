/**
 * MIDI files in and out. Import: GM drums (channel 10) become the kit's sampler channels (reused when
 * the project already has them); other parts get an instrument by GM family; each track becomes a
 * pattern (or all go into one); the file's tempo and time signature can be taken over, and tempo
 * changes become a tempo automation clip. Export: the song (what plays, swing included) or the
 * current pattern, one track per channel; kit channels go out as GM drums.
 */
import { tempoMapOf } from '@core/automation/tempo';
import { parseMidi, writeMidi, MidiError, type MidiFileData, type MidiNote, type MidiWriteTrack } from '@core/io/midi';
import { makePattern, paletteColor } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import {
  type AutomationChannel,
  type AutomationClip,
  type ChannelId,
  type InstrumentChannel,
  type Note,
  type PatternClip,
  type PatternId,
  type Project,
} from '@core/model/types';
import { addChannel, addSample } from '@core/ops/channels';
import { addNotes, setBpm } from '@core/ops/notes';
import { addClips, addPattern } from '@core/ops/playlist';
import { songLength } from '@core/query/playlist';
import { patternLength } from '@core/query/queries';
import { ticksPerBar } from '@core/time/ppq';
import { collectNotes, songModeSource, type NoteEvent } from '@engine/sched/events';
import { downloadBytes, pickSaveMidiFile, uploadFile } from '@platform/fs-access';
import { defaultValues, type PluginDef } from '@agstudio/sdk';
import { BASS808_ID, SYNTH } from '../assistant/palette';
import { instrumentChannelFor, kitSampleRef, SAMPLER_ID } from '../default-project';
import type { Services } from '../services';

/** GM drum note → kit sound. */
const GM_DRUMS: Record<number, string> = {
  35: 'kit/kick',
  36: 'kit/kick',
  37: 'kit/rim',
  38: 'kit/snare',
  40: 'kit/snare',
  39: 'kit/clap',
  42: 'kit/hat-closed',
  44: 'kit/hat-closed',
  54: 'kit/hat-closed',
  46: 'kit/hat-open',
  51: 'kit/hat-open',
  53: 'kit/hat-open',
  59: 'kit/hat-open',
  41: 'kit/tom-low',
  43: 'kit/tom-low',
  45: 'kit/tom-low',
  47: 'kit/tom-mid',
  48: 'kit/tom-mid',
  50: 'kit/tom-high',
  49: 'kit/crash',
  52: 'kit/crash',
  55: 'kit/crash',
  57: 'kit/crash',
  56: 'kit/cowbell',
};

/** Kit sound → the GM drum note it exports as. */
const KIT_TO_GM: Record<string, number> = {
  'kit/kick': 36,
  'kit/rim': 37,
  'kit/snare': 38,
  'kit/clap': 39,
  'kit/hat-closed': 42,
  'kit/hat-open': 46,
  'kit/tom-low': 41,
  'kit/tom-mid': 47,
  'kit/tom-high': 50,
  'kit/crash': 49,
  'kit/cowbell': 56,
};

const KEYS = {
  osc1Wave: 'triangle',
  osc2Wave: 'sine',
  osc2Level: 0.4,
  attack: 0.003,
  decay: 0.9,
  sustain: 0.25,
  release: 0.4,
  cutoff: 3500,
  filterEnv: 0.8,
};

/** An instrument for a GM program: [plugin id, 3xOsc settings or null, a name]. */
function gmInstrument(program: number | undefined): [string, Record<string, number | string> | null, string] {
  if (program === undefined) return ['agstudio.3xosc', KEYS, 'Keys'];
  if (program < 24) return ['agstudio.3xosc', KEYS, 'Keys'];
  if (program < 32 || (program >= 104 && program < 120)) return ['agstudio.pluck', null, 'Pluck'];
  if (program < 40) return ['agstudio.3xosc', SYNTH.bass ?? null, 'Bass'];
  if (program < 56 || (program >= 88 && program < 104)) return ['agstudio.3xosc', SYNTH.pad ?? null, 'Pad'];
  return ['agstudio.3xosc', SYNTH.lead ?? null, 'Lead'];
}

export interface MidiImportOptions {
  /** One pattern per track (true) or everything in one pattern. */
  split: boolean;
  /** Take over the file's tempo and time signature (tempo changes become a tempo clip). */
  tempo: boolean;
  /** Put the patterns on the playlist (song mode). */
  place: boolean;
}

export interface MidiImportResult {
  patterns: PatternId[];
  channels: ChannelId[];
  notes: number;
  /** Drum notes with no kit sound to play them. */
  skipped: number;
}

interface Part {
  track: number;
  name: string;
  /** Kit sound for drum parts. */
  drum?: string;
  program?: number;
  notes: MidiNote[];
}

function partsOf(data: MidiFileData, fileName: string): { parts: Part[]; skipped: number } {
  const parts: Part[] = [];
  let skipped = 0;
  data.tracks.forEach((t, ti) => {
    const byChannel = new Map<number, MidiNote[]>();
    for (const n of t.notes) {
      const list = byChannel.get(n.channel) ?? [];
      list.push(n);
      byChannel.set(n.channel, list);
    }
    for (const [ch, notes] of byChannel) {
      const base = t.name || `${fileName} ${ti + 1}`;
      if (ch === 9) {
        const byKit = new Map<string, MidiNote[]>();
        for (const n of notes) {
          const kit = GM_DRUMS[n.key];
          if (!kit) {
            skipped++;
            continue;
          }
          const list = byKit.get(kit) ?? [];
          list.push(n);
          byKit.set(kit, list);
        }
        for (const [kit, list] of byKit) parts.push({ track: ti, name: kit, drum: kit, notes: list });
      } else {
        const program = t.programs[ch];
        parts.push({
          track: ti,
          name: byChannel.size > 1 ? `${base} ${ch + 1}` : base,
          ...(program !== undefined ? { program } : {}),
          notes,
        });
      }
    }
  });
  return { parts, skipped };
}

/** Imports a parsed MIDI file as one undo step. */
export function importMidi(
  s: Services,
  data: MidiFileData,
  fileName: string,
  opts: MidiImportOptions,
): MidiImportResult {
  const base = fileName.replace(/\.(mid|midi|smf)$/i, '') || 'MIDI';
  const { parts, skipped } = partsOf(data, base);
  const project = s.doc.getState().project;
  const result: MidiImportResult = { patterns: [], channels: [], notes: 0, skipped };
  if (parts.length === 0) return result;

  // Channels: drum parts reuse the project's kit channels; everything else gets a new channel.
  const kitChannel = (kit: string): ChannelId | undefined =>
    project.channelOrder.find((id) => {
      const ch = project.channels[id];
      if (ch?.kind !== 'instrument' || ch.plugin.pluginId !== SAMPLER_ID) return false;
      const ref = ch.plugin.samples?.main ? project.samples[ch.plugin.samples.main] : undefined;
      return ref?.source.kind === 'builtin' && ref.source.generator === kit;
    });
  const sampler = s.plugins.get(SAMPLER_ID);
  const made: {
    part: Part;
    channelId: ChannelId;
    make?: InstrumentChannel;
    sample?: ReturnType<typeof kitSampleRef>;
  }[] = [];
  let index = project.channelOrder.length;
  for (const part of parts) {
    if (part.drum) {
      const existing = kitChannel(part.drum);
      if (existing) {
        made.push({ part, channelId: existing });
        continue;
      }
      if (!sampler) continue;
      const sample = kitSampleRef(part.drum);
      const ch = instrumentChannelFor(sampler, sample.name, index++, { main: sample.id });
      made.push({ part, channelId: ch.id, make: ch, sample });
      continue;
    }
    const [pluginId, settings, kind] = gmInstrument(part.program);
    const def: PluginDef | undefined = s.plugins.get(pluginId) ?? s.plugins.get('agstudio.3xosc');
    if (!def) continue;
    const ch = instrumentChannelFor(def, part.name || kind, index++);
    if (settings && def.id === 'agstudio.3xosc') ch.plugin.params = { ...defaultValues(def.params), ...settings };
    made.push({ part, channelId: ch.id, make: ch });
  }
  void BASS808_ID;

  const bar = ticksPerBar(opts.tempo && data.timeSig ? data.timeSig : project.transport.timeSig);
  const groups = new Map<number, typeof made>();
  for (const m of made) {
    const key = opts.split ? m.part.track : 0;
    const list = groups.get(key) ?? [];
    list.push(m);
    groups.set(key, list);
  }

  s.history.transact(`Import MIDI ${base}`, (d) => {
    if (opts.tempo) {
      const first = data.tempos[0]?.bpm;
      if (first) setBpm(d, first);
      if (data.timeSig) d.transport.timeSig = { ...data.timeSig };
    }
    for (const m of made) {
      if (!m.make) continue;
      if (m.sample && !d.samples[m.sample.id]) addSample(d, m.sample);
      addChannel(d, m.make);
      result.channels.push(m.channelId);
    }
    let lane = 0;
    for (const [track, list] of groups) {
      const id = newId.pattern();
      const trackName = data.tracks[track]?.name;
      const name = opts.split && groups.size > 1 ? `${base} – ${trackName || `Track ${track + 1}`}` : base;
      addPattern(d, makePattern(name, paletteColor(d.patternOrder.length), id));
      let end = 0;
      for (const m of list) {
        const ch = d.channels[m.channelId];
        if (!ch || ch.kind !== 'instrument') continue;
        const notes: Note[] = m.part.notes.map((n) => ({
          id: newId.note(),
          tick: n.tick,
          length: Math.max(10, n.length),
          key: m.part.drum ? ch.rootKey : n.key,
          velocity: n.velocity,
        }));
        for (const n of notes) end = Math.max(end, n.tick + n.length);
        addNotes(d, id, m.channelId, notes);
        result.notes += notes.length;
      }
      const pat = d.patterns[id]!;
      pat.length = Math.max(bar, Math.ceil(end / bar) * bar);
      pat.stepCount = Math.min(512, Math.max(16, Math.round((pat.length / bar) * 16)));
      result.patterns.push(id);
      if (opts.place) {
        const laneId = d.playlist.laneOrder[lane++];
        if (laneId) {
          const clip: PatternClip = {
            kind: 'pattern',
            id: newId.clip(),
            laneId,
            start: 0,
            length: pat.length,
            patternId: id,
            offset: 0,
          };
          addClips(d, [clip]);
        }
      }
    }
    // Tempo changes during the song: a tempo automation clip (hold steps between changes).
    if (opts.tempo && opts.place && data.tempos.length > 1) {
      const bpms = data.tempos.map((t) => t.bpm);
      const min = Math.max(10, Math.floor(Math.min(...bpms) - 1));
      const max = Math.min(522, Math.ceil(Math.max(...bpms) + 1));
      const span = Math.max(1, max - min);
      const ch: AutomationChannel = {
        kind: 'automation',
        id: newId.channel(),
        name: 'Tempo',
        color: '#4fa6a6',
        muted: false,
        solo: false,
        target: { kind: 'tempo' },
        range: { min, max },
        points: data.tempos.map((t) => ({ tick: t.tick, value: (t.bpm - min) / span, shape: 'hold' as const })),
      };
      addChannel(d, ch);
      const songEnd = Math.max(...result.patterns.map((p) => d.patterns[p]?.length ?? bar));
      const laneId = d.playlist.laneOrder[lane];
      if (laneId) {
        const clip: AutomationClip = {
          kind: 'automation',
          id: newId.clip(),
          laneId,
          start: 0,
          length: songEnd,
          channelId: ch.id,
          offset: 0,
        };
        addClips(d, [clip]);
      }
    }
  });
  const first = result.patterns[0];
  if (first) s.view.getState().setCurrentPattern(first);
  if (opts.place) s.view.getState().setMode('song');
  return result;
}

/** Reads a .mid file and imports it. */
export async function importMidiFile(s: Services, file: Pick<File, 'name' | 'arrayBuffer'>, opts: MidiImportOptions) {
  let data: MidiFileData;
  try {
    data = parseMidi(new Uint8Array(await file.arrayBuffer()));
  } catch (e) {
    throw e instanceof MidiError ? e : new MidiError(`${file.name} couldn't be read as a MIDI file.`);
  }
  return importMidi(s, data, file.name, opts);
}

/** The browser's file chooser for MIDI files (null when cancelled). */
export function pickMidiFile(): Promise<File | null> {
  return uploadFile('.mid,.midi,audio/midi,audio/x-midi');
}

function trackFor(
  p: Project,
  channelId: ChannelId,
  notes: MidiWriteTrack['notes'],
  used: Set<number>,
): MidiWriteTrack | null {
  const ch = p.channels[channelId];
  if (!ch || ch.kind !== 'instrument' || notes.length === 0) return null;
  const ref =
    ch.plugin.pluginId === SAMPLER_ID && ch.plugin.samples?.main ? p.samples[ch.plugin.samples.main] : undefined;
  const gm = ref?.source.kind === 'builtin' ? KIT_TO_GM[ref.source.generator] : undefined;
  if (gm !== undefined) return { name: ch.name, channel: 9, notes: notes.map((n) => ({ ...n, key: gm })) };
  let channel = 0;
  while ((used.has(channel) || channel === 9) && channel < 15) channel++;
  used.add(channel);
  return { name: ch.name, channel, notes };
}

/** The song (as it plays, swing included) or the current pattern as a MIDI file. */
export function exportMidi(s: Services, scope: 'song' | 'pattern'): { bytes: Uint8Array; name: string } {
  const p = s.doc.getState().project;
  const byChannel = new Map<ChannelId, { tick: number; length: number; key: number; velocity: number }[]>();
  const push = (cid: ChannelId, n: { tick: number; length: number; key: number; velocity: number }) => {
    const list = byChannel.get(cid) ?? [];
    list.push(n);
    byChannel.set(cid, list);
  };
  let name = p.meta.title || 'Song';
  if (scope === 'pattern') {
    const pid = s.view.getState().currentPatternId;
    const pattern = pid ? p.patterns[pid] : undefined;
    if (!pattern) throw new MidiError('There is no pattern to export.');
    name = pattern.name;
    for (const [cid, notes] of Object.entries(pattern.notes))
      for (const n of Object.values(notes)) if (!n.muted) push(cid as ChannelId, n);
  } else {
    const { source } = songModeSource(p);
    const events: NoteEvent[] = [];
    collectNotes(source, 0, Math.max(1, songLength(p)), events);
    if (events.length === 0) throw new MidiError('The playlist is empty: export the current pattern instead.');
    for (const e of events)
      push(e.channelId, {
        tick: Math.round(e.start),
        length: Math.max(1, Math.round(e.end - e.start)),
        key: e.pitch,
        velocity: e.velocity,
      });
  }
  const used = new Set<number>();
  const tracks: MidiWriteTrack[] = [];
  for (const cid of p.channelOrder) {
    const t = trackFor(p, cid, byChannel.get(cid) ?? [], used);
    if (t) tracks.push(t);
  }
  const bpm = tempoMapOf(p, scope === 'song' ? 'song' : 'pattern').bpm;
  void patternLength;
  return { bytes: writeMidi({ name, bpm, timeSig: p.transport.timeSig, tracks }), name };
}

/** Saves exported MIDI bytes (save picker where available, else a download). */
export async function saveMidiFile(bytes: Uint8Array, name: string): Promise<void> {
  const fileName = `${name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Song'}.mid`;
  let handle: FileSystemFileHandle | null | undefined;
  try {
    handle = await pickSaveMidiFile(fileName);
  } catch {
    handle = undefined; // no save picker: download instead
  }
  if (handle === null) return; // cancelled
  if (handle) {
    const w = await handle.createWritable();
    await w.write(bytes.slice().buffer);
    await w.close();
  } else downloadBytes(fileName, bytes, 'audio/midi');
}
