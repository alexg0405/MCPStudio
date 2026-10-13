import { DRUM_SOUNDS, type BeatSound } from '@core/beat/spec';
import { KIT } from '@core/model/kit';
import type { Channel, Note, PatternId, Project } from '@core/model/types';
import { patternLength } from '@core/query/queries';
import { ticksPerBar } from '@core/time/ppq';
import { BASS808_ID } from './apply';

/** What the assistant knows about the project: tempo, channels and the current pattern, in brief. */

const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (key: number) => `${NOTE[((key % 12) + 12) % 12]}${Math.floor(key / 12) - 1}`;

const KIT_SOUND: Record<string, BeatSound> = {
  'kit/kick': 'kick',
  'kit/snare': 'snare',
  'kit/clap': 'clap',
  'kit/hat-closed': 'hat',
  'kit/hat-open': 'open-hat',
  'kit/tom-low': 'tom-low',
  'kit/tom-mid': 'tom-mid',
  'kit/tom-high': 'tom-high',
  'kit/rim': 'rim',
  'kit/cowbell': 'cowbell',
  'kit/crash': 'crash',
};

/** The beat sound a channel corresponds to (null for audio clips and unknown instruments). */
export function channelSound(p: Project, ch: Channel): BeatSound | 'synth' | 'sample' | null {
  if (ch.kind !== 'instrument') return null;
  const id = ch.plugin.pluginId;
  if (id === 'agstudio.sampler') {
    const ref = p.samples[ch.plugin.samples?.main as keyof Project['samples']];
    if (ref?.source.kind === 'builtin') return KIT_SOUND[ref.source.generator] ?? 'sample';
    return 'sample';
  }
  if (id === BASS808_ID) return '808';
  if (id === 'agstudio.pluck') return 'pluck';
  if (id === 'agstudio.3xosc') return 'synth';
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

export function describeProject(p: Project, currentPatternId: PatternId | null): string {
  const lines: string[] = [];
  lines.push(
    `Tempo ${p.transport.bpm} BPM, ${p.transport.timeSig.num}/${p.transport.timeSig.den}, swing ${Math.round(p.transport.swing * 100)}%.`,
  );
  const channels = p.channelOrder
    .map((id) => p.channels[id])
    .filter((c): c is Channel => !!c)
    .map((c) => `${c.name} (${channelSound(p, c) ?? c.kind}${c.muted ? ', muted' : ''})`);
  lines.push(`Channels: ${channels.join(', ') || 'none'}.`);
  const pattern = currentPatternId ? p.patterns[currentPatternId] : undefined;
  if (pattern) {
    const bars = patternLength(pattern, p.transport.timeSig) / ticksPerBar(p.transport.timeSig);
    const parts: string[] = [];
    for (const id of p.channelOrder) {
      const ch = p.channels[id];
      const notes = Object.values(pattern.notes[id] ?? {});
      if (!ch || notes.length === 0) continue;
      const sound = channelSound(p, ch);
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
export const KIT_NAMES = Object.fromEntries(KIT.map((k) => [KIT_SOUND[k.generator], k.name]));
