import { DRUM_SOUNDS, type BeatSound } from '@core/beat/spec';
import { KIT, kitPiece } from '@core/model/kit';
import type { Channel, Note, PatternId, Project } from '@core/model/types';
import { patternLength } from '@core/query/queries';
import { ticksPerBar } from '@core/time/ppq';
import { BASS808_ID, FM_ID, PLUCK_ID, THREE_OSC_ID, WAVETABLE_ID } from './palette';

/** What the assistant knows about the project: tempo, channels and the current pattern, in brief. */

const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (key: number) => `${NOTE[((key % 12) + 12) % 12]}${Math.floor(key / 12) - 1}`;

/** The beat sound a channel corresponds to (null for audio clips and unknown instruments). */
export function channelSound(project: Project, ch: Channel): BeatSound | 'synth' | 'sample' | null {
  if (ch.kind !== 'instrument') return null;
  const id = ch.plugin.pluginId;
  if (id === 'agstudio.sampler') {
    const ref = project.samples[ch.plugin.samples?.main as keyof Project['samples']];
    // Stock or genre kit pieces ("kit/trap/kick").
    if (ref?.source.kind === 'builtin') return kitPiece(ref.source.generator)?.sound ?? 'sample';
    return 'sample';
  }
  if (id === BASS808_ID) return '808';
  if (id === PLUCK_ID) return 'pluck';
  if (id === THREE_OSC_ID || id === WAVETABLE_ID || id === FM_ID) return 'synth';
  return null;
}

const fmt = (steps: number) => String(Math.round(steps * 100) / 100);

function notesLine(notes: readonly Note[], drum: boolean): string {
  const sorted = [...notes].sort((a, b) => a.tick - b.tick || a.key - b.key).slice(0, 64);
  return sorted
    .map((n) => {
      const step = fmt(n.tick / 240);
      if (drum) return n.velocity < 0.5 ? `${step}(soft)` : step;
      return `${step}:${noteName(n.key)}/${fmt(n.length / 240)}`;
    })
    .join(' ');
}

export function describeProject(project: Project, currentPatternId: PatternId | null): string {
  const lines: string[] = [];
  lines.push(
    `Tempo ${project.transport.bpm} BPM, ${project.transport.timeSig.num}/${project.transport.timeSig.den}, swing ${Math.round(project.transport.swing * 100)}%.`,
  );
  const channels = project.channelOrder
    .map((id) => project.channels[id])
    .filter((c): c is Channel => !!c)
    .map((c) => `${c.name} (${channelSound(project, c) ?? c.kind}${c.muted ? ', muted' : ''})`);
  lines.push(`Channels: ${channels.join(', ') || 'none'}.`);
  const pattern = currentPatternId ? project.patterns[currentPatternId] : undefined;
  if (pattern) {
    const bars = patternLength(pattern, project.transport.timeSig) / ticksPerBar(project.transport.timeSig);
    const parts: string[] = [];
    for (const id of project.channelOrder) {
      const ch = project.channels[id];
      const notes = Object.values(pattern.notes[id] ?? {});
      if (!ch || notes.length === 0) continue;
      const sound = channelSound(project, ch);
      parts.push(`${ch.name}: ${notesLine(notes, sound !== null && DRUM_SOUNDS.has(sound as BeatSound))}`);
    }
    lines.push(
      `Current pattern "${pattern.name}" (${fmt(bars)} bar${bars === 1 ? '' : 's'}, steps as step or step:note/length): ${
        parts.length ? `\n  ${parts.join('\n  ')}` : 'empty'
      }`,
    );
  }
  const text = lines.join('\n');
  return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
}

/** Kit piece names, for the UI. */
export const KIT_NAMES = Object.fromEntries(KIT.map((k) => [k.sound, k.name]));
