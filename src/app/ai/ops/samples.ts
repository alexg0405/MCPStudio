/** The musician's sample folders: put a sound in the project (place_sample), make a drum kit from sounds (make_kit). */
import { browse, NO_FILTER } from '@core/samples/query';
import * as S from '../schema/parts';
import { DRUM_PADS_ID } from '../../samples/actions';
import type { BrowserRow } from '../../samples/browser';
import type { SampleWork } from '../../samples/work';
import { fail, type OpContext, type OpModule } from './context';
import { bool, num, str } from './values';

/** The sound a place_sample or make_kit names: an id, a path (with or without the folder) or a file name. */
function rowFor(ref: string, c: OpContext): BrowserRow {
  const row = c.s.sampleBrowser.find(ref);
  if (!row) fail(`there is no sample "${ref}" in the sample folders (list_samples shows ids and paths; the musician adds folders in View → Sample browser)`);
  const r = row as BrowserRow;
  if (r.state === 'failed') fail(`“${r.name}” is not readable as audio`);
  return r;
}

/** The answer's one batch of sample work (kept in order; done after the edit, in the answer's undo step). */
function workOf(c: OpContext): SampleWork[] {
  const hit = c.state.after.find((x) => x.kind === 'samples');
  if (hit && hit.kind === 'samples') return hit.work;
  const work: SampleWork[] = [];
  c.state.after.push({ kind: 'samples', work });
  return work;
}

export const samples: OpModule = {
  schemas: [
    S.op(
      'place_sample',
      'Puts a sound from the musician’s sample folders into the project (see list_samples): to "channel" (a sampler channel, the default for one-shots), to "clip" (an audio clip on the playlist, the default for loops: a loop with a known tempo follows the song tempo and lasts its bars) or to "pad" (one pad of a Drum Pads channel). One undo step with the answer.',
      {
        sample: S.str('The sound: its id from list_samples, its path (Folder/Sub/file.wav) or its file name.'),
        to: { type: 'string', enum: ['channel', 'clip', 'pad'], description: 'Where it goes (default: clip for a loop, channel for a one-shot).' },
        track: S.int('clip: the 1-based playlist track (default: the first track with room).'),
        bar: S.num('clip: the 1-based bar it starts at (default: the song position marker, bar 1 unless the musician moved it).'),
        follow_tempo: S.bool('clip: a loop follows the song tempo by time-stretching (default true); false plays it at its own speed.'),
        channel: { ...S.CHANNEL, description: 'pad: the Drum Pads channel (its id, name, or @ref).' },
        pad: S.int('pad: the pad, 1–16 (pad 1 plays C3 / key 36: kick; 3 snare; 4 clap; 7 closed hat; 11 open hat).'),
      },
      ['sample'],
    ),
    S.op(
      'make_kit',
      'Makes a Drum Pads channel from one-shots of the musician’s sample folders and lays them out like the default kit: kick on pad 1 (an 808 on pad 2), snares on 3 and 5, clap on 4, closed hats on 7 and 9, open hat on 11, toms from low to high on 6, 8, 10, cymbals on 14 and 16, the rest on free pads; pads without a sound keep their built-in drum. Name the sounds (samples), or give a folder and/or search words and every one-shot there goes on a pad. Loops are left out. One undo step.',
      {
        samples: { type: 'array', items: { type: 'string' }, description: 'Sounds by id, path or file name (up to 16 are used).' },
        folder: S.str('Instead of samples: every one-shot in this folder or subfolder (Folder or Folder/Sub).'),
        text: S.str('Instead of samples: search words (as in list_samples text) the sounds must match, e.g. "trap kit".'),
        name: S.str('The kit channel’s name (default: the folder’s name and "kit").'),
      },
    ),
  ],
  prompt: {
    id: 'samples',
    order: 24,
    text: `The musician's sample folders (the Sample browser window: kicks, snares, hats, loops with their tempo and key, found by analyzing the audio): look sounds up with the list_samples query (filters: text, category kick|snare|clap|hat|open-hat|cymbal|tom|perc|808|fx|vocal|tonal, kind loop|one-shot, bpm_min/bpm_max, key like "A minor", favorites, recent, tag, folder, similar_to a sound, in_song_key; sort; limit), then use place_sample to put a sound in the project (a sampler channel, an audio clip on the playlist, or one pad of a Drum Pads channel) and make_kit to make a Drum Pads kit from one-shots. Pick by what the analysis says (type, tempo near the song's, a key that fits) and say which sounds you used by name. When there are no sample folders, say the musician adds one in View → Sample browser → Add folder (it stays on their computer) and offer the built-in drum sounds instead. A sound the analysis is unsure of (confidence under 0.5) may be something else: say so when it matters.`,
  },
  handlers: {
    place_sample: (a, c) => {
      const row = rowFor(str(a.sample) ?? fail('which sample? (an id, path or file name from list_samples)'), c);
      const isLoop = row.analysis?.kind === 'loop';
      const raw = str(a.to);
      const to = raw === undefined ? (isLoop ? 'clip' : 'channel') : raw;
      if (to !== 'channel' && to !== 'clip' && to !== 'pad') return fail(`to must be channel, clip or pad (not "${to}")`);
      if (to === 'channel') {
        workOf(c).push({ kind: 'place', row: row.id, to });
        return `Adds “${row.name}” as a sampler channel`;
      }
      if (to === 'clip') {
        const track = num(a.track);
        const bar = num(a.bar);
        if (track !== undefined && (track < 1 || !Number.isFinite(track))) fail('track is 1-based');
        if (bar !== undefined && bar < 1) fail('bar is 1-based');
        const follow = bool(a.follow_tempo);
        workOf(c).push({
          kind: 'place',
          row: row.id,
          to,
          ...(track !== undefined ? { track: Math.round(track) } : {}),
          ...(bar !== undefined ? { start: Math.max(0, Math.round((bar - 1) * c.bar())) } : {}),
          ...(follow === false ? { followTempo: false } : {}),
        });
        return `Puts “${row.name}” on the playlist${bar !== undefined ? ` at bar ${bar}` : ''}${track !== undefined ? ` on track ${Math.round(track)}` : ''}`;
      }
      const channel = c.channel(a.channel);
      const ch = c.project.channels[channel];
      if (!ch || ch.kind !== 'instrument' || ch.plugin.pluginId !== DRUM_PADS_ID)
        fail(`“${ch?.name ?? a.channel}” is not a Drum Pads channel (make_kit makes one, or add_channel with plugin ${DRUM_PADS_ID})`);
      const pad = Math.round(num(a.pad) ?? fail('which pad (1–16)?'));
      if (pad < 1 || pad > 16) fail('pad is 1–16');
      workOf(c).push({ kind: 'place', row: row.id, to, channel, pad });
      return `Loads “${row.name}” on pad ${pad} of ${ch?.name ?? 'the kit'}`;
    },
    make_kit: (a, c) => {
      let rows: BrowserRow[];
      if (Array.isArray(a.samples) && a.samples.length > 0) {
        rows = a.samples.map(str).filter((x): x is string => !!x).map((x) => rowFor(x, c));
      } else {
        const folder = str(a.folder);
        const text = str(a.text);
        if (!folder && !text) return fail('name the sounds (samples), or a folder and/or search words');
        const filter = { ...NO_FILTER, kind: 'one-shot' as const, ...(folder ? { under: folder } : {}), ...(text ? { text } : {}) };
        rows = browse(c.s.sampleBrowser.store.getState().rows, filter, 'name') as BrowserRow[];
        if (rows.length === 0) fail('no one-shots match that folder or those words (list_samples shows what there is)');
      }
      const one = rows.filter((r) => r.analysis?.kind === 'one-shot');
      if (one.length === 0) fail(rows.some((r) => !r.analysis) ? 'those sounds are not analyzed yet: wait for the analysis to finish (list_samples says how far it is)' : 'a kit needs one-shots (those are loops or long files)');
      const name = str(a.name);
      workOf(c).push({ kind: 'kit', rows: rows.map((r) => r.id), ...(name ? { name } : {}) });
      return `Makes a Drum Pads kit from ${Math.min(16, one.length)} of ${one.length} one-shots${rows.length > one.length ? ` (${rows.length - one.length} loops or long files left out)` : ''}`;
    },
  },
};

