import { useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { selectedAudioClips } from '@app/actions/align';
import { renderAlignmentNow } from '@app/actions/align-render';
import { playFrom } from '@app/actions/transport';
import { alignState } from '@app/align/state';
import { moveAt } from '@core/audio/align';
import {
  alignPitch,
  alignStepTicks,
  alignStrength,
  DEFAULT_GRID_STEP_TICKS,
  DEFAULT_GRID_STRENGTH,
  DEFAULT_PITCH_ALIGN,
  DEFAULT_TIGHTNESS,
  GRID_STEPS,
} from '@core/audio/align/edit';
import type { AudioClip, ClipId, Project } from '@core/model/types';
import { ticksPerBar } from '@core/time/ppq';
import { useDoc, useServices } from '../../services-context';
import styles from './AlignWindow.module.css';

type Mode = 'guide' | 'grid';

/** The settings the window shows before they are applied. */
interface Draft {
  mode: Mode;
  guide: ClipId | '';
  tightness: number;
  pitch: number;
  stepTicks: number;
  strength: number;
}

const FRESH: Draft = { mode: 'guide', guide: '', tightness: DEFAULT_TIGHTNESS, pitch: DEFAULT_PITCH_ALIGN, stepTicks: DEFAULT_GRID_STEP_TICKS, strength: DEFAULT_GRID_STRENGTH };

/** The draft that matches what a clip is aligned with now (or a fresh one). */
function draftOf(clip: AudioClip | undefined): Draft {
  const align = clip?.align;
  if (!align) return FRESH;
  return {
    mode: align.mode,
    guide: align.guide ?? '',
    tightness: align.tightness,
    pitch: alignPitch(align),
    stepTicks: alignStepTicks(align),
    strength: alignStrength(align),
  };
}

/** "Lead vocal · track 2, bar 1": how a clip is named in the guide list. */
function clipLabel(p: Project, clip: AudioClip): string {
  const channel = p.channels[clip.channelId];
  const track = p.playlist.laneOrder.indexOf(clip.laneId) + 1;
  const bar = Math.round((clip.start / ticksPerBar(p.transport.timeSig) + 1) * 100) / 100;
  return `${channel?.name ?? 'Audio'} · track ${track}, bar ${bar}`;
}

/** Median and largest move (ms) over an overlay's points. */
function movesOf(warp: readonly number[] | undefined): { median: number; max: number } | null {
  if (!warp || warp.length < 4) return null;
  const moves: number[] = [];
  for (let t = warp[0] as number; t <= (warp[warp.length - 2] as number); t += 0.02) moves.push(Math.abs(moveAt(warp, t)));
  moves.sort((a, b) => a - b);
  return { median: Math.round(moves[moves.length >> 1] as number), max: Math.round(moves[moves.length - 1] as number) };
}

/** The audio clips the window acts on: the clip it was opened for, else the selected audio clips. */
function useTargets(): AudioClip[] {
  const services = useServices();
  const opened = useStore(alignState, (s) => s.windowClip);
  const selection = useStore(services.editor, (e) => e.clipSelection);
  const clips = useDoc((p) => p.playlist.clips);
  return useMemo(() => {
    if (opened) {
      const clip = clips[opened];
      return clip?.kind === 'audio' ? [clip] : [];
    }
    return selectedAudioClips(services);
    // The selection and the clips decide it; `services` is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [services, opened, selection, clips]);
}

/** The Align window: follow a lead (timing and pitch) or tighten to the grid, with A/B listening and a status line. */
export function AlignWindow() {
  const services = useServices();
  const targets = useTargets();
  const project = useDoc((p) => p);
  const first = targets[0];
  const [draft, setDraft] = useState<Draft>(() => draftOf(first));
  // Another clip comes first: show what that clip is aligned with (state adjusted while rendering, not in an effect).
  const firstId = first?.id;
  const [shownFor, setShownFor] = useState(firstId);
  if (shownFor !== firstId) {
    setShownFor(firstId);
    setDraft(draftOf(first));
  }
  // Closing the window puts every clip back on its aligned sound (A/B is for comparing while it is open).
  useEffect(
    () => () => {
      for (const id of services.editor.getState().alignOriginal) services.editor.getState().setAlignOriginal(id, false);
    },
    [services],
  );
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  if (targets.length === 0) return <EmptyState />;
  const guides = Object.values(project.playlist.clips)
    .filter((c): c is AudioClip => c.kind === 'audio' && !targets.some((t) => t.id === c.id))
    .sort((a, b) => project.playlist.laneOrder.indexOf(a.laneId) - project.playlist.laneOrder.indexOf(b.laneId) || a.start - b.start);

  return (
    <div className={styles.root}>
      <Heading targets={targets} project={project} />
      <div className={styles.modes} role="tablist" aria-label="How to align">
        <ModeButton active={draft.mode === 'guide'} onPick={() => set({ mode: 'guide' })} hint="Follow a lead: the syllables of the selected clips move onto the timing of a guide clip (and optionally its pitch)">
          Follow a lead
        </ModeButton>
        <ModeButton active={draft.mode === 'grid'} onPick={() => set({ mode: 'grid' })} hint="Snap to the grid: the syllable starts move towards the nearest grid line, so a vocal sits tight with the beat">
          Snap to the grid
        </ModeButton>
      </div>
      {draft.mode === 'guide' ? <GuideControls draft={draft} set={set} guides={guides} project={project} /> : <GridControls draft={draft} set={set} />}
      <Actions draft={draft} targets={targets} guideMissing={draft.mode === 'guide' && (!draft.guide || !guides.some((g) => g.id === draft.guide))} />
      <Status targets={targets} />
    </div>
  );
}

function EmptyState() {
  return (
    <div className={styles.root}>
      <div className={styles.empty} data-hint="Select audio clips on the playlist to align them">
        <strong>Nothing to align yet.</strong>
        <span>Select one or more audio clips on the playlist: a double, a backing vocal or an ad-lib. Then pick the lead clip they should follow here, or snap them to the grid.</span>
        <span>Right-clicking a clip and choosing “Align to guide…” opens this window for it.</span>
      </div>
    </div>
  );
}

function Heading({ targets, project }: { targets: AudioClip[]; project: Project }) {
  const names = targets.map((c) => project.channels[c.channelId]?.name ?? 'Audio');
  const text = targets.length === 1 ? (names[0] as string) : `${targets.length} clips (${names.slice(0, 3).join(', ')}${names.length > 3 ? ', …' : ''})`;
  return (
    <div className={styles.heading} data-hint="The audio clips this window aligns: the ones selected on the playlist">
      <span className={styles.dim}>Aligning</span> <strong>{text}</strong>
    </div>
  );
}

function ModeButton({ active, onPick, hint, children }: { active: boolean; onPick: () => void; hint: string; children: string }) {
  return (
    <button type="button" role="tab" aria-selected={active} className={`${styles.mode} ${active ? styles.modeOn : ''}`} onClick={onPick} data-hint={hint}>
      {children}
    </button>
  );
}

function Slider(props: { label: string; value: number; unit: string; hint: string; min?: number; max?: number; onChange: (v: number) => void }) {
  return (
    <label className={styles.field} data-hint={props.hint}>
      <span className={styles.label}>{props.label}</span>
      <input type="range" min={props.min ?? 0} max={props.max ?? 100} step={1} value={Math.round(props.value)} onChange={(e) => props.onChange(Number(e.target.value))} />
      <span className={styles.value}>
        {Math.round(props.value)} {props.unit}
      </span>
    </label>
  );
}

function GuideControls({ draft, set, guides, project }: { draft: Draft; set: (p: Partial<Draft>) => void; guides: AudioClip[]; project: Project }) {
  return (
    <div className={styles.controls}>
      <label className={styles.field} data-hint="The lead the selected clips should follow: any other audio clip of the song (usually the lead vocal)">
        <span className={styles.label}>Guide (the lead)</span>
        <select value={draft.guide} onChange={(e) => set({ guide: e.target.value as ClipId })}>
          <option value="">{guides.length ? 'Choose the lead clip…' : 'No other audio clip in the song'}</option>
          {guides.map((g) => (
            <option key={g.id} value={g.id}>
              {clipLabel(project, g)}
            </option>
          ))}
        </select>
      </label>
      <Slider
        label="Tightness"
        value={draft.tightness}
        unit="%"
        hint="How strictly to follow the lead: 0 % only fixes big offsets (keeps the looseness of a real double), 100 % lines up every syllable"
        onChange={(tightness) => set({ tightness })}
      />
      <Slider
        label="Pitch alignment"
        value={draft.pitch}
        unit="%"
        hint="How much of the pitch difference from the lead is corrected, in %: 0 leaves the pitch as sung, 100 follows the lead's pitch contour (a harmony keeps its interval)"
        onChange={(pitch) => set({ pitch })}
      />
    </div>
  );
}

function GridControls({ draft, set }: { draft: Draft; set: (p: Partial<Draft>) => void }) {
  return (
    <div className={styles.controls}>
      <label className={styles.field} data-hint="The grid the syllable starts snap to: a note value (1/16 = a sixteenth note)">
        <span className={styles.label}>Grid</span>
        <select value={draft.stepTicks} onChange={(e) => set({ stepTicks: Number(e.target.value) })}>
          {GRID_STEPS.map((g) => (
            <option key={g.ticks} value={g.ticks}>
              {g.label}
            </option>
          ))}
        </select>
      </label>
      <Slider
        label="Strength"
        value={draft.strength}
        unit="%"
        hint="How far each syllable start moves towards the grid line, in %: 100 % lands on it, 50 % goes half way and keeps some human feel. Starts further than about half a grid step from a line are left alone"
        onChange={(strength) => set({ strength })}
      />
    </div>
  );
}

function Actions({ draft, targets, guideMissing }: { draft: Draft; targets: AudioClip[]; guideMissing: boolean }) {
  const services = useServices();
  const ids = targets.map((c) => c.id);
  const hasAlignment = targets.some((c) => c.align);
  const original = useStore(services.editor, (e) => !!ids[0] && e.alignOriginal.includes(ids[0]));
  const ready = targets.some((c) => c.align?.renderedSampleId);
  const apply = () => {
    if (draft.mode === 'guide') void services.commands.run('align.apply', { guide: draft.guide, clips: ids, tightness: draft.tightness, pitch: draft.pitch });
    else void services.commands.run('align.tighten', { clips: ids, strength: draft.strength, grid: GRID_STEPS.find((g) => g.ticks === draft.stepTicks)?.label.split(' ')[0] });
  };
  const listen = (hearOriginal: boolean) => void services.commands.run('align.toggleOriginal', { clip: ids.find((id) => targets.find((t) => t.id === id)?.align), original: hearOriginal });
  return (
    <div className={styles.actions}>
      <button
        type="button"
        className={styles.primary}
        disabled={draft.mode === 'guide' && guideMissing}
        onClick={apply}
        data-hint={hasAlignment ? 'Aligns again with these settings (one undo step); the aligned sound is made in the background' : 'Aligns the selected clips with these settings (one undo step); the aligned sound is made in the background and the clips play it when it is ready. Your recording stays untouched'}
      >
        {hasAlignment ? 'Update alignment' : 'Align'}
      </button>
      <button
        type="button"
        className={styles.button}
        onClick={() => playFrom(services, Math.min(...targets.map((c) => c.start)))}
        data-hint="Plays the song from the start of the selected clips, so you hear the alignment"
      >
        Play
      </button>
      <div className={styles.ab} role="group" aria-label="Hear">
        <button type="button" className={!original ? styles.abOn : styles.abOff} disabled={!hasAlignment || !ready} onClick={() => listen(false)} data-hint="A: hear the aligned sound (what the clips play)">
          Aligned
        </button>
        <button type="button" className={original ? styles.abOn : styles.abOff} disabled={!hasAlignment || !ready} onClick={() => listen(true)} data-hint="B: hear the original recording instead, to compare. Nothing in the project changes; it goes back to aligned when this window is closed">
          Original
        </button>
      </div>
      <button
        type="button"
        className={styles.button}
        disabled={!hasAlignment}
        onClick={() => void services.commands.run('align.remove', { clips: ids })}
        data-hint="Takes the alignment off the selected clips so they play their own recording again (one undo step)"
      >
        Remove
      </button>
    </div>
  );
}

function Status({ targets }: { targets: AudioClip[] }) {
  const services = useServices();
  const view = useStore(alignState, (s) => s);
  const hearing = useStore(services.editor, (e) => targets.some((t) => e.alignOriginal.includes(t.id)));
  const aligned = targets.filter((c) => c.align);
  if (aligned.length === 0) return <div className={styles.status}>Choose how to align, then press Align.</div>;
  const problem = aligned.map((c) => view.problems[c.id]).find(Boolean);
  const rendering = aligned.map((c) => view.rendering[c.id]).filter((v): v is number => v !== undefined);
  const missing = aligned.filter((c) => !c.align?.renderedSampleId);
  const clip = aligned[0] as AudioClip;
  const moves = movesOf(clip.align?.warp);
  let text: string;
  if (problem) text = problem;
  else if (rendering.length) text = `Making the aligned sound… ${Math.round((rendering.reduce((a, b) => a + b, 0) / rendering.length) * 100)} %`;
  else if (hearing) text = 'Hearing your original recording (Aligned switches back)';
  else if (missing.length) text = 'The aligned sound is not made yet.';
  else if (moves) text = `Aligned: syllables moved ${moves.median} ms typically, ${moves.max} ms at most.`;
  else text = 'Aligned.';
  return (
    <div className={styles.status} data-hint="What is happening: the aligned sound is made in the background after every change">
      {text}
      {(problem || (!rendering.length && missing.length > 0)) && (
        <button type="button" className={styles.link} onClick={() => aligned.forEach((c) => renderAlignmentNow(c.id))} data-hint="Makes the aligned sound again now">
          Render now
        </button>
      )}
    </div>
  );
}
