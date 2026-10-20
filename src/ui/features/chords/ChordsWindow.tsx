import { useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { addChordAt, applyProgression, barOfTick, clearChordTrack, currentHarmonyKey, nextChordSuggestions, typeChords } from '@app/harmony/chord-track';
import { detectChords, type DetectWhere } from '@app/harmony/detect';
import { bassStyleLabel, fitMelodyToChords, makeBassline, makeChordPart, partTarget } from '@app/harmony/parts';
import type { ActionResult } from '@app/harmony/chord-track';
import type { Services } from '@app/services';
import { BASS_STYLES, type BassStyle } from '@core/harmony/bassline';
import { formatChord, keyUsesFlats } from '@core/harmony/chord';
import { keyForMode } from '@core/harmony/key';
import { findProgressions, GENRES, MOODS, progressionChords, type Progression } from '@core/harmony/progressions';
import { keyMode } from '@core/harmony/scale';
import type { Register } from '@core/harmony/plan';
import { COMP_RHYTHMS, type CompRhythm, type Spread } from '@core/harmony/voicing';
import { keyLabel } from '@agstudio/sdk/notes';
import { chordsSorted, chordTrackEnd, chordTrackLines, projectUsesFlats } from '@core/query/chords';
import { ticksPerBar } from '@core/time/ppq';
import { showContextMenu } from '../../controls/ContextMenu';
import { useDoc, useServices } from '../../services-context';
import { keyMenu } from '../piano-roll/menus';
import styles from './Chords.module.css';

const SPREAD_LABELS: Record<Spread, string> = { close: 'Close', open: 'Open (wider)', drop2: 'Drop 2 (jazz)' };
const RHYTHM_LABELS: Record<CompRhythm, string> = {
  hold: 'Held (a whole chord)',
  beats: 'Every beat',
  offbeats: 'Off-beats',
  eighths: 'Every eighth',
};
const REGISTER_LABELS: Record<Register, string> = { low: 'Low', mid: 'Middle', high: 'High' };
const DETECT_LABELS: Record<DetectWhere, string> = {
  song: 'The whole song',
  selection: 'Clips selected in the playlist',
  loop: 'The loop region',
  pattern: 'The current pattern',
};

/** Shows what an action did as a toast. */
function report(services: Services, result: ActionResult): void {
  services.session.getState().toast(result.message, result.ok ? 'info' : 'error');
}

function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className={styles.section}>
      <h3 className={styles.heading} data-hint={hint}>
        {title}
      </h3>
      {children}
    </section>
  );
}

/** The chords written so far, and a box to type them. */
function TrackSection() {
  const services = useServices();
  const chords = useDoc((project) => project.chords);
  const lines = useMemo(() => chordTrackLines(services.doc.getState().project), [services, chords]);
  const [text, setText] = useState('');
  const [startBar, setStartBar] = useState(1);
  const submit = () => {
    const result = typeChords(services, text, { startBar });
    report(services, result);
    if (result.ok) setText('');
  };
  return (
    <Section title="Chord track" hint="The song’s harmony over time: shown in the lane above the playlist and behind the piano roll">
      {lines.length === 0 ? (
        <p className={styles.empty}>No chords yet. Type some below, pick a progression, or detect them from what you have already written.</p>
      ) : (
        <ul className={styles.lines}>
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      <div className={styles.row}>
        <input
          className={styles.textBox}
          value={text}
          placeholder="Am7 | F | C | G"
          spellCheck={false}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') submit();
          }}
          data-hint="Type chords, one a bar: Am7 | F | C/E | G7. A dot holds the chord before it. Enter puts them on the chord track from the bar on the right"
        />
        <label className={styles.field} data-hint="1-based bar the first chord goes on">
          from bar
          <input className={styles.number} type="number" min={1} value={startBar} onChange={(event) => setStartBar(Math.max(1, Number(event.target.value) || 1))} />
        </label>
        <button className={styles.button} onClick={submit} disabled={!text.trim()} data-hint="Put these chords on the chord track (replaces chords under them); one undo step">
          Set chords
        </button>
        <button
          className={styles.button}
          disabled={!chords}
          onClick={() => report(services, clearChordTrack(services))}
          data-hint="Remove every chord from the chord track (one undo step)"
        >
          Clear
        </button>
      </div>
      <NextIdeas />
    </Section>
  );
}

/** Chords that could come after the last one. */
function NextIdeas() {
  const services = useServices();
  const chords = useDoc((project) => project.chords);
  const [sevenths, setSevenths] = useState(false);
  const project = services.doc.getState().project;
  const flats = projectUsesFlats(project);
  const end = chordTrackEnd(project);
  const ideas = useMemo(() => nextChordSuggestions(services, end, sevenths), [services, chords, end, sevenths]);
  const bar = ticksPerBar(project.transport.timeSig);
  return (
    <div className={styles.ideas}>
      <span className={styles.label} data-hint="Chords that fit after the last chord in the song key, best first. Click one to add it after the track">
        {chordsSorted(project).length ? 'Next chord ideas' : 'Ways to start'}
      </span>
      {ideas.map((idea) => (
        <button
          key={`${idea.roman}-${formatChord(idea.chord)}`}
          className={styles.chip}
          onClick={() => void addChordAt(services, end, bar, idea.chord)}
          data-hint={`${idea.reason} (${idea.function === 'other' ? 'borrowed' : idea.function}). Adds it as bar ${barOfTick(services, end)} of the chord track`}
        >
          {formatChord(idea.chord, flats)} <small>{idea.roman}</small>
        </button>
      ))}
      <label className={styles.field} data-hint="Suggest seventh chords (Am7, G7) instead of plain triads">
        <input type="checkbox" checked={sevenths} onChange={(event) => setSevenths(event.target.checked)} /> sevenths
      </label>
    </div>
  );
}

function DetectSection() {
  const services = useServices();
  const [where, setWhere] = useState<DetectWhere>('song');
  const [resolution, setResolution] = useState<'bar' | 'half'>('bar');
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      report(services, await detectChords(services, { where, resolution }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Detect chords" hint="Read the chords your song already plays and fill the chord track">
      <div className={styles.row}>
        <label className={styles.field} data-hint="Where to read the chords from: the notes of chord, pad, keys and bass parts (and audio clips)">
          read
          <select value={where} onChange={(event) => setWhere(event.target.value as DetectWhere)}>
            {(Object.keys(DETECT_LABELS) as DetectWhere[]).map((id) => (
              <option key={id} value={id}>
                {DETECT_LABELS[id]}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field} data-hint="How finely to read: one chord per bar, or per half bar for songs that change twice a bar">
          every
          <select value={resolution} onChange={(event) => setResolution(event.target.value as 'bar' | 'half')}>
            <option value="bar">bar</option>
            <option value="half">half bar</option>
          </select>
        </label>
        <button className={styles.button} disabled={busy} onClick={() => void run()} data-hint="Fill the chord track from the notes (and audio clips). Chords it is unsure about are faded. One undo step">
          {busy ? 'Reading…' : 'Detect chords'}
        </button>
      </div>
    </Section>
  );
}

function ProgressionCard({ progression, flats }: { progression: Progression; flats: boolean }) {
  const services = useServices();
  const [sevenths, setSevenths] = useState(false);
  const key = keyForMode(currentHarmonyKey(services, progression.mode), progression.mode);
  const names = progressionChords(progression, key).map((entry) => formatChord(entry.chord, flats));
  return (
    <li className={styles.card}>
      <div className={styles.cardTop}>
        <strong>{progression.name}</strong>
        <span className={styles.tag}>{progression.mode}</span>
        <span className={styles.spacer} />
        <label className={styles.field} data-hint="Use the key’s seventh chords instead of plain triads">
          <input type="checkbox" checked={sevenths} aria-label={`Seventh chords for ${progression.name}`} onChange={(event) => setSevenths(event.target.checked)} /> 7ths
        </label>
        <button
          className={styles.button}
          aria-label={`Use ${progression.name}`}
          onClick={() => report(services, applyProgression(services, progression, { sevenths, bars: Math.max(8, progressionChords(progression, key).reduce((sum, entry) => sum + entry.bars, 0)) }))}
          data-hint={`Put ${progression.name} on the chord track in ${keyLabel(key.root, key.scale)}, from the song position, repeated to fill at least 8 bars (one undo step)`}
        >
          Use
        </button>
      </div>
      <div className={styles.names}>{names.join('  |  ')}</div>
      <div className={styles.note}>{progression.note}</div>
    </li>
  );
}

function ProgressionsSection() {
  const services = useServices();
  const song = useDoc((project) => project.transport.key);
  const [mood, setMood] = useState('');
  const [genre, setGenre] = useState('');
  const flats = song ? keyUsesFlats(song.root, keyMode(song.scale)) : false;
  const list = findProgressions({ ...(mood ? { mood } : {}), ...(genre ? { genre } : {}) });
  const key = currentHarmonyKey(services);
  return (
    <Section title="Progressions" hint="Common chord progressions, written in the song key (a minor one in a major song moves to its relative minor)">
      <div className={styles.row}>
        <button
          className={styles.button}
          onClick={(event) => showContextMenu(event.currentTarget.getBoundingClientRect(), keyMenu(services))}
          data-hint="The song key: progressions, chord ideas, scale lock and the piano roll all use it. Click to change it"
        >
          Key: {song ? keyLabel(song.root, song.scale) : `not set (using ${keyLabel(key.root, key.scale)})`}
        </button>
        <label className={styles.field} data-hint="Show progressions with this mood">
          mood
          <select value={mood} onChange={(event) => setMood(event.target.value)}>
            <option value="">any</option>
            {MOODS.map((id) => (
              <option key={id}>{id}</option>
            ))}
          </select>
        </label>
        <label className={styles.field} data-hint="Show progressions used in this genre">
          genre
          <select value={genre} onChange={(event) => setGenre(event.target.value)}>
            <option value="">any</option>
            {GENRES.map((id) => (
              <option key={id}>{id}</option>
            ))}
          </select>
        </label>
      </div>
      {list.length === 0 ? (
        <p className={styles.empty}>No progression has that mood and genre together: try one of them alone.</p>
      ) : (
        <ul className={styles.cards} aria-label="Progressions" data-roving="grid">
          {list.map((progression) => (
            <ProgressionCard key={progression.id} progression={progression} flats={flats} />
          ))}
        </ul>
      )}
    </Section>
  );
}

/** Where the parts go: the selected channel in the current pattern. */
function useTargetText(services: Services): string {
  const channelId = useStore(services.session, (state) => state.selectedChannelId);
  const patternId = useStore(services.view, (state) => state.currentPatternId);
  const channelName = useDoc((project) => (channelId ? project.channels[channelId]?.name : undefined));
  const patternName = useDoc((project) => (patternId ? project.patterns[patternId]?.name : undefined));
  const target = partTarget(services);
  if (typeof target === 'string') return target;
  return `Writes into “${channelName ?? 'the channel'}” in “${patternName ?? 'the pattern'}” (its notes there are replaced; one undo step).`;
}

function PartsSection() {
  const services = useServices();
  const hasChords = useDoc((project) => !!project.chords);
  const targetText = useTargetText(services);
  const [register, setRegister] = useState<Register>('mid');
  const [spread, setSpread] = useState<Spread>('close');
  const [rhythm, setRhythm] = useState<CompRhythm>('hold');
  const [withBass, setWithBass] = useState(false);
  const [style, setStyle] = useState<BassStyle>('roots');
  const [strength, setStrength] = useState(100);
  return (
    <Section title="Write parts from the chords" hint="Chords, a bassline and a melody that fit the chord track. Select an instrument channel first">
      <p className={styles.note}>{hasChords ? targetText : 'Add chords to the chord track first.'}</p>
      <div className={styles.row}>
        <label className={styles.field} data-hint="Where the chords sit: low, middle or high on the keyboard">
          register
          <select value={register} onChange={(event) => setRegister(event.target.value as Register)}>
            {(Object.keys(REGISTER_LABELS) as Register[]).map((id) => (
              <option key={id} value={id}>
                {REGISTER_LABELS[id]}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field} data-hint="How the notes of each chord are spread">
          spread
          <select value={spread} onChange={(event) => setSpread(event.target.value as Spread)}>
            {(Object.keys(SPREAD_LABELS) as Spread[]).map((id) => (
              <option key={id} value={id}>
                {SPREAD_LABELS[id]}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field} data-hint="How each chord is played: held, or struck on every beat, off-beat or eighth">
          rhythm
          <select value={rhythm} onChange={(event) => setRhythm(event.target.value as CompRhythm)}>
            {COMP_RHYTHMS.map((id) => (
              <option key={id} value={id}>
                {RHYTHM_LABELS[id]}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field} data-hint="Add each chord’s root as a low note under it">
          <input type="checkbox" checked={withBass} onChange={(event) => setWithBass(event.target.checked)} /> bass note
        </label>
        <button
          className={styles.button}
          disabled={!hasChords}
          onClick={() => report(services, makeChordPart(services, { register, spread, rhythm, ...(withBass ? { bass: true } : {}) }))}
          data-hint="Write the chord track as voiced chords. Each chord moves as little as possible from the one before (voice leading)"
        >
          Make chords
        </button>
      </div>
      <div className={styles.row}>
        <label className={styles.field} data-hint="Roots: a held root per chord. Root and fifth: alternating on the beats. Walking: quarter notes with approach notes. 808: hits where the kick hits">
          bassline
          <select value={style} onChange={(event) => setStyle(event.target.value as BassStyle)}>
            {BASS_STYLES.map((id) => (
              <option key={id} value={id}>
                {bassStyleLabel(id)}
              </option>
            ))}
          </select>
        </label>
        <button
          className={styles.button}
          disabled={!hasChords}
          onClick={() => report(services, makeBassline(services, { style }))}
          data-hint="Write a bassline that follows the chord track into the selected channel (an 808 follows the beat’s kick)"
        >
          Make a bassline
        </button>
      </div>
      <div className={styles.row}>
        <label className={styles.field} data-hint="How many of the notes that are off the chords get moved, the smallest moves first (100 % fixes them all)">
          strength
          <input type="range" min={0} max={100} step={5} value={strength} onChange={(event) => setStrength(Number(event.target.value))} />
          <span className={styles.value}>{strength} %</span>
        </label>
        <button
          className={styles.button}
          disabled={!hasChords}
          onClick={() => report(services, fitMelodyToChords(services, strength / 100))}
          data-hint="Move the selected notes (or all of the channel’s) onto chord tones on strong beats and scale tones elsewhere. Timing is not changed"
        >
          Fit melody to chords
        </button>
      </div>
    </Section>
  );
}

/** The Chords window: the chord track, detection, progressions, and parts written from the chords. */
export function ChordsWindow() {
  return (
    <div className={styles.root}>
      <TrackSection />
      <DetectSection />
      <ProgressionsSection />
      <PartsSection />
    </div>
  );
}
