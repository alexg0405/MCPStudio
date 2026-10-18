import { DRUM_SOUNDS, type BeatSound } from '@core/beat/spec';
import type { Project } from '@core/model/types';
import { channelSound, noteName } from '../assistant/context';

const r2 = (v: number) => Math.round(v * 100) / 100;
const fmtStep = (steps: number) => String(Math.round(steps * 100) / 100);
const fmtVel = (v: number) => (Math.abs(v - 0.8) < 0.005 ? '' : `@${String(r2(v)).replace(/^0(?=\.)/, '')}`);

/** A pattern's notes per channel, as the AI writes them. */
export function noteLines(project: Project, pattern: Project['patterns'][keyof Project['patterns']]): string[] {
  const lines: string[] = [];
  for (const id of project.channelOrder) {
    const ch = project.channels[id];
    const notes = Object.values(pattern.notes[id] ?? {}).sort((a, b) => a.tick - b.tick || a.key - b.key);
    if (!ch || notes.length === 0) continue;
    const sound = channelSound(project, ch);
    const drum = sound !== null && DRUM_SOUNDS.has(sound as BeatSound);
    const shown = notes.slice(0, 96).map((n) => {
      const step = fmtStep(n.tick / 240);
      return drum
        ? `${step}${fmtVel(n.velocity)}`
        : `${step}:${noteName(n.key)}/${fmtStep(n.length / 240)}${fmtVel(n.velocity)}`;
    });
    lines.push(`  ${ch.name}: ${shown.join(' ')}${notes.length > 96 ? ` … (+${notes.length - 96} more)` : ''}`);
  }
  return lines;
}
