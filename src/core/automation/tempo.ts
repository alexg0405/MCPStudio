import { TICKS_PER_STEP, constantTempo, type TempoMap } from '../time/ppq';
import { sameTempo, steppedTempo, type TempoStep } from '../time/tempo';
import type { Project } from '../model/types';
import { automationAt, automationModelOf, type TargetAutomation } from './model';
import { TEMPO_RANGE } from './targets';

const constants = new Map<number, TempoMap>();
const constantOf = (bpm: number) => {
  let m = constants.get(bpm);
  if (!m) constants.set(bpm, (m = constantTempo(bpm)));
  return m;
};

let last: { bpm: number; mode: string; tempo: TargetAutomation | undefined; map: TempoMap } | null = null;

/**
 * The project's tempo map: the base tempo, plus tempo automation clips in song mode (evaluated once
 * per 1/16 step). Returns the same object while the inputs are unchanged, and while the result
 * describes the same tempo, so the scheduler only re-anchors on real tempo changes.
 */
export function tempoMapOf(p: Project, mode: 'pattern' | 'song'): TempoMap {
  const bpm = p.transport.bpm;
  const tempo = mode === 'song' ? automationModelOf(p).targets.get('tempo') : undefined;
  if (last && last.bpm === bpm && last.mode === mode && last.tempo === tempo) return last.map;
  let map: TempoMap;
  if (!tempo) map = constantOf(bpm);
  else {
    const end = Math.max(...tempo.spans.map((s) => s.end));
    const steps: TempoStep[] = [{ tick: 0, bpm }];
    for (let tick = 0; tick <= end; tick += TICKS_PER_STEP) {
      const hit = automationAt(tempo, tick);
      if (!hit) continue;
      const r = hit.span.range && hit.span.range.min < hit.span.range.max ? hit.span.range : TEMPO_RANGE;
      const v = r.min + hit.value * (r.max - r.min);
      steps.push({ tick, bpm: Math.round(v * 1000) / 1000 });
    }
    map = steppedTempo(steps);
    if (last && sameTempo(last.map, map, end + TICKS_PER_STEP)) map = last.map;
  }
  last = { bpm, mode, tempo, map };
  return map;
}
