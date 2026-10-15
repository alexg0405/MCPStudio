/**
 * For the mix-level tests (browser): a song the AI studio would build in one answer (a beat, the
 * playlist, the mix setup), and independent measurements of its buses and master.
 */
import { Measurer, type Measurement } from '@app/analysis/measure';
import { applyAnswer } from '@app/ai/apply';
import type { AiAction } from '@app/ai/schema';
import { findMixLayout, type BusRole } from '@app/mix/layout';
import type { Services } from '@app/services';
import type { Style } from '@core/beat/style';
import { MASTER, type InsertId, type Project } from '@core/model/types';
import { planStems, stemProject, withoutMasterChain } from '@core/query/stems';
import { ticksPerBar } from '@core/time/ppq';
import { tempoMapOf } from '@core/automation/tempo';
import { renderOffline } from '@engine/render-offline';

const SR = 48000;

/** Two bars of a full beat in `style` (drums, 808 or bass, chords, a lead), placed 4 times, then the mix setup. */
export function buildSong(s: Services, style: Style, opts: { bpm: number; low: '808' | 'bass'; mix?: boolean }) {
  const bar = (b: number, steps: number[]) => steps.map((x) => b * 16 + x);
  const kick = [...bar(0, [0, 7, 10]), ...bar(1, [0, 7, 10, 14])];
  const actions: AiAction[] = [
    {
      op: 'beat',
      title: 'Main',
      ref: '@main',
      style,
      bpm: opts.bpm,
      bars: 2,
      tracks: [
        { name: 'Kick', sound: 'kick', notes: kick.map((step) => ({ step })) },
        { name: 'Clap', sound: 'clap', notes: [8, 24].map((step) => ({ step })) },
        { name: 'Hat', sound: 'hat', notes: Array.from({ length: 16 }, (_, i) => ({ step: i * 2 })) },
        {
          name: opts.low === '808' ? '808' : 'Bass',
          sound: opts.low,
          notes: kick.map((step, i) => ({ step, len: Math.max(1, (kick[i + 1] ?? 32) - step), key: opts.low === '808' ? 29 : 41 })),
        },
        { name: 'Pad', sound: 'pad', notes: [0, 16].flatMap((step) => [53, 56, 60].map((key) => ({ step, len: 16, key }))) },
        {
          name: 'Lead',
          sound: 'lead',
          notes: [0, 3, 6, 8, 12, 16, 19, 22, 24, 28].map((step, i) => ({ step, len: 2, key: [72, 75, 77, 75, 72][i % 5]! })),
        },
      ],
    },
    { op: 'place_pattern', pattern: '@main', bar: 1, track: 1, times: 4 },
    ...(opts.mix === false ? [] : [{ op: 'setup_mix', style, mode: 'rebuild' } as AiAction]),
  ];
  const res = applyAnswer(s, { message: 'A song', actions }, { previousBeat: null, label: 'song' });
  s.view.getState().setMode('song');
  return res;
}

export interface Measured {
  buses: Partial<Record<BusRole, Measurement>>;
  master: Measurement;
}

/** Each role bus as it reaches the master (its chain bypassed) and the master as heard, over bars 1–bars. */
export async function measureSong(s: Services, bars: number): Promise<Measured> {
  const project = s.doc.getState().project;
  const layout = findMixLayout(project);
  const toTick = bars * ticksPerBar(project.transport.timeSig);
  const tempo = tempoMapOf(project, 'song');
  const frames = Math.round((tempo.tickToSeconds(toTick) - tempo.tickToSeconds(0)) * SR);
  const render = async (p: Project, limiter: boolean) => {
    const r = await renderOffline(p, {
      plugins: s.plugins,
      view: { mode: 'song', patternId: null, loop: null },
      bars,
      sampleRate: SR,
      tail: 0,
      limiter,
    });
    const start = Math.round((r.preRoll + r.latency) * SR);
    const m = new Measurer(SR, true);
    m.push(r.buffer.getChannelData(0).subarray(start, start + frames), r.buffer.getChannelData(1).subarray(start, start + frames));
    return m.result();
  };
  const raw = withoutMasterChain(project);
  const stems = planStems(raw, { mode: 'song', patternId: null, fromTick: 0, toTick });
  const buses: Measured['buses'] = {};
  for (const [role, id] of Object.entries(layout.buses) as [BusRole, InsertId][]) {
    const stem = stems.find((st) => st.insertId === id);
    if (stem && id !== MASTER) buses[role] = await render(stemProject(raw, stems, stem), false);
  }
  return { buses, master: await render(project, true) };
}
