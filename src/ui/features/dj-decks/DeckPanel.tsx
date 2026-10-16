import { useEffect, useRef, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { library, loadLibrary, pickSongFiles } from '@app/dj/library';
import type { DeckId, DecksApi } from '@app/dj/decks-api';
import { AUTO_LOOP_BEATS, formatPitch, loopBeats, loopBeatsLabel, PITCH_RANGES } from '@core/dj/decks-math';
import { onFrame } from '../../frame-loop';
import { showContextMenu, type MenuEntry } from '../../controls/ContextMenu';
import { Icon } from '../../controls/Icon';
import { useServices } from '../../services-context';
import { keyBadge } from '../dj/dj-view';
import { deckTarget, PadButton, Slider } from './controls';
import styles from './DjDecks.module.css';
import { loadToDeck, SONG_DRAG_TYPE } from './load';
import { DeckScope, HOT_CUE_VARS } from './scope';
import { useDeck } from './use-decks';
import { formatDeckTime } from '@core/dj/decks-math';

const BEAT_JUMPS = [1, 2, 4, 8, 16, 32] as const;

/** Where on the platter a drag starts: the outer ring nudges the tempo, the rest scratches. */
const RIM = 0.78;

export function DeckPanel({ api, id }: { api: DecksApi; id: DeckId }) {
  const services = useServices();
  const d = useDeck(api, id);
  const zoom = useRef<HTMLCanvasElement>(null);
  const overview = useRef<HTMLCanvasElement>(null);
  const platter = useRef<HTMLDivElement>(null);
  const time = useRef<HTMLSpanElement>(null);
  const remaining = useRef<HTMLSpanElement>(null);

  // The waveforms, the platter and the clock are drawn on the frame loop, only while this panel exists.
  useEffect(() => {
    if (!zoom.current || !overview.current) return;
    const scope = new DeckScope(api, id, {
      zoom: zoom.current,
      overview: overview.current,
      platter: platter.current,
      time: time.current,
      remaining: remaining.current,
    });
    return onFrame(() => scope.frame());
  }, [api, id]);

  const has = d.song !== null;
  const analysis = api.analysisOf?.(id) ?? null;
  const badge = keyBadge(analysis);
  const grid = analysis?.grid ?? null;
  const beatsOfLoop = d.loop && d.loop.endSec > d.loop.startSec ? loopBeats(d.loop, { bpm: d.baseBpm ?? 120, firstDownbeat: 0 }) : 0;

  // ---- Platter: drag to scratch, outer ring to nudge ----
  const jog = useRef<{ angle: number; mode: 'scratch' | 'nudge' } | null>(null);
  const angleOf = (e: ReactPointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2));
  };
  const onPlatterDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!has || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const r = e.currentTarget.getBoundingClientRect();
    const dist = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)) / (r.width / 2);
    const mode = dist >= RIM ? 'nudge' : 'scratch';
    jog.current = { angle: angleOf(e), mode };
    if (mode === 'scratch') api.jogTouch(id, true);
  };
  const onPlatterMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const j = jog.current;
    if (!j) return;
    const a = angleOf(e);
    let delta = a - j.angle;
    if (delta > Math.PI) delta -= 2 * Math.PI;
    if (delta < -Math.PI) delta += 2 * Math.PI;
    j.angle = a;
    api.jog(id, delta / (2 * Math.PI), j.mode);
  };
  const onPlatterUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const j = jog.current;
    if (!j) return;
    jog.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (j.mode === 'scratch') api.jogTouch(id, false);
  };

  // ---- Seeking on the overview ----
  const seekOverview = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!d.song) return;
    const r = e.currentTarget.getBoundingClientRect();
    api.seek(id, Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * d.song.durationSec);
  };
  const overviewDrag = useRef(false);

  // ---- Loading by drag and drop ----
  const onDragOver = (e: DragEvent) => {
    if (e.dataTransfer.types.includes(SONG_DRAG_TYPE)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
  };
  const onDrop = (e: DragEvent) => {
    const key = e.dataTransfer.getData(SONG_DRAG_TYPE);
    if (!key) return;
    e.preventDefault();
    const song = library.getState().songs.find((x) => x.key === key);
    if (song) void loadToDeck(services, song, id);
  };

  const hotCueMenu = (e: React.MouseEvent, i: number) => {
    e.preventDefault();
    if (d.hotCues[i] === null) return;
    showContextMenu(e, [{ label: `Clear hot cue ${i + 1}`, onSelect: () => api.clearHotCue(id, i) }]);
  };

  const openLoadMenu = async (e: React.MouseEvent<HTMLElement>) => {
    const at = e.currentTarget.getBoundingClientRect();
    await loadLibrary();
    const songs = library.getState().songs;
    const items: MenuEntry[] =
      songs.length === 0
        ? [{ label: 'Add music files…', hint: 'Your music library is empty: add some song files to play', onSelect: () => void pickSongFiles(services) }]
        : songs.slice(0, 80).map((x) => ({ label: x.label, hint: `Put “${x.label}” on deck ${id}`, onSelect: () => void loadToDeck(services, x, id) }));
    showContextMenu({ x: at.left, y: at.bottom + 4 }, items);
  };

  const range = d.pitchRange;
  return (
    <section className={styles.deck} data-deck={id} onDragOver={onDragOver} onDrop={onDrop} aria-label={`Deck ${id}`}>
      <header className={styles.deckHead}>
        <span className={styles.letter} data-hint={`Deck ${id}`}>
          {id}
        </span>
        <div className={styles.titles}>
          <b className={styles.songTitle}>{d.song ? d.song.title : `Deck ${id} is empty`}</b>
          <span className={styles.artist}>{d.loading ? 'Loading and analyzing…' : (d.song?.artist ?? '')}</span>
        </div>
        <span
          className={styles.lcd}
          data-hint={d.bpm === null ? 'Tempo: this song has no steady beat to read' : `Tempo now: ${d.bpm.toFixed(1)} BPM (the song’s own is ${d.baseBpm?.toFixed(1)} BPM)`}
        >
          {d.bpm === null ? '–' : d.bpm.toFixed(1)}
          <small>BPM</small>
        </span>
        <span className={styles.keyBadge} style={badge.color ? { background: badge.color, color: 'var(--ag-on-light)' } : undefined} data-hint={badge.hint}>
          {badge.text}
        </span>
        <button
          type="button"
          tabIndex={-1}
          data-dj-target={deckTarget(id, 'load')}
          className={styles.load}
          aria-label={`Load a song on deck ${id}`}
          data-hint={`Choose a song from your music library to put on deck ${id}`}
          onPointerDown={(e) => e.preventDefault()}
          onClick={(e) => void openLoadMenu(e)}
        >
          Load…
        </button>
        <button
          type="button"
          tabIndex={-1}
          data-dj-target={deckTarget(id, 'eject')}
          className={styles.eject}
          disabled={!has}
          aria-label={`Eject deck ${id}`}
          data-hint={`Take the song off deck ${id} (stops it)`}
          onClick={() => api.eject(id)}
        >
          <Icon name="close" size={11} />
        </button>
      </header>

      <div className={styles.scopes}>
        <canvas ref={zoom} className={styles.zoom} aria-hidden />
        {!has && (
          <div className={styles.emptyDeck}>
            {d.loading ? (
              'Loading…'
            ) : (
              <>
                <Icon name="note" size={18} />
                <span>Drop a song here, or right-click one in the Music list and choose Load to deck {id}.</span>
              </>
            )}
          </div>
        )}
      </div>
      <canvas
        ref={overview}
        className={styles.overview}
        role="slider"
        aria-label={`Deck ${id} position`}
        aria-valuemin={0}
        aria-valuemax={d.song?.durationSec ?? 0}
        aria-valuenow={0}
        data-hint={`Whole song: click or drag to jump to a place in deck ${id}`}
        onPointerDown={(e) => {
          overviewDrag.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          seekOverview(e);
        }}
        onPointerMove={(e) => overviewDrag.current && seekOverview(e)}
        onPointerUp={(e) => {
          overviewDrag.current = false;
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
      />
      <div className={styles.clock}>
        <span ref={time} className={styles.time} data-hint="Time into the song (minutes:seconds)" />
        <span ref={remaining} className={styles.remaining} data-hint="Time left in the song" />
      </div>

      <div className={styles.transport}>
        <div
          ref={platter}
          data-dj-target={deckTarget(id, 'jog')}
          className={styles.platter}
          role="slider"
          tabIndex={0}
          aria-label={`Deck ${id} platter`}
          aria-valuemin={0}
          aria-valuemax={1}
          aria-valuenow={0}
          data-hint={`Platter: drag to scratch like a record, drag the outer ring to nudge the tempo, scroll to nudge`}
          onPointerDown={onPlatterDown}
          onPointerMove={onPlatterMove}
          onPointerUp={onPlatterUp}
          onPointerCancel={onPlatterUp}
          onWheel={(e) => has && api.jog(id, e.deltaY * -0.002, 'nudge')}
        >
          <i className={styles.platterMark} />
        </div>
        <div className={styles.buttons}>
          <PadButton
            label={`Deck ${id} cue`}
            hint="Cue: paused, sets the cue point here (on the beat) and plays from it while held; playing, goes back to the cue point"
            disabled={!has}
            target={deckTarget(id, 'cue')}
            className={styles.cue}
            onPointerDown={() => api.cueDown(id)}
            onPointerUp={() => api.cueUp(id)}
          >
            CUE
          </PadButton>
          <PadButton
            label={d.playing ? `Pause deck ${id}` : `Play deck ${id}`}
            hint={d.playing ? 'Pause this deck' : 'Play this deck (a synced deck starts on the beat)'}
            on={d.playing}
            disabled={!has}
            target={deckTarget(id, 'play')}
            className={styles.play}
            onClick={() => api.togglePlay(id)}
          >
            <Icon name={d.playing ? 'pause' : 'play'} size={14} />
          </PadButton>
          <PadButton
            label={`Sync deck ${id}`}
            hint={
              grid
                ? 'Sync: match the tempo and the beat of the other deck and stay with it (moving this deck’s pitch lets go)'
                : 'Sync needs a steady beat: this song has none the analysis could find'
            }
            on={d.synced}
            disabled={!has || !grid}
            target={deckTarget(id, 'sync')}
            onClick={() => api.sync(id)}
          >
            SYNC
          </PadButton>
          <PadButton
            label={`Key lock deck ${id}`}
            hint="Key lock: change the tempo without changing the pitch (off, the pitch follows the speed like a record)"
            on={d.keyLock}
            disabled={!has}
            target={deckTarget(id, 'keylock')}
            onClick={() => api.setKeyLock(id, !d.keyLock)}
          >
            KEY LOCK
          </PadButton>
        </div>
        <div className={styles.pitch}>
          <span className={styles.pitchValue} data-hint="Pitch: how much faster (+) or slower (−) than the song's own tempo">
            {formatPitch(d.pitch)}
          </span>
          <Slider
            vertical
            target={deckTarget(id, 'pitch')}
            className={styles.pitchSlider}
            value={d.pitch}
            min={-range}
            max={range}
            reset={0}
            marks={[0]}
            label={`Deck ${id} pitch`}
            hint="Tempo of this deck: up is faster, down is slower."
            format={formatPitch}
            onChange={(v) => api.setPitch(id, v)}
          />
          <div className={styles.rangeRow} role="group" aria-label={`Deck ${id} pitch range`}>
            {PITCH_RANGES.map((r) => (
              <button
                key={r}
                type="button"
                tabIndex={-1}
                className={`${styles.range} ${range === r ? styles.rangeOn : ''}`}
                aria-pressed={range === r}
                data-hint={`Pitch range ±${Math.round(r * 100)}%: how far the pitch fader goes`}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => api.setPitchRange(id, r)}
              >
                {Math.round(r * 100)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className={styles.hotCues} role="group" aria-label={`Deck ${id} hot cues`}>
        {Array.from({ length: 8 }, (_, i) => {
          const at = d.hotCues[i];
          return (
            <PadButton
              key={i}
              label={`Deck ${id} hot cue ${i + 1}`}
              hint={
                at === null || at === undefined
                  ? `Hot cue ${i + 1} (empty): click to set it at the playhead, on the beat`
                  : `Hot cue ${i + 1} at ${formatDeckTime(at)}: click to jump there and play. Right-click to clear it`
              }
              on={at !== null && at !== undefined}
              disabled={!has}
              target={deckTarget(id, `hotcue:${i + 1}`)}
              className={styles.hotCue}
              style={{ '--pad': HOT_CUE_VARS[i] } as React.CSSProperties}
              onClick={() => api.hotCue(id, i)}
              onContextMenu={(e) => hotCueMenu(e, i)}
            >
              {i + 1}
            </PadButton>
          );
        })}
      </div>

      <div className={styles.loops}>
        <PadButton
          label={`Deck ${id} loop in`}
          hint="Loop in: mark where a loop starts (on the beat)"
          disabled={!has}
          target={deckTarget(id, 'loopIn')}
          onClick={() => api.loopIn(id)}
        >
          IN
        </PadButton>
        <PadButton
          label={`Deck ${id} loop out`}
          hint="Loop out: close the loop here and start repeating it; press again to leave, once more to go back into it"
          on={d.loop?.active ?? false}
          disabled={!has}
          target={deckTarget(id, 'loopOut')}
          onClick={() => api.loopOut(id)}
        >
          OUT
        </PadButton>
        <PadButton
          label={`Deck ${id} loop half`}
          hint="Halve the loop (half as many beats)"
          disabled={!has || !d.loop}
          target={deckTarget(id, 'loopHalve')}
          onClick={() => api.loopHalve(id)}
        >
          ½
        </PadButton>
        <PadButton
          label={`Deck ${id} loop double`}
          hint="Double the loop (twice as many beats)"
          disabled={!has || !d.loop}
          target={deckTarget(id, 'loopDouble')}
          onClick={() => api.loopDouble(id)}
        >
          2×
        </PadButton>
        <span className={styles.sep} />
        {AUTO_LOOP_BEATS.map((b) => (
          <PadButton
            key={b}
            label={`Deck ${id} loop ${loopBeatsLabel(b)} beats`}
            hint={`Loop ${loopBeatsLabel(b)} beat${b === 1 ? '' : 's'} from the beat under the playhead; press again to leave`}
            on={!!d.loop?.active && Math.abs(beatsOfLoop - b) < 1e-6}
            disabled={!has}
            target={deckTarget(id, `autoLoop:${b}`)}
            className={styles.autoLoop}
            onClick={() => api.autoLoop(id, b)}
          >
            {loopBeatsLabel(b)}
          </PadButton>
        ))}
        <span className={styles.sep} />
        <PadButton
          label={`Deck ${id} jump back`}
          hint={`Jump ${d.beatJump} beats back (keeps the beat)`}
          disabled={!has}
          target={deckTarget(id, 'beatJumpBack')}
          onClick={() => api.beatJumpBy(id, -d.beatJump)}
        >
          ◀
        </PadButton>
        <select
          className={styles.jumpSize}
          aria-label={`Deck ${id} beat jump size`}
          data-hint="How many beats the jump buttons move"
          value={d.beatJump}
          onChange={(e) => api.setBeatJump?.(id, Number(e.target.value))}
        >
          {BEAT_JUMPS.map((n) => (
            <option key={n} value={n}>
              {n} beats
            </option>
          ))}
        </select>
        <PadButton
          label={`Deck ${id} jump forward`}
          hint={`Jump ${d.beatJump} beats forward (keeps the beat)`}
          disabled={!has}
          target={deckTarget(id, 'beatJumpFwd')}
          onClick={() => api.beatJumpBy(id, d.beatJump)}
        >
          ▶
        </PadButton>
      </div>
    </section>
  );
}
