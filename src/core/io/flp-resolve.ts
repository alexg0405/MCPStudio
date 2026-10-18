/**
 * The steps of reading an .flp that need the whole file: some values only mean something once every event
 * has been seen (the tempo has two forms, track numbers depend on the version, mixer parameters refer to
 * inserts and slots defined anywhere in the file). `FlpEventReader.finish()` runs them in this order.
 */
import { flpVersionAtLeast } from './flp-bytes';
import { FLP_MIXER_PARAM, type FlpProject } from './flp-format';

/** Playlist tracks are stored reversed from the last one: 500 tracks from FL 12.9.1 on, 199 before. */
const LAST_TRACK_INDEX_MODERN = 499;
const LAST_TRACK_INDEX_LEGACY = 198;
const FIRST_VERSION_WITH_MODERN_TRACKS = [12, 9, 1];
const DEFAULT_TIME_SIGNATURE_PART = 4;

/** A mixer parameter as stored, applied to the inserts once all of them are known. */
export interface MixerParam {
  insert: number;
  slot: number;
  id: number;
  value: number;
}

/** The tempo and time signature events seen along the way (null: not in the file). */
export interface TempoEvents {
  tempoCoarse: number | null;
  tempoFine: number;
  timeSigNumerator: number | null;
  timeSigBeat: number | null;
}

/** Tempo: the modern dword (BPM × 1000), else the legacy coarse word plus fine thousandths. */
export function resolveTempoAndTimeSignature(project: FlpProject, events: TempoEvents): void {
  if (project.tempo === null && events.tempoCoarse !== null) {
    project.tempo = events.tempoCoarse + events.tempoFine / 1000;
  }
  if (project.tempo !== null && !(project.tempo > 0)) project.tempo = null;
  if (events.timeSigNumerator !== null || events.timeSigBeat !== null) {
    project.timeSig = {
      num: events.timeSigNumerator ?? DEFAULT_TIME_SIGNATURE_PART,
      beat: events.timeSigBeat ?? DEFAULT_TIME_SIGNATURE_PART,
    };
  }
}

/** Converts stored (reversed) track numbers to 0 = top track, dropping items beyond the last track. */
export function resolvePlaylistTracks(project: FlpProject): void {
  const hasModernTracks =
    project.versionParts.length > 0
      ? flpVersionAtLeast(project.versionParts, FIRST_VERSION_WITH_MODERN_TRACKS)
      : project.arrangements.some((a) => a.items.some((item) => item.track > LAST_TRACK_INDEX_LEGACY));
  const lastTrack = hasModernTracks ? LAST_TRACK_INDEX_MODERN : LAST_TRACK_INDEX_LEGACY;
  for (const arrangement of project.arrangements) {
    arrangement.items = arrangement.items.filter((item) => {
      const track = lastTrack - item.track;
      if (track < 0) return false;
      item.track = track;
      return true;
    });
  }
}

/** Mixer params: per-insert volume, pan and sends, and per-slot enabled/mix. */
export function applyMixerParams(project: FlpProject, params: readonly MixerParam[]): void {
  for (const param of params) {
    const insert = project.inserts[param.insert];
    if (!insert) continue;
    if (param.id === FLP_MIXER_PARAM.volume) {
      insert.volume = param.value;
    } else if (param.id === FLP_MIXER_PARAM.pan) {
      insert.pan = param.value;
    } else if (param.id >= FLP_MIXER_PARAM.routeFirst && param.id <= FLP_MIXER_PARAM.routeLast) {
      insert.sends[param.id - FLP_MIXER_PARAM.routeFirst] = param.value;
    } else if (param.id === FLP_MIXER_PARAM.slotEnabled || param.id === FLP_MIXER_PARAM.slotMix) {
      const slot = insert.slots.find((s) => s.index === param.slot);
      if (!slot) continue;
      if (param.id === FLP_MIXER_PARAM.slotEnabled) slot.enabled = param.value !== 0;
      else slot.mix = param.value;
    }
  }
}
