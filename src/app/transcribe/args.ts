/**
 * Reading a loosely typed request for "Convert to MIDI" (the `audioToMidi.convert` command's arguments, the AI's `audio_to_midi`
 * action) into a `ConvertSpec`. Every value is checked and a problem is said in plain words (`TranscribeError`). Fields left out
 * take the dialog's defaults; no mode, or "auto", takes the mode the sound suggests.
 */
import { DEFAULT_TRANSCRIBE, settingsFor, TRANSCRIBE_MODES, type Articulation, type TranscribeMode, type TranscribeSettings } from '@core/audio/transcribe';
import { COMP_RHYTHMS, type CompRhythm } from '@core/harmony/voicing';
import type { ChannelId, ClipId, Project } from '@core/model/types';
import { audioClipsFor } from '../actions/audio-clips';
import type { Services } from '../services';
import { suggestForClip, type ConvertSpec, type TranscribeTarget } from './convert';
import { GRID_CHOICES, parseGrid } from './grids';
import { TranscribeError } from './source';

/** The arguments of a conversion request, as they arrive (untrusted). */
export type ConvertArgs = Record<string, unknown>;

const ARTICULATIONS: readonly Articulation[] = ['natural', 'legato', 'staccato'];
const RESOLUTIONS: readonly TranscribeSettings['chordResolution'][] = ['beat', 'half', 'bar'];

/** A number from a request, clamped, or undefined when it is not one. */
function number(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : undefined;
}

/** A one-of choice from a request, or undefined when it is not offered; a wrong text is an error. */
function choice<T extends string>(name: string, value: unknown, among: readonly T[]): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && (among as readonly string[]).includes(value)) return value as T;
  throw new TranscribeError(`${name} must be one of: ${among.join(', ')}.`);
}

/** The audio clip a request is about: the one named, else the selected audio clip. */
export function clipOfArgs(s: Services, args: ConvertArgs | undefined): ClipId | null {
  const id = typeof args?.clip === 'string' ? args.clip : undefined;
  return audioClipsFor(s, id ? [id as ClipId] : undefined)[0]?.id ?? null;
}

/** A channel by id or by name. */
function channelByIdOrName(project: Project, text: string): ChannelId | null {
  if (project.channels[text as ChannelId]) return text as ChannelId;
  const named = project.channelOrder.find((id) => project.channels[id]?.name.toLowerCase() === text.toLowerCase());
  return named ?? null;
}

/** Where the notes go: a new channel (with an instrument, if named), or the channel named. */
function targetOf(s: Services, args: ConvertArgs): TranscribeTarget {
  const target = args.target;
  const plugin = typeof args.instrument === 'string' && args.instrument ? args.instrument : undefined;
  if (plugin && !s.plugins.get(plugin)) throw new TranscribeError(`There is no instrument "${plugin}" (see list_plugins).`);
  if (target === undefined || target === 'new') return { kind: 'new', ...(plugin ? { plugin } : {}) };
  if (typeof target !== 'string') throw new TranscribeError('target must be "new" or the name or id of an instrument channel.');
  const id = channelByIdOrName(s.doc.getState().project, target);
  if (!id) throw new TranscribeError(`There is no channel "${target}".`);
  return { kind: 'channel', channel: id };
}

/** The settings of a request for a mode. */
export function settingsOfArgs(mode: TranscribeMode, args: ConvertArgs): TranscribeSettings {
  const grid = args.quantize === undefined ? undefined : parseGrid(args.quantize);
  if (args.quantize !== undefined && !grid) throw new TranscribeError(`quantize must be one of: ${GRID_CHOICES.map((g) => g.id).join(', ')}.`);
  const strength = number(args.strength, 0, 100);
  const sensitivity = number(args.sensitivity, 0, 100);
  const swing = choice('swing', args.swing, ['straighten', 'keep'] as const);
  const articulation = choice('articulation', args.articulation, ARTICULATIONS);
  const resolution = choice('chord_resolution', args.chord_resolution, RESOLUTIONS);
  const rhythm = choice<CompRhythm>('chord_rhythm', args.chord_rhythm, COMP_RHYTHMS);
  const gap = number(args.legato_gap_ms, 0, 1000);
  return settingsFor(mode, {
    ...(sensitivity !== undefined ? { sensitivity: sensitivity / 100 } : {}),
    quantize: {
      gridTicks: grid ? grid.ticks : DEFAULT_TRANSCRIBE.quantize.gridTicks,
      strength: strength !== undefined ? strength / 100 : DEFAULT_TRANSCRIBE.quantize.strength,
      swing: swing ?? DEFAULT_TRANSCRIBE.quantize.swing,
    },
    ...(articulation ? { articulation } : {}),
    ...(gap !== undefined ? { legatoGapMs: gap } : {}),
    ...(typeof args.keep_cents === 'boolean' ? { keepCents: args.keep_cents } : {}),
    ...(resolution ? { chordResolution: resolution } : {}),
    ...(rhythm ? { chordRhythm: rhythm } : {}),
    ...(typeof args.chord_bass === 'boolean' ? { chordBass: args.chord_bass } : {}),
    // A chord conversion fills the chord track unless it is told not to.
    fillChordTrack: mode === 'chords' && args.fill_chord_track !== false,
  });
}

/** The mode a request names, or null for "auto" or none (then the sound's own suggestion is used). Throws on an unknown text. */
export function namedMode(value: unknown): TranscribeMode | null {
  if (value === undefined || value === 'auto') return null;
  if (typeof value === 'string' && (TRANSCRIBE_MODES as readonly string[]).includes(value)) return value as TranscribeMode;
  throw new TranscribeError(`mode must be one of: auto, ${TRANSCRIBE_MODES.join(', ')}.`);
}

/** Everything of a conversion but the clip, for a mode: checks every field of the request. Throws `TranscribeError`. */
export function specParts(s: Services, request: ConvertArgs, mode: TranscribeMode): Omit<ConvertSpec, 'clip'> {
  return {
    settings: settingsOfArgs(mode, request),
    target: targetOf(s, request),
    place: request.place !== false,
    muteOriginal: request.mute_original === true,
    slicePads: request.slice_pads !== false,
  };
}

/** The conversion a request asks for. Throws `TranscribeError`. */
export async function specFromArgs(s: Services, args: ConvertArgs | undefined): Promise<ConvertSpec> {
  const clip = clipOfArgs(s, args);
  if (!clip) throw new TranscribeError('Select the audio clip to convert on the playlist first.');
  const request = args ?? {};
  const mode = namedMode(request.mode) ?? (await suggestForClip(s, clip)).mode;
  return { clip, ...specParts(s, request, mode) };
}
