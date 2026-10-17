import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import {
  audioClipOf,
  clearClipPitch,
  defaultPitchClip,
  editFor,
  loadPitchClip,
  mergeAt,
  moveNotes,
  renderNow,
  resetNotes,
  setNoteSettings,
  setTransition,
  snapClip,
  splitAt,
} from '@app/actions/pitch';
import { pitchState } from '@app/pitch/state';
import { DEFAULT_TRANSITION_MS, editSignature, isNeutralEdit } from '@core/audio/pitch-edit';
import { PITCH_NAMES, SCALES } from '@agstudio/sdk/notes';
import { showContextMenu, type MenuEntry } from '../../controls/ContextMenu';
import { Icon } from '../../controls/Icon';
import { useDoc, useEngineStatus, useServices } from '../../services-context';
import { PitchEditorController, KEYS_WIDTH, RULER_HEIGHT, type PitchEditorElements, type PitchTool } from './controller';
import styles from './PitchEditor.module.css';

const pct = (v: number) => `${Math.round(v * 100)} %`;

function Toolbar({ controller, tool, setTool }: { controller: React.RefObject<PitchEditorController | null>; tool: PitchTool; setTool: (t: PitchTool) => void }) {
  const services = useServices();
  const st = useStore(pitchState, (s) => s);
  const songKey = useDoc((p) => p.transport.key);
  const { playing } = useEngineStatus();
  const clipId = st.clipId;
  const edit = useDoc((p) => (clipId ? audioClipOf(p, clipId)?.clip.pitchEdit : undefined));
  const noteCount = st.clip ? editFor(services.doc.getState().project, st.clip).notes.length : 0;
  const [snapDrag, setSnapDrag] = useState(false);
  const [showScale, setShowScale] = useState(true);
  const keepFocus = (e: React.PointerEvent) => e.preventDefault();
  const sel = st.selected;
  const clip = st.clip;
  const which: ReadonlySet<number> | 'all' = sel.length > 0 ? new Set(sel) : 'all';
  const target = (sel.length > 0 ? sel : edit?.notes.map((_, i) => i) ?? clip?.analysis.notes.map((_, i) => i) ?? [])[0];
  const first = edit?.notes[target ?? 0];
  const drift = first?.drift ?? 0;
  const vibrato = first?.vibrato ?? 1;
  const transition = edit?.transition ?? DEFAULT_TRANSITION_MS;
  const ready = st.phase === 'ready' && !!clip && noteCount > 0;
  const scope = sel.length > 0 ? (sel.length === 1 ? 'the selected note' : `the ${sel.length} selected notes`) : 'all notes';
  const keyLabel = `${PITCH_NAMES[st.keyRoot] ?? 'C'} ${SCALES.find((s) => s.id === st.keyScale)?.label.toLowerCase() ?? st.keyScale}`;

  const status = (() => {
    if (st.phase === 'analyzing') return 'Listening to the clip…';
    if (st.phase !== 'ready') return '';
    if (st.rendering && st.rendering.clipId === clipId) return `Rendering corrected audio ${Math.round(st.rendering.fraction * 100)} %…`;
    if (edit && !isNeutralEdit(edit)) {
      if (edit.renderedSampleId && edit.renderedFor === editSignature(edit)) return 'Corrected audio ready: the clip plays it';
      return 'Corrected audio is being made…';
    }
    return noteCount ? `${noteCount} note${noteCount === 1 ? '' : 's'} found: nothing corrected yet` : '';
  })();
  const needsRender = !!edit && !isNeutralEdit(edit) && !(edit.renderedSampleId && edit.renderedFor === editSignature(edit)) && !st.rendering && st.phase === 'ready';

  const more = (e: React.MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const items: MenuEntry[] = [
      { label: 'Merge selected note with the next', hint: 'Joins a note and the one after it into one (M)', disabled: !ready || sel.length === 0, onSelect: () => clip && mergeAt(services, clip, sel[0] as number) },
      { label: 'Reset selected notes', hint: 'Puts the selected notes (or all of them when none is selected) back as sung (Delete)', disabled: !ready, onSelect: () => clip && resetNotes(services, clip, which) },
      { kind: 'separator' },
      { label: 'Render the corrected audio now', hint: 'Makes the corrected audio again (it normally follows every change by itself)', disabled: !edit || isNeutralEdit(edit), onSelect: () => clipId && renderNow(clipId) },
      { label: 'Remove all pitch correction', hint: 'The clip plays its own audio again (one undo step)', danger: true, disabled: !edit, onSelect: () => clipId && clearClipPitch(services, clipId) },
    ];
    showContextMenu({ x: r.left, y: r.bottom + 2 }, items);
  };

  return (
    <div className={styles.toolbar}>
      <button
        type="button"
        tabIndex={-1}
        className={`${styles.tool} ${styles.play} ${playing ? styles.toolOn : ''}`}
        disabled={!clip}
        onPointerDown={keepFocus}
        onClick={() => services.commands.run(playing ? 'transport.stop' : 'pitchEditor.play')}
        data-hint={playing ? 'Stop playing' : 'Play the clip from the selected note (or its start) with the correction'}
        aria-label={playing ? 'Stop' : 'Play'}
      >
        <Icon name={playing ? 'stop' : 'play'} size={14} />
      </button>
      <div className={styles.tools} role="toolbar">
        <button type="button" tabIndex={-1} className={`${styles.tool} ${tool === 'select' ? styles.toolOn : ''}`} onPointerDown={keepFocus} onClick={() => setTool('select')} data-hint="Select: click a note, drag it up or down to retune it (snaps to semitones; hold Alt to move by cents), drag empty space to select several">
          Select
        </button>
        <button type="button" tabIndex={-1} className={`${styles.tool} ${tool === 'split' ? styles.toolOn : ''}`} onPointerDown={keepFocus} onClick={() => setTool('split')} data-hint="Split: click on a note to cut it in two there (or press S over a note). Merge them again with M">
          Split
        </button>
      </div>
      <span className={styles.group}>
        <label className={styles.field} data-hint="The key notes are pulled to: pick the tonic and the scale (starts as the song's key)">
          Key
          <select value={st.keyRoot} onChange={(e) => pitchState.setState({ keyRoot: Number(e.target.value), keyFollowsSong: false })}>
            {PITCH_NAMES.map((n, i) => (
              <option key={n} value={i}>
                {n}
              </option>
            ))}
          </select>
          <select value={st.keyScale} onChange={(e) => pitchState.setState({ keyScale: e.target.value, keyFollowsSong: false })} aria-label="Scale">
            {SCALES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        {songKey && !st.keyFollowsSong ? (
          <button type="button" tabIndex={-1} className={styles.tool} onPointerDown={keepFocus} onClick={() => pitchState.setState({ keyRoot: songKey.root, keyScale: songKey.scale, keyFollowsSong: true })} data-hint="Use the song's key again">
            Song key
          </button>
        ) : null}
      </span>
      <label className={styles.field} data-hint="How far Snap pulls each note towards the key: 100 % puts it exactly on the nearest note of the key, 50 % goes half way (keeps some of the human feel)">
        Strength
        <input type="range" min={0} max={100} step={1} value={Math.round(st.strength * 100)} onChange={(e) => pitchState.setState({ strength: Number(e.target.value) / 100 })} />
        <span className={styles.value}>{pct(st.strength)}</span>
      </label>
      <button
        type="button"
        tabIndex={-1}
        className={styles.tool}
        disabled={!ready}
        onPointerDown={keepFocus}
        onClick={() => clip && snapClip(services, clip, { root: st.keyRoot, scale: st.keyScale }, st.strength, which)}
        data-hint={`Snap ${scope} to ${keyLabel} at ${pct(st.strength)} (one undo step)`}
      >
        {sel.length > 0 ? 'Snap selected to key' : 'Snap all to key'}
      </button>
      <button
        type="button"
        tabIndex={-1}
        className={`${styles.tool} ${snapDrag ? styles.toolOn : ''}`}
        aria-pressed={snapDrag}
        onPointerDown={keepFocus}
        onClick={() => {
          const v = !snapDrag;
          setSnapDrag(v);
          controller.current?.setSnapToScale(v);
        }}
        data-hint={`Snap drags to key ${snapDrag ? 'on' : 'off'}: dragged notes land on the notes of ${keyLabel} instead of every semitone`}
      >
        Drag in key
      </button>
      <button
        type="button"
        tabIndex={-1}
        className={`${styles.tool} ${showScale ? styles.toolOn : ''}`}
        aria-pressed={showScale}
        onPointerDown={keepFocus}
        onClick={() => {
          const v = !showScale;
          setShowScale(v);
          controller.current?.setShowScale(v);
        }}
        data-hint="Shade the rows that are outside the chosen key"
      >
        Show key
      </button>
      <span className={styles.sep} />
      <label className={styles.field} data-hint={`Flatten drift (${scope}): takes out slow wandering of the pitch within a note, in %. 100 % makes the line dead straight (a robotic sound); 0 leaves it as sung`}>
        Drift
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          disabled={!ready}
          value={Math.round(drift * 100)}
          onChange={(e) => clip && setNoteSettings(services, clip, which, { drift: Number(e.target.value) / 100 }, 'Flatten drift', `pitch-drift:${clip.clipId}`)}
        />
        <span className={styles.value}>{pct(drift)}</span>
      </label>
      <label className={styles.field} data-hint={`Vibrato (${scope}): how much of the singer's vibrato is kept, in %. 0 removes it, 100 leaves it as sung, 200 doubles it`}>
        Vibrato
        <input
          type="range"
          min={0}
          max={200}
          step={1}
          disabled={!ready}
          value={Math.round(vibrato * 100)}
          onChange={(e) => clip && setNoteSettings(services, clip, which, { vibrato: Number(e.target.value) / 100 }, 'Vibrato amount', `pitch-vibrato:${clip.clipId}`)}
        />
        <span className={styles.value}>{pct(vibrato)}</span>
      </label>
      <label className={styles.field} data-hint="Transition speed: how long a pitch move takes to glide in at the start of a note, in ms. 0 jumps at once (the hard-tune sound), 25 ms is natural, 100 ms or more is a slow slide">
        Transition
        <input
          type="range"
          min={0}
          max={300}
          step={5}
          disabled={!ready}
          value={transition}
          onChange={(e) => clip && setTransition(services, clip, Number(e.target.value), `pitch-transition:${clip.clipId}`)}
        />
        <span className={styles.value}>{transition} ms</span>
      </label>
      <button type="button" tabIndex={-1} className={styles.tool} disabled={!ready} onPointerDown={keepFocus} onClick={(e) => more(e)} data-hint="More: merge notes, reset notes, render again, remove all correction">
        More ▾
      </button>
      <span className={styles.zoom}>
        <button type="button" tabIndex={-1} onPointerDown={keepFocus} onClick={() => controller.current?.zoomBy(1 / 1.4)} data-hint="Zoom out (or Ctrl/Cmd + wheel)">
          −
        </button>
        <button type="button" tabIndex={-1} onPointerDown={keepFocus} onClick={() => controller.current?.zoomBy(1.4)} data-hint="Zoom in (or Ctrl/Cmd + wheel)">
          +
        </button>
        <button type="button" tabIndex={-1} onPointerDown={keepFocus} onClick={() => controller.current?.fit()} data-hint="Fit the whole clip in the window">
          Fit
        </button>
      </span>
      <span className={styles.status} data-hint="What the clip plays: the corrected audio is made in the background after each change and replaces the clip's sound; your original recording stays untouched">
        {status}
        {needsRender ? (
          <button type="button" tabIndex={-1} className={styles.link} onClick={() => clipId && renderNow(clipId)}>
            Render now
          </button>
        ) : null}
      </span>
    </div>
  );
}

export function PitchEditor() {
  const services = useServices();
  const clipIdNow = useStore(pitchState, (s) => s.clipId);
  const phase = useStore(pitchState, (s) => s.phase);
  const errorText = useStore(pitchState, (s) => s.message);
  const hasNotes = useStore(pitchState, (s) => (s.clip?.analysis.notes.length ?? 0) > 0);
  const [tool, setTool] = useState<PitchTool>('select');
  const controller = useRef<PitchEditorController | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const ruler = useRef<HTMLCanvasElement>(null);
  const keys = useRef<HTMLCanvasElement>(null);
  const grid = useRef<HTMLCanvasElement>(null);
  const content = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const hscroll = useRef<HTMLDivElement>(null);
  const hthumb = useRef<HTMLDivElement>(null);
  const trim = useDoc((p) => {
    const id = pitchState.getState().clipId;
    const found = id ? audioClipOf(p, id) : null;
    return found ? `${found.clip.offsetSec}|${found.clip.length}|${found.channel.pitch ?? 0}|${found.channel.reverse ? 1 : 0}|${found.channel.stretch ?? ''}|${found.channel.sourceBpm ?? 0}|${found.channel.sampleId}` : '';
  });

  // Opens on the selected audio clip when nothing was chosen yet.
  useEffect(() => {
    const current = pitchState.getState();
    const id = current.clipId ?? defaultPitchClip(services);
    if (id && (current.clipId !== id || current.phase === 'none')) void loadPitchClip(services, id);
  }, [services]);
  // A trim, a tempo or channel change moves what the clip plays: look again (cached when it is the same part).
  useEffect(() => {
    const id = pitchState.getState().clipId;
    if (id && trim) void loadPitchClip(services, id);
  }, [services, trim]);

  useEffect(() => {
    const els = {
      area: area.current,
      stage: stage.current,
      ruler: ruler.current,
      keys: keys.current,
      grid: grid.current,
      content: content.current,
      overlay: overlay.current,
      hscroll: hscroll.current,
      hthumb: hthumb.current,
    };
    if (Object.values(els).some((el) => !el)) return;
    const c = new PitchEditorController(services, els as PitchEditorElements);
    c.onMenu = (index, ms, at) => {
      const clip = pitchState.getState().clip;
      if (!clip) return;
      const sel = pitchState.getState().selected;
      const which: ReadonlySet<number> | 'all' = sel.length ? new Set(sel) : index >= 0 ? new Set([index]) : 'all';
      const st2 = pitchState.getState();
      const items: MenuEntry[] =
        index >= 0
          ? [
              { label: 'Split here', shortcut: 'S', hint: 'Cuts the note in two where you clicked', onSelect: () => splitAt(services, clip, ms / 1000) },
              { label: 'Merge with the next note', shortcut: 'M', hint: 'Joins this note and the one after it', onSelect: () => mergeAt(services, clip, index) },
              { kind: 'separator' },
              { label: 'Snap to key', hint: 'Moves the note to the nearest note of the chosen key (at the Strength set in the toolbar)', onSelect: () => snapClip(services, clip, { root: st2.keyRoot, scale: st2.keyScale }, st2.strength, which) },
              { label: 'Up a semitone', shortcut: '↑', onSelect: () => moveNotes(services, clip, sel.length ? sel : [index], 1) },
              { label: 'Down a semitone', shortcut: '↓', onSelect: () => moveNotes(services, clip, sel.length ? sel : [index], -1) },
              { label: 'Up an octave', onSelect: () => moveNotes(services, clip, sel.length ? sel : [index], 12) },
              { label: 'Down an octave', onSelect: () => moveNotes(services, clip, sel.length ? sel : [index], -12) },
              { kind: 'separator' },
              { label: 'Flatten drift', hint: 'Takes the slow wandering out of the note’s pitch', onSelect: () => setNoteSettings(services, clip, which, { drift: 1 }, 'Flatten drift') },
              { label: 'Remove vibrato', hint: 'Takes the wobble out of the note', onSelect: () => setNoteSettings(services, clip, which, { vibrato: 0 }, 'Remove vibrato') },
              { label: 'Reset note', shortcut: 'Del', hint: 'Puts the note back as it was sung', onSelect: () => resetNotes(services, clip, which) },
            ]
          : [
              { label: 'Snap all to key', hint: 'Moves every note to the nearest note of the chosen key', onSelect: () => snapClip(services, clip, { root: st2.keyRoot, scale: st2.keyScale }, st2.strength) },
              { label: 'Reset all notes', onSelect: () => resetNotes(services, clip, 'all') },
            ];
      showContextMenu(at, items);
    };
    controller.current = c;
    c.mount();
    return () => {
      c.unmount();
      controller.current = null;
    };
  }, [services]);

  useEffect(() => {
    if (controller.current) controller.current.tool = tool;
  }, [tool]);

  const message = useMemo(() => {
    if (!clipIdNow && phase === 'none')
      return 'No clip chosen yet. Select an audio clip in the playlist, then right-click it and choose “Pitch editor…” (or Alt + double-click the clip).';
    if (phase === 'error') return errorText;
    if (phase === 'analyzing') return 'Listening to the clip to find its notes…';
    if (phase === 'ready' && !hasNotes)
      return 'No sung notes found in this clip. Pitch correction works on one voice or melody line at a time (not chords or drums): try a clip of a vocal.';
    return '';
  }, [clipIdNow, phase, errorText, hasNotes]);

  return (
    <div className={styles.root}>
      <Toolbar controller={controller} tool={tool} setTool={setTool} />
      <div
        ref={area}
        className={styles.area}
        tabIndex={0}
        style={{ gridTemplateColumns: `${KEYS_WIDTH}px 1fr`, gridTemplateRows: `${RULER_HEIGHT}px 1fr 12px` }}
      >
        <div className={styles.corner} />
        <canvas ref={ruler} className={styles.ruler} data-hint="Time in the clip's recording (minutes:seconds)" />
        <canvas ref={keys} className={styles.keys} data-hint="Notes: the rows are semitones; rows of the chosen key are marked" />
        <div ref={stage} className={styles.stage} data-hint="The notes found in the recording: blobs on a piano grid, the thin line is the pitch as sung, the bright line is the corrected pitch. Drag a blob up or down to retune it">
          <canvas ref={grid} className={styles.layer} />
          <canvas ref={content} className={styles.layer} />
          <canvas ref={overlay} className={styles.layer} />
          {message ? <div className={phase === 'error' || !clipIdNow ? styles.empty : styles.emptyHint}>{message}</div> : null}
        </div>
        <div className={styles.corner} />
        <div ref={hscroll} className={styles.hscroll}>
          <div ref={hthumb} className={styles.hthumb} />
        </div>
      </div>
    </div>
  );
}
