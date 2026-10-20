/**
 * The few facts about a song that a list of versions or projects shows: how long, how fast, what key, how big. Small and
 * plain, so they are stored beside each version and project and shown without opening anything.
 */
import { tempoMapOf } from '../automation/tempo';
import type { Project, SongKey } from '../model/types';
import { songLength } from '../query/playlist';
import { ticksPerBar } from '../time/ppq';

/** What a project's card shows. */
export interface ProjectFacts {
  /** Song length in whole bars (0 when the playlist is empty). */
  bars: number;
  /** Song length in seconds, following tempo automation (0 when the playlist is empty). */
  lengthSec: number;
  bpm: number;
  /** "A minor", or null when no key is set. */
  key: string | null;
  /** Clips on the playlist. */
  clips: number;
  patterns: number;
  /** Channels that make or play sound (automation channels are not counted). */
  channels: number;
}

const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** "C# minor", "F major pentatonic": the tonic and the scale id read as words. */
export function songKeyText(key: SongKey | undefined): string | null {
  if (!key) return null;
  const root = PITCH_NAMES[((Math.round(key.root) % 12) + 12) % 12];
  return `${root} ${key.scale.replace(/[-_]/g, ' ')}`;
}

/** Reads the facts off a project. */
export function projectFacts(project: Project): ProjectFacts {
  const lengthTicks = songLength(project);
  const bar = ticksPerBar(project.transport.timeSig);
  const lengthSec = lengthTicks > 0 ? tempoMapOf(project, 'song').tickToSeconds(lengthTicks) : 0;
  const channels = Object.values(project.channels).filter((channel) => channel.kind !== 'automation').length;
  return {
    bars: lengthTicks > 0 ? Math.round(lengthTicks / bar) : 0,
    lengthSec: Math.round(lengthSec * 10) / 10,
    bpm: project.transport.bpm,
    key: songKeyText(project.transport.key),
    clips: Object.keys(project.playlist.clips).length,
    patterns: Object.keys(project.patterns).length,
    channels,
  };
}

/** "3:05", "0:42": minutes and seconds of a length. */
export function formatLength(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}
