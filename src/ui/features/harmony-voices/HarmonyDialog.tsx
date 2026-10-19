import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { buildPreview, PREVIEW_SECONDS, playPreview, type HarmonyPreview } from '@app/harmony/voice-preview';
import { MAX_HARMONY_VOICES, HUMANIZE_LIMITS } from '@core/harmony/voices';
import type { ClipId, Project } from '@core/model/types';
import { holdModal } from '../../controls/Dialog';
import dialog from '../../controls/Dialog.module.css';
import { useServices } from '../../services-context';
import {
  FIXED,
  GUIDE,
  RULE_CHOICES,
  STARTING_SETS,
  initialHumanize,
  initialRows,
  rowsOfSet,
  specOfRows,
  warningsFor,
  type VoiceRow,
} from './dialog-model';
import { closeHarmonyDialog, harmonyStore } from './harmony-store';
import { runMake } from './run';
import styles from './HarmonyDialog.module.css';

/** Overlay host: renders the dialog while it is open. */
export function HarmonyOverlay() {
  const open = useStore(harmonyStore, (s) => s.open);
  return open ? <HarmonyDialog clipId={open.clipId} seed={open.seed} /> : null;
}

/** A typed number that reports only values inside its range while typing; leaving the box shows the last good value. */
function NumberCell(props: { label: string; unit: string; value: number; min: number; max: number; step?: number; hint: string; onChange(v: number): void }) {
  // What is being typed, until the box is left; otherwise the box shows the value itself.
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className={styles.cell} data-hint={props.hint}>
      <span>
        {props.label} ({props.unit})
      </span>
      <input
        type="number"
        value={draft ?? String(props.value)}
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        aria-label={`${props.label} in ${props.unit}`}
        onChange={(e) => {
          setDraft(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value.trim() !== '' && Number.isFinite(n) && n >= props.min && n <= props.max) props.onChange(n);
        }}
        onBlur={() => setDraft(null)}
      />
    </label>
  );
}

/** The instrument channels that play notes in the song (the choices for a guide melody). */
function guideChannels(project: Project): { id: string; name: string }[] {
  const withNotes = new Set<string>();
  for (const pattern of Object.values(project.patterns)) for (const id of Object.keys(pattern.notes)) withNotes.add(id);
  return Object.values(project.channels)
    .filter((c) => c.kind === 'instrument' && withNotes.has(c.id))
    .map((c) => ({ id: c.id, name: c.name }));
}

/** One voice: its rule, and its level, pan and voice colour. */
function VoiceRowView(props: { index: number; row: VoiceRow; channels: { id: string; name: string }[]; canRemove: boolean; onChange(row: VoiceRow): void; onRemove(): void }) {
  const { row, onChange } = props;
  return (
    <div className={styles.voice}>
      <span className={styles.number}>{props.index + 1}</span>
      <label className={styles.cell} data-hint="What this voice sings against each note of the lead">
        <span>Sings</span>
        <select value={row.choice} aria-label={`Voice ${props.index + 1} rule`} onChange={(e) => onChange({ ...row, choice: e.target.value })}>
          {RULE_CHOICES.map((c) => (
            <option key={c.value} value={c.value} title={c.hint}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <NumberCell label="Level" unit="dB" value={row.levelDb} min={-24} max={6} step={0.5} hint="How loud this voice is against the lead, in dB (−24 to +6); you can change it later on its mixer channel" onChange={(levelDb) => onChange({ ...row, levelDb })} />
      <NumberCell label="Pan" unit="−100 to 100" value={Math.round(row.pan * 100)} min={-100} max={100} hint="Where the voice sits left to right: −100 left, 0 centre, 100 right" onChange={(pan) => onChange({ ...row, pan: pan / 100 })} />
      <NumberCell label="Vowel" unit="cents" value={row.formantCents} min={-300} max={300} step={10} hint="Moves the vowel colour (formants) without changing the note: a little up or down sounds like a different singer (−300 to 300 cents; 0 keeps the lead's)" onChange={(formantCents) => onChange({ ...row, formantCents })} />
      <button type="button" className={styles.remove} disabled={!props.canRemove} onClick={props.onRemove} aria-label={`Remove voice ${props.index + 1}`} data-hint="Take this voice out of the list">
        ✕
      </button>
      {row.choice === FIXED && (
        <div className={styles.extra}>
          <NumberCell label="Interval" unit="semitones" value={row.semitones} min={-12} max={12} hint="How far from the lead: +7 is a fifth above, −5 a fourth below (−12 to 12; the lead's own tuning is kept)" onChange={(semitones) => onChange({ ...row, semitones })} />
        </div>
      )}
      {row.choice === GUIDE && (
        <label className={`${styles.cell} ${styles.extra}`} data-hint="The instrument channel whose notes this voice sings: write the harmony in a pattern, then pick it here">
          <span>Notes of channel</span>
          <select value={row.guideChannel} aria-label={`Voice ${props.index + 1} guide channel`} onChange={(e) => onChange({ ...row, guideChannel: e.target.value })}>
            <option value="">Choose a channel…</option>
            {props.channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

/** The "Make harmonies" dialog: pick the voices, hear them against the lead, then make them. */
function HarmonyDialog({ clipId, seed }: { clipId: ClipId; seed: number }) {
  const s = useServices();
  const project = useStore(s.doc, (st) => st.project);
  const [rows, setRows] = useState<VoiceRow[]>(initialRows);
  const [humanize, setHumanize] = useState(initialHumanize);
  const [preview, setPreview] = useState<{ phase: 'none' | 'rendering' | 'ready' | 'error'; files?: HarmonyPreview; message?: string; playing?: 'leadOnly' | 'withHarmonies' }>({ phase: 'none' });
  const ref = useRef<HTMLDivElement>(null);
  const clip = project.playlist.clips[clipId];
  const channel = clip?.kind === 'audio' ? project.channels[clip.channelId] : undefined;
  const channels = useMemo(() => guideChannels(project), [project]);
  const warnings = warningsFor(project, rows);

  const changed = () => {
    s.engine.stopPreview();
    setPreview({ phase: 'none' });
  };
  const edit = (next: VoiceRow[]) => {
    setRows(next);
    changed();
  };

  useEffect(() => {
    const release = holdModal();
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        s.engine.stopPreview();
        closeHarmonyDialog();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      s.engine.stopPreview();
      release();
    };
  }, [s]);

  if (!clip || clip.kind !== 'audio') return null;
  const request = specOfRows(project, rows, humanize, seed);

  const hear = async (which: 'leadOnly' | 'withHarmonies') => {
    if ('problem' in request) return;
    let files = preview.files;
    if (!files) {
      setPreview({ phase: 'rendering' });
      try {
        files = await buildPreview(s, clipId, request);
      } catch (e) {
        setPreview({ phase: 'error', message: e instanceof Error ? e.message : String(e) });
        return;
      }
    }
    setPreview({ phase: 'ready', files, playing: which });
    await playPreview(s, files, which);
  };
  const make = () => {
    if ('problem' in request) return;
    s.engine.stopPreview();
    closeHarmonyDialog();
    void runMake(s, clipId, request);
  };

  return (
    <div className={dialog.backdrop} onPointerDown={(e) => e.target === e.currentTarget && closeHarmonyDialog()}>
      <div ref={ref} tabIndex={-1} className={`${dialog.dialog} ${styles.dialog}`} role="dialog" aria-modal="true" aria-labelledby="ag-harmony-title">
        <h2 id="ag-harmony-title" className={dialog.title}>
          Make harmonies
        </h2>
        <p className={styles.lead}>
          From “{channel?.name ?? 'this clip'}”: each voice becomes a new audio clip on its own track under it, made from the notes you sang (use one clear voice). Your recording is not changed, and one Undo removes them all.
        </p>
        <fieldset className={styles.group}>
          <legend>Voices (up to {MAX_HARMONY_VOICES})</legend>
          <div className={styles.sets}>
            {STARTING_SETS.map((set) => (
              <button key={set.name} type="button" className={styles.chip} data-hint={`${set.name}: ${set.hint}`} onClick={() => edit(rowsOfSet(set))}>
                {set.name}
              </button>
            ))}
            <button type="button" className={styles.chip} disabled={rows.length >= MAX_HARMONY_VOICES} data-hint="Add another voice (a third above to start with)" onClick={() => edit([...rows, rowsOfSet(STARTING_SETS[0]!)[0] as VoiceRow])}>
              + Add a voice
            </button>
          </div>
          {rows.map((row, i) => (
            <VoiceRowView
              key={i}
              index={i}
              row={row}
              channels={channels}
              canRemove={rows.length > 1}
              onChange={(next) => edit(rows.map((r, j) => (j === i ? next : r)))}
              onRemove={() => edit(rows.filter((_, j) => j !== i))}
            />
          ))}
          {warnings.map((w) => (
            <p key={w} className={styles.warning}>
              {w}
            </p>
          ))}
        </fieldset>
        <fieldset className={styles.group}>
          <legend>Make the voices a little different from the lead</legend>
          <div className={styles.humanize}>
            <NumberCell label="Timing" unit="± ms" value={humanize.timingMs} min={0} max={HUMANIZE_LIMITS.timingMs} hint="Each note starts up to this many milliseconds early or late, so the voices do not line up like copies" onChange={(timingMs) => { setHumanize({ ...humanize, timingMs }); changed(); }} />
            <NumberCell label="Pitch drift" unit="± cents" value={humanize.driftCents} min={0} max={HUMANIZE_LIMITS.driftCents} hint="Each note is up to this many cents (hundredths of a semitone) sharp or flat" onChange={(driftCents) => { setHumanize({ ...humanize, driftCents }); changed(); }} />
            <NumberCell label="Vibrato" unit="% different" value={Math.round(humanize.vibrato * 100)} min={0} max={100} hint="How much each note's vibrato differs from the lead's: 30 means 70–130 % of the lead's wobble" onChange={(v) => { setHumanize({ ...humanize, vibrato: v / 100 }); changed(); }} />
          </div>
        </fieldset>
        <fieldset className={styles.group}>
          <legend>Hear it first (the first {PREVIEW_SECONDS} seconds)</legend>
          <div className={styles.preview}>
            <button type="button" className={`${styles.chip} ${preview.playing === 'leadOnly' ? styles.lit : ''}`} disabled={'problem' in request || preview.phase === 'rendering'} onClick={() => void hear('leadOnly')} data-hint="A: plays the lead alone, at the same level as B">
              A · Lead alone
            </button>
            <button type="button" className={`${styles.chip} ${preview.playing === 'withHarmonies' ? styles.lit : ''}`} disabled={'problem' in request || preview.phase === 'rendering'} onClick={() => void hear('withHarmonies')} data-hint="B: plays the lead with the voices above, as they will sound when made">
              B · With harmonies
            </button>
            <button type="button" className={styles.chip} onClick={() => { s.engine.stopPreview(); setPreview({ ...preview, playing: undefined }); }} data-hint="Stops the preview">
              Stop
            </button>
            <span className={styles.status} aria-live="polite">
              {preview.phase === 'none' && ('problem' in request ? request.problem : 'Press B to render the voices and hear them; A switches back to the lead.')}
              {preview.phase === 'rendering' && 'Rendering the voices…'}
              {preview.phase === 'ready' && 'Playing. Change anything above to hear it again.'}
              {preview.phase === 'error' && preview.message}
            </span>
          </div>
        </fieldset>
        <div className={dialog.buttons}>
          <button className={dialog.button} onClick={() => { s.engine.stopPreview(); closeHarmonyDialog(); }} data-hint="Close without making anything">
            Cancel
          </button>
          <button className={`${dialog.button} ${dialog.primary}`} disabled={'problem' in request || warnings.some((w) => w.startsWith('The song has no key'))} onClick={make} data-hint="Make the voices as new tracks under the lead (one undo step)">
            Make harmonies
          </button>
        </div>
      </div>
    </div>
  );
}
