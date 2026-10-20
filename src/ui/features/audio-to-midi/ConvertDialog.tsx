import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { buildAudition, playAudition, AUDITION_SECONDS, type Audition, type AuditionSide } from '@app/transcribe/audition';
import { planClip, suggestForClip } from '@app/transcribe/convert';
import { SUGGESTED_INSTRUMENT } from '@app/transcribe/instruments';
import { sourceProblem } from '@app/transcribe/source';
import { MODE_LABELS, TRANSCRIBE_MODES, type ModeSuggestion, type Transcription, type TranscribeMode, type TranscribeSettings } from '@core/audio/transcribe';
import type { AudioClip, ClipId } from '@core/model/types';
import { ticksPerBar } from '@core/time/ppq';
import { holdModal } from '../../controls/Dialog';
import dialog from '../../controls/Dialog.module.css';
import { useServices } from '../../services-context';
import { CheckField, SelectField, SliderField } from './ConvertFields';
import { MiniRoll } from './MiniRoll';
import { closeConvertDialog, convertStore } from './convert-store';
import {
  ARTICULATIONS,
  CHORD_RESOLUTIONS,
  GRID_CHOICES,
  RHYTHMS,
  RHYTHM_LABELS,
  fieldsFor,
  initialState,
  instrumentChannels,
  settingsOf,
  specOf,
  type DialogState,
} from './dialog-model';
import { problemText, runConvert } from './run';
import styles from './ConvertDialog.module.css';

/** How long the dialog waits after a change before it plans again (ms): a slider drag is one plan, not fifty. */
const PLAN_DELAY_MS = 150;

/** Overlay host: renders the dialog while it is open. */
export function ConvertOverlay() {
  const open = useStore(convertStore, (st) => st.open);
  return open ? <ConvertDialog key={open.clipId} clipId={open.clipId} /> : null;
}

/** What the notes-to-be look like: listening, ready (with the plan) or a problem. */
type PlanState = { phase: 'listening' } | { phase: 'ready'; transcription: Transcription } | { phase: 'error'; message: string };

/** A finished plan and the settings (as text) it was made for: it counts only while the settings are still those. */
type Planned = { key: string; state: Exclude<PlanState, { phase: 'listening' }> };

/** The audition's state: nothing yet, rendering, ready (with the files) or a problem. */
type AuditionState = { phase: 'none' | 'rendering' } | { phase: 'ready'; files: Audition; playing?: AuditionSide } | { phase: 'error'; message: string };

/** The "Convert to MIDI" dialog: pick what to read, see the notes it finds, hear them against the audio, then convert. */
function ConvertDialog({ clipId }: { clipId: ClipId }) {
  const s = useServices();
  const project = useStore(s.doc, (st) => st.project);
  const [form, setForm] = useState<DialogState>(() => initialState());
  const [suggestion, setSuggestion] = useState<ModeSuggestion | null>(null);
  const [planned, setPlanned] = useState<Planned | null>(null);
  const [audition, setAudition] = useState<AuditionState>({ phase: 'none' });
  const ref = useRef<HTMLDivElement>(null);
  const clip = project.playlist.clips[clipId];
  const channel = clip?.kind === 'audio' ? project.channels[clip.channelId] : undefined;
  const problem = sourceProblem(project, clipId);
  // The settings as text: the effects below run again only when a setting that changes the notes changes.
  const settingsKey = JSON.stringify(settingsOf(form));
  const plan: PlanState = planned && planned.key === settingsKey ? planned.state : { phase: 'listening' };
  const fields = fieldsFor(form.mode, form);
  const channels = instrumentChannels(project);

  const edit = (patch: Partial<DialogState>) => {
    s.engine.stopPreview();
    setAudition({ phase: 'none' });
    setForm((f) => ({ ...f, ...patch }));
  };

  useEffect(() => {
    const release = holdModal();
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      s.engine.stopPreview();
      closeConvertDialog();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      s.engine.stopPreview();
      release();
    };
  }, [s]);

  // The mode the sound suggests, as soon as it is known (unless the musician already chose one).
  useEffect(() => {
    if (problem) return;
    let live = true;
    suggestForClip(s, clipId)
      .then((found) => {
        if (!live) return;
        setSuggestion(found);
        setForm((f) => (f.modeIsSuggested ? { ...f, mode: found.mode } : f));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [s, clipId, problem]);

  // The notes the settings give: listening happens once per mode and sensitivity, planning again is quick.
  useEffect(() => {
    if (problem) return;
    let live = true;
    const timer = setTimeout(() => {
      planClip(s, clipId, JSON.parse(settingsKey) as TranscribeSettings)
        .then((made) => live && setPlanned({ key: settingsKey, state: { phase: 'ready', transcription: made.transcription } }))
        .catch((e: unknown) => live && setPlanned({ key: settingsKey, state: { phase: 'error', message: problemText(e) } }));
    }, PLAN_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [s, clipId, settingsKey, problem]);

  if (!clip || clip.kind !== 'audio') return null;
  const request = specOf(clipId, form);
  const ready = plan.phase === 'ready' && plan.transcription.notes.length > 0;
  const barTicks = ticksPerBar(project.transport.timeSig);

  const hear = async (side: AuditionSide) => {
    if ('problem' in request) return;
    let files = audition.phase === 'ready' ? audition.files : undefined;
    if (!files) {
      setAudition({ phase: 'rendering' });
      try {
        files = await buildAudition(s, request);
      } catch (e) {
        setAudition({ phase: 'error', message: problemText(e) });
        return;
      }
    }
    setAudition({ phase: 'ready', files, playing: side });
    await playAudition(s, files, side);
  };
  const stop = () => {
    s.engine.stopPreview();
    if (audition.phase === 'ready') setAudition({ phase: 'ready', files: audition.files });
  };
  const convert = () => {
    if ('problem' in request) return;
    s.engine.stopPreview();
    closeConvertDialog();
    void runConvert(s, request);
  };

  const playing = audition.phase === 'ready' ? audition.playing : undefined;
  const swingFound = plan.phase === 'ready' ? plan.transcription.swingFound : null;
  const instruments = s.plugins.list('instrument').map((entry) => ({ value: entry.def.id, label: entry.def.name }));

  return (
    <div className={dialog.backdrop} onPointerDown={(e) => e.target === e.currentTarget && closeConvertDialog()}>
      <div ref={ref} tabIndex={-1} className={`${dialog.dialog} ${styles.dialog}`} role="dialog" aria-modal="true" aria-labelledby="ag-convert-title">
        <h2 id="ag-convert-title" className={dialog.title}>
          Convert to MIDI
        </h2>
        <p className={styles.lead}>
          From “{channel?.name ?? 'this clip'}”: the notes are found in the audio you hear (the clip’s trim, tempo and pitch included) and written as a new pattern. The audio is not changed, and one Undo takes it all away.
        </p>
        {problem && <p className={styles.warning}>{problem}</p>}
        <fieldset className={styles.group}>
          <legend>What is in it</legend>
          <div className={styles.modes} role="radiogroup" aria-label="What to read from the audio">
            {TRANSCRIBE_MODES.map((mode: TranscribeMode) => (
              <button key={mode} type="button" role="radio" aria-checked={form.mode === mode} className={`${styles.mode} ${form.mode === mode ? styles.lit : ''}`} data-hint={MODE_LABELS[mode].hint} onClick={() => edit({ mode, modeIsSuggested: false })}>
                <strong>{MODE_LABELS[mode].label}</strong>
                {suggestion?.mode === mode && <em>Suggested</em>}
              </button>
            ))}
          </div>
          <p className={styles.note}>{suggestion ? suggestion.reason : problem ? '' : 'Listening to find what fits…'}</p>
        </fieldset>
        <fieldset className={styles.group}>
          <legend>Where the notes go</legend>
          <div className={styles.row}>
            <SelectField
              label="Channel"
              value={form.target.kind === 'new' ? 'new' : form.target.channel}
              hint="A new channel with an instrument that fits, or an instrument channel that already exists (its notes in this pattern are the new ones)"
              options={[{ value: 'new', label: 'A new channel' }, ...channels.map((c) => ({ value: c.id, label: c.name }))]}
              onChange={(value) => edit({ target: value === 'new' ? { kind: 'new', plugin: '' } : { kind: 'channel', channel: value as never } })}
            />
            {form.target.kind === 'new' && (
              <SelectField
                label="Instrument"
                value={form.target.plugin}
                hint="The instrument the new channel starts with: Drum Pads for drums, a pluck for a melody, FM keys for chords, a plain synth for a bass"
                options={[{ value: '', label: `${SUGGESTED_INSTRUMENT[form.mode].label} (suggested)`, hint: SUGGESTED_INSTRUMENT[form.mode].why }, ...instruments]}
                onChange={(plugin) => edit({ target: { kind: 'new', plugin } })}
              />
            )}
          </div>
          <div className={styles.checks}>
            <CheckField label="Place it on the playlist" checked={form.place} hint="Adds a pattern clip under the audio clip, at the same place and length, so it plays with the song" onChange={(place) => edit({ place })} />
            <CheckField label="Mute the original audio" checked={form.muteOriginal} hint="Mutes the audio clip so only the new notes play (turn it back on from the clip's menu)" onChange={(muteOriginal) => edit({ muteOriginal })} />
            {fields.pads && <CheckField label="Use the hits from this recording" checked={form.slicePads} hint="Cuts the kick, snare, hats… out of the recording onto the Drum Pads, so the notes sound like the original kit" onChange={(slicePads) => edit({ slicePads })} />}
            {fields.chords && <CheckField label="Fill the chord track" checked={form.fillChordTrack} hint="Also puts the chords it finds on the song's chord track (the chord lane above the playlist)" onChange={(fillChordTrack) => edit({ fillChordTrack })} />}
          </div>
        </fieldset>
        <fieldset className={styles.group}>
          <legend>How it is read</legend>
          <div className={styles.grid}>
            {fields.sensitivity && <SliderField label="Sensitivity" unit="%" value={form.sensitivity} min={0} max={100} step={5} hint="How much is picked up: higher finds quieter and shorter sounds (and more mistakes), lower only the clear ones (0–100 %)" onChange={(sensitivity) => edit({ sensitivity })} />}
            <SelectField label="Snap to" value={form.gridId} hint="The grid the note starts and ends are pulled to: 1/16 is one step of the step sequencer" options={GRID_CHOICES.map((g) => ({ value: g.id, label: g.label }))} onChange={(gridId) => edit({ gridId })} />
            <SliderField label="Quantize strength" unit="%" value={form.strength} min={0} max={100} step={5} hint="How far each time moves to its grid line: 100 puts it on the line, 0 leaves it as played (0–100 %)" onChange={(strength) => edit({ strength })} />
            <SelectField
              label="Swing"
              value={form.swing}
              hint="Straighten puts the notes on straight grid lines (the song's own swing setting still applies); Keep writes the recording's own swing into the notes"
              options={[{ value: 'straighten', label: 'Straighten it' }, { value: 'keep', label: swingFound !== null && swingFound >= 0.05 ? `Keep the feel (found ${Math.round(swingFound * 100)} %)` : 'Keep the feel' }]}
              onChange={(swing) => edit({ swing: swing as DialogState['swing'] })}
            />
            {fields.noteEnds && <SelectField label="Note ends" value={form.articulation} hint="How notes end: as played, legato (short gaps closed so notes run together) or staccato (cut to half)" options={ARTICULATIONS.map((a) => ({ value: a.id, label: a.label, hint: a.hint }))} onChange={(articulation) => edit({ articulation: articulation as DialogState['articulation'] })} />}
            {fields.noteEnds && form.articulation === 'legato' && <SliderField label="Legato gap" unit=" ms" value={form.legatoGapMs} min={20} max={500} step={10} hint="Gaps shorter than this are closed (20–500 ms)" onChange={(legatoGapMs) => edit({ legatoGapMs })} />}
            {fields.chords && <SelectField label="Look at" value={form.chordResolution} hint="How often the chord is read: every beat, half bar or bar (changes inside it are missed)" options={CHORD_RESOLUTIONS.map((c) => ({ value: c.id, label: c.label }))} onChange={(chordResolution) => edit({ chordResolution: chordResolution as DialogState['chordResolution'] })} />}
            {fields.chords && <SelectField label="Play chords" value={form.chordRhythm} hint="How the chords are written as notes: held, on the beats, on the off-beats or every eighth" options={RHYTHMS.map((r) => ({ value: r, label: RHYTHM_LABELS[r] }))} onChange={(chordRhythm) => edit({ chordRhythm: chordRhythm as DialogState['chordRhythm'] })} />}
          </div>
          {fields.noteEnds && <CheckField label="Keep the cents" checked={form.keepCents} hint="Writes how far each note was from its semitone as the note's fine pitch (otherwise notes are whole semitones)" onChange={(keepCents) => edit({ keepCents })} />}
          {fields.chords && <CheckField label="Add the root as a low note" checked={form.chordBass} hint="Adds the chord's root as a bass note under each chord" onChange={(chordBass) => edit({ chordBass })} />}
        </fieldset>
        <fieldset className={styles.group}>
          <legend>What it finds</legend>
          {plan.phase === 'listening' && !problem && <p className={styles.note}>Listening…</p>}
          {plan.phase === 'error' && <p className={styles.warning}>{plan.message}</p>}
          {plan.phase === 'ready' && (
            <>
              {plan.transcription.summary.map((line) => (
                <p key={line} className={styles.note}>
                  {line}
                </p>
              ))}
              {plan.transcription.notes.length > 0 && <MiniRoll notes={plan.transcription.notes} lengthTicks={Math.max(1, (clip as AudioClip).length)} barTicks={barTicks} />}
            </>
          )}
        </fieldset>
        <fieldset className={styles.group}>
          <legend>Hear it first (the first {AUDITION_SECONDS} seconds)</legend>
          <div className={styles.preview}>
            <button type="button" className={`${styles.chip} ${playing === 'audio' ? styles.lit : ''}`} disabled={!ready || audition.phase === 'rendering'} onClick={() => void hear('audio')} data-hint="A: plays the audio alone, as the clip sounds now">
              A · Audio
            </button>
            <button type="button" className={`${styles.chip} ${playing === 'midi' ? styles.lit : ''}`} disabled={!ready || audition.phase === 'rendering'} onClick={() => void hear('midi')} data-hint="B: plays the new notes alone, through the instrument they will have">
              B · MIDI
            </button>
            <button type="button" className={`${styles.chip} ${playing === 'both' ? styles.lit : ''}`} disabled={!ready || audition.phase === 'rendering'} onClick={() => void hear('both')} data-hint="A + B: plays the audio and the notes together, to hear whether they line up">
              A + B
            </button>
            <button type="button" className={styles.chip} onClick={stop} data-hint="Stops the preview">
              Stop
            </button>
            <span className={styles.status} aria-live="polite">
              {audition.phase === 'none' && (ready ? 'A is the audio, B the notes, A + B both together. Change anything above to hear it again.' : '')}
              {audition.phase === 'rendering' && 'Rendering the notes…'}
              {audition.phase === 'ready' && 'Playing. Change anything above to hear it again.'}
              {audition.phase === 'error' && audition.message}
            </span>
          </div>
        </fieldset>
        <details className={styles.help}>
          <summary data-hint="What each choice does and what this can and cannot read">How this works</summary>
          <ul>
            <li>
              <strong>Melody</strong> follows one note at a time (a voice, a lead). <strong>Drums</strong> finds kick, snare, clap, hats, toms and cymbals, even when a hat is over a kick.
              <strong> Chords</strong> reads a chord for every beat from the sound. <strong>Bassline</strong> follows the lowest line of a mixed loop and leaves the drums out.
            </li>
            <li>The notes land where the audio plays: the clip’s trim, its tempo follow and its pitch are all counted, so what you convert is what you hear.</li>
            <li>Snap pulls note starts and ends to the grid. Strength below 100 % keeps some of the human timing; Keep the feel writes the recording’s own swing into the notes.</li>
            <li>With Drums on a new channel the kick, snare, hats… are cut from your recording onto Drum Pads, so the notes sound like the original kit.</li>
            <li>Chords and basslines of a full mix are a good guess, not a transcript: check them in the piano roll. One Undo removes everything this makes.</li>
          </ul>
        </details>
        <div className={dialog.buttons}>
          <button className={dialog.button} onClick={() => { s.engine.stopPreview(); closeConvertDialog(); }} data-hint="Close without making anything">
            Cancel
          </button>
          <button className={`${dialog.button} ${dialog.primary}`} disabled={'problem' in request || !ready} onClick={convert} data-hint="Write the notes as a new pattern (one undo step)">
            Convert
          </button>
        </div>
      </div>
    </div>
  );
}
