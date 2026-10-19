/**
 * The types of the FL Studio import: what the caller passes in (`FlpImportOptions`), what comes out
 * (`FlpImportResult` with its `FlpImportReport`), and the `FlpImportContext` the import steps share.
 */
import type { ParamValue } from '@agstudio/sdk/params';
import type { PatternId, PluginInstance, Project, SampleRef, TimeSignature } from '../model/types';
import type { FlpProject } from './flp';

/** Built-in plugin ids the importer uses. */
export const FLP_PLUGIN = {
  sampler: 'agstudio.sampler',
  threeOsc: 'agstudio.3xosc',
  wavetable: 'agstudio.wavetable',
  fm: 'agstudio.fm',
  bass808: 'agstudio.bass808',
  drumPads: 'agstudio.drum-pads',
  drumSynth: 'agstudio.drum-synth',
  pluck: 'agstudio.pluck',
  slicer: 'agstudio.slicer',
} as const;

/** What the importer needs to know about one built-in plugin. */
export interface FlpPluginInfo {
  version: number;
  /** Default param values. */
  params: Record<string, ParamValue>;
  /** Display name ("Wavetable"). */
  name: string;
}

/** The result of looking up one FL sample: the reference to store in the project and whether its audio was found. */
export interface FlpResolvedSample {
  /** The sample to reference. A missing file still gets a ref (named after it, with no audio). */
  ref: SampleRef;
  /** The audio was found (in the package) and stored. */
  found: boolean;
}

/**
 * What the FL Studio import needs from the caller: the file's name, how to look up built-in plugins, the resolved
 * samples and whether they came in a package.
 */
export interface FlpImportOptions {
  /** The imported file's name (the project title when FL's is empty). */
  fileName: string;
  /** Built-in plugin lookup: defaults and name, undefined when not installed. */
  plugin(id: string): FlpPluginInfo | undefined;
  /** Resolved samples by FL sample path (see flpSamplePaths). */
  samples: ReadonlyMap<string, FlpResolvedSample>;
  /** Whether the samples came with the file (a zipped loop package); only changes the advice. */
  fromPackage?: boolean;
  now?: Date;
}

/** An FL plugin that plays through a built-in instead. */
export interface FlpStandIn {
  channel: string;
  /** The FL plugin ("Serum", "Sytrus"). */
  plugin: string;
  /** The built-in that plays instead. */
  using: string;
  vst: boolean;
}

/** What came across the import and what didn't (`describeFlpImport` puts it in words). */
export interface FlpImportReport {
  title: string;
  flVersion: string;
  channels: number;
  patterns: number;
  notes: number;
  clips: number;
  markers: number;
  inserts: number;
  effects: number;
  /** The imported arrangement's name, or null for files without arrangements (before FL 12.9). */
  arrangement: string | null;
  /** Arrangements that weren't imported. */
  otherArrangements: string[];
  standIns: FlpStandIn[];
  missingSamples: { channel: string; file: string; path: string }[];
  /** Effects with a built-in counterpart (FL name → built-in). */
  effectStandIns: { insert: string; plugin: string; using: string }[];
  skippedEffects: { insert: string; plugin: string }[];
  /** Automation clips that came in without a target (FL's target couldn't be matched). */
  untargetedAutomation: string[];
  /** Layer channels whose notes went to their children. */
  layers: { channel: string; children: number }[];
  slideNotes: number;
  /** Notes on channels that don't exist (or can't play notes). */
  orphanNotes: number;
  /** Playlist clips that couldn't be placed. */
  skippedClips: number;
  /** Reader warnings (cut-off file, caps). */
  warnings: string[];
}

/** What the FL Studio import produces: the project, a report of what happened and where to start looking at it. */
export interface FlpImportResult {
  project: Project;
  report: FlpImportReport;
  /** The pattern to show first. */
  firstPatternId: PatternId;
  /** True when the playlist has clips (open in song mode). */
  hasSong: boolean;
}

/** What every import step needs: the file, the project being built, the report being filled. */
export interface FlpImportContext {
  flp: FlpProject;
  opts: FlpImportOptions;
  project: Project;
  report: FlpImportReport;
  /** Our ticks per tick of the file (PPQ 960 over the file's PPQ). */
  scale: number;
  /** A position or length in the file's ticks as our ticks (never below 0). */
  tick(fileTicks: number): number;
  timeSignature: TimeSignature;
  /** A plugin instance with the host's default params for built-in plugin `id`. */
  pluginInstance(id: string, extra?: Partial<PluginInstance>): PluginInstance;
  /** The built-in plugin's display name. */
  pluginName(id: string): string;
}

const NAME_MAX_LENGTH = 64;

/** `value` limited to `min`…`max`. */
export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Shortens a name to what the project allows, ending in "…" when it was cut. */
export const trimName = (name: string): string =>
  name.length > NAME_MAX_LENGTH ? name.slice(0, NAME_MAX_LENGTH - 1).trimEnd() + '…' : name;
