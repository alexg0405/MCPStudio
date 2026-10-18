/**
 * Maps a parsed FL Studio project (`flp.ts`) onto a new AGstudio Project, with a report of what
 * came across and what didn't. Pure: plugin defaults and the resolved samples come from the caller.
 *
 * - Ticks are rescaled from the file's PPQ to 960. Notes keep velocity, pan, release and fine pitch.
 * - Channels keep their FL order, names, colours, volume, pan, pitch, root key and mixer insert.
 *   Sampler channels get their sample; a sampler that only appears as playlist clips (and has no
 *   notes) is FL's audio clip channel. Other generators get the closest built-in instrument
 *   ("stand-in"); FL plugin settings are not read, so every plugin starts from its default sound.
 * - Layer channels have no sound of their own: their notes go to each child channel.
 * - Patterns keep their FL numbers' order, names and colours. FL pattern clips don't repeat their
 *   content, so a pattern gets an explicit length when a clip reaches past its content.
 * - The playlist of the arrangement that was open (FL 12.9+ has several) becomes the playlist:
 *   pattern, audio and automation clips on the same tracks, track names/colours, time markers.
 * - Mixer inserts keep their numbers, names, colours, volume, pan, routing and the effects that have
 *   a built-in counterpart.
 *
 * The work is in steps, one file each: `flp-import-mixer.ts`, `-channels.ts`, `-song.ts` (patterns,
 * playlist, markers), with the plugin guesses in `-plugins.ts` and the report text in `-report.ts`.
 */
import { createEmptyProject } from '../model/defaults';
import type { PluginInstance } from '../model/types';
import { PPQ } from '../time/ppq';
import type { FlpArrangement, FlpProject } from './flp';
import { importChannels } from './flp-import-channels';
import { importMixer } from './flp-import-mixer';
import { importMarkers, importPatterns, importPlaylist } from './flp-import-song';
import {
  clamp,
  trimName,
  type FlpImportContext,
  type FlpImportOptions,
  type FlpImportReport,
  type FlpImportResult,
} from './flp-import-types';

export { describeFlpImport } from './flp-import-report';
export {
  FLP_PLUGIN,
  type FlpImportOptions,
  type FlpImportReport,
  type FlpImportResult,
  type FlpPluginInfo,
  type FlpResolvedSample,
  type FlpStandIn,
} from './flp-import-types';

/** FL's tempo when the file has none. */
const FL_DEFAULT_BPM = 140;
const BPM_MIN = 10;
const BPM_MAX = 522;
const MAX_TIME_SIGNATURE_NUMERATOR = 16;
const TIME_SIGNATURE_DENOMINATORS = [2, 4, 8, 16];

/** Reads the FL project into a new Project (ids from `newId`). */
export function flpToProject(flp: FlpProject, opts: FlpImportOptions): FlpImportResult {
  const ctx = createContext(flp, opts);
  const { project, report } = ctx;
  const arrangement = chooseArrangement(flp, report);
  const mixer = importMixer(ctx);
  const channels = importChannels(ctx, arrangement, mixer.insertFor);
  const patterns = importPatterns(ctx, channels);
  importPlaylist(ctx, arrangement, channels, patterns);
  importMarkers(ctx, arrangement);
  return {
    project,
    report,
    firstPatternId: project.patternOrder[0] as FlpImportResult['firstPatternId'],
    hasSong: report.clips > 0,
  };
}

/** The new project with its title, author, tempo and time signature, and an empty report. */
function createContext(flp: FlpProject, opts: FlpImportOptions): FlpImportContext {
  const scale = PPQ / flp.ppq;
  const baseName = opts.fileName.replace(/\.(flp|zip)$/i, '').trim() || 'FL Studio project';
  const title = trimName(flp.title?.trim() || baseName);
  const project = createEmptyProject({ title, ...(opts.now ? { now: opts.now } : {}) });
  if (flp.artist?.trim()) project.meta.author = flp.artist.trim();
  project.transport.bpm =
    flp.tempo !== null ? clamp(Math.round(flp.tempo * 1000) / 1000, BPM_MIN, BPM_MAX) : FL_DEFAULT_BPM;
  if (flp.timeSig) {
    const num = clamp(Math.round(flp.timeSig.num), 1, MAX_TIME_SIGNATURE_NUMERATOR);
    const den = TIME_SIGNATURE_DENOMINATORS.includes(flp.timeSig.beat) ? flp.timeSig.beat : 4;
    project.transport.timeSig = { num, den };
  }
  const report: FlpImportReport = {
    title,
    flVersion: flp.version,
    channels: 0,
    patterns: 0,
    notes: 0,
    clips: 0,
    markers: 0,
    inserts: 0,
    effects: 0,
    arrangement: null,
    otherArrangements: [],
    standIns: [],
    missingSamples: [],
    effectStandIns: [],
    skippedEffects: [],
    untargetedAutomation: [],
    layers: [],
    slideNotes: 0,
    orphanNotes: 0,
    skippedClips: 0,
    warnings: [...flp.warnings],
  };
  return {
    flp,
    opts,
    project,
    report,
    scale,
    tick: (fileTicks) => Math.max(0, Math.round(fileTicks * scale)),
    timeSignature: project.transport.timeSig,
    pluginInstance: (id: string, extra: Partial<PluginInstance> = {}): PluginInstance => {
      const info = opts.plugin(id);
      return { pluginId: id, pluginVersion: info?.version ?? 1, params: { ...(info?.params ?? {}) }, ...extra };
    },
    pluginName: (id) => opts.plugin(id)?.name ?? id.replace(/^agstudio\./, ''),
  };
}

/**
 * The arrangement to import: the one that was open, else the first with clips, else the first. The report
 * names it (when the file has several, or this one has a name) and lists the others that hold something.
 */
function chooseArrangement(flp: FlpProject, report: FlpImportReport): FlpArrangement {
  const arrangements = flp.arrangements;
  const open =
    flp.currentArrangement !== null ? arrangements.find((a) => a.index === flp.currentArrangement) : undefined;
  const arrangement: FlpArrangement = open ??
    arrangements.find((a) => a.items.length > 0) ??
    arrangements[0] ?? { index: 0, items: [], tracks: [], markers: [] };
  const nameOf = (a: FlpArrangement) => a.name || `Arrangement ${a.index + 1}`;
  if (arrangements.length > 1 || (arrangement.name && arrangements.length === 1)) {
    report.arrangement = nameOf(arrangement);
  }
  for (const other of arrangements) {
    if (other !== arrangement && (other.items.length > 0 || other.name)) report.otherArrangements.push(nameOf(other));
  }
  return arrangement;
}
