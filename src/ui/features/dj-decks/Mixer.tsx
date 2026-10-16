import { useEffect, useRef, useState } from 'react';
import type { DeckId, DecksApi } from '@app/dj/decks-api';
import { crossfaderGainFor, EQ_MAX_DB, EQ_MIN_DB, FADER_MAX, formatDeckTime, TRIM_MAX_DB, TRIM_MIN_DB } from '@core/dj/decks-math';
import { p } from '@agstudio/sdk/params';
import { Knob } from '@agstudio/sdk/ui';
import { Icon } from '../../controls/Icon';
import { deckTarget, MidiTarget, PadButton, Slider } from './controls';
import styles from './DjDecks.module.css';
import { useDeck, useDecksState } from './use-decks';

const TRIM = p.float(TRIM_MIN_DB, TRIM_MAX_DB, 0, { label: 'Trim', unit: 'dB' });
const EQ = (label: string) => p.float(EQ_MIN_DB, EQ_MAX_DB, 0, { label, unit: 'dB' });
const EQ_LOW = EQ('Low');
const EQ_MID = EQ('Mid');
const EQ_HIGH = EQ('High');
const FILTER = p.float(-1, 1, 0, { label: 'Filter' });
const MASTER = p.float(0, 1.5, 1, { label: 'Master volume' });

const gainDb = (v: number) => (v <= 0 ? '−∞ dB' : `${(40 * Math.log10(v)).toFixed(1)} dB`.replace('-', '−'));
const filterText = (v: number) => (Math.abs(v) < 0.02 ? 'off' : v < 0 ? `low-pass ${Math.round(-v * 100)}%` : `high-pass ${Math.round(v * 100)}%`);
const percent = (v: number) => `${Math.round(v * 100)}%`;

type Meter = (el: HTMLElement | null) => void;

function ChannelStrip({ api, id, meter, on }: { api: DecksApi; id: DeckId; meter: Meter; on: 'A' | 'B' | 'thru' }) {
  const d = useDeck(api, id);
  return (
    <div className={styles.strip} data-deck={id}>
      <span className={styles.stripLetter}>{id}</span>
      <MidiTarget id={deckTarget(id, 'trim')}>
        <Knob
          spec={TRIM}
          value={d.trimDb}
          label={`Deck ${id} trim`}
          size={26}
          bipolar
          hint="Gain before the knobs: turn a quiet song up or a loud one down so they match"
          onChange={(v) => api.setTrim(id, v as number)}
          onCommit={(v) => api.setTrim(id, v as number)}
        />
      </MidiTarget>
      <MidiTarget id={deckTarget(id, 'eq.high')}>
        <Knob
          spec={EQ_HIGH}
          value={d.eq.high}
          label={`Deck ${id} high`}
          size={26}
          hint="Treble (about 7 kHz and up): all the way down kills the hats and highs"
          onChange={(v) => api.setEq(id, 'high', v as number)}
          onCommit={(v) => api.setEq(id, 'high', v as number)}
        />
      </MidiTarget>
      <MidiTarget id={deckTarget(id, 'eq.mid')}>
        <Knob
          spec={EQ_MID}
          value={d.eq.mid}
          label={`Deck ${id} mid`}
          size={26}
          hint="Mids (around 1 kHz): all the way down takes out vocals and snares"
          onChange={(v) => api.setEq(id, 'mid', v as number)}
          onCommit={(v) => api.setEq(id, 'mid', v as number)}
        />
      </MidiTarget>
      <MidiTarget id={deckTarget(id, 'eq.low')}>
        <Knob
          spec={EQ_LOW}
          value={d.eq.low}
          label={`Deck ${id} low`}
          size={26}
          hint="Bass (about 120 Hz and down): all the way down kills the kick and bass, the classic way to blend two songs"
          onChange={(v) => api.setEq(id, 'low', v as number)}
          onCommit={(v) => api.setEq(id, 'low', v as number)}
        />
      </MidiTarget>
      <MidiTarget id={deckTarget(id, 'filter')}>
        <Knob
          spec={FILTER}
          value={d.filter}
          label={`Deck ${id} filter`}
          size={26}
          bipolar
          format={(v) => filterText(v as number)}
          hint="One-knob filter: left closes a low-pass (muffled), right opens a high-pass (thin); the middle is off"
          onChange={(v) => api.setFilter(id, v as number)}
          onCommit={(v) => api.setFilter(id, v as number)}
        />
      </MidiTarget>
      <PadButton
        target={deckTarget(id, 'pfl')}
        label={`Deck ${id} headphone cue`}
        hint="Headphone cue: hear this deck in your headphones (choose them in the bar above) before it goes out to the speakers"
        on={d.cueListen}
        onClick={() => api.setCueListen(id, !d.cueListen)}
      >
        HEAD
      </PadButton>
      <select
        className={styles.assign}
        aria-label={`Deck ${id} crossfader side`}
        data-hint="Which side of the crossfader this deck sits on: A (left), B (right) or thru (the crossfader doesn't touch it)"
        value={on}
        onChange={(e) => api.setCrossfaderAssign(id, e.target.value as 'A' | 'B' | 'thru')}
      >
        <option value="A">Side A</option>
        <option value="thru">Thru</option>
        <option value="B">Side B</option>
      </select>
      <div className={styles.faderRow}>
        <div className={styles.meter} aria-hidden>
          <i ref={meter} />
        </div>
        <Slider
          vertical
          target={deckTarget(id, 'volume')}
          className={styles.channelFader}
          value={d.volume}
          min={0}
          max={FADER_MAX}
          reset={1}
          marks={[1]}
          label={`Deck ${id} volume`}
          hint="Channel fader: how loud this deck is."
          format={gainDb}
          onChange={(v) => api.setVolume(id, v)}
        />
      </div>
    </div>
  );
}

/** The mixer: a strip per deck (trim, three-band kill EQ, filter, cue, fader), the crossfader, master and record. */
export function Mixer({ api, order, meterRef }: { api: DecksApi; order: readonly DeckId[]; meterRef(index: number): Meter }) {
  const mixer = useDecksState(api, (s) => ({
    crossfader: s.crossfader,
    curve: s.crossfaderCurve,
    assign: s.crossfaderAssign,
    master: s.masterVolume,
    recording: s.recording !== null,
  }));
  const clock = useRef<HTMLSpanElement>(null);
  const [error, setError] = useState('');

  // The recording clock counts imperatively, once a second, only while recording.
  useEffect(() => {
    if (!mixer.recording) return;
    const t0 = api.store.getState().recording?.startedAt ?? performance.now();
    const tick = () => {
      if (clock.current) clock.current.textContent = formatDeckTime((performance.now() - t0) / 1000);
    };
    tick();
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [api, mixer.recording]);

  const toggleRecord = async () => {
    try {
      setError('');
      if (mixer.recording) await api.stopRecording();
      else await api.startRecording();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className={styles.mixer}>
      <div className={styles.strips}>
        {order.map((id) => (
          <ChannelStrip key={id} api={api} id={id} meter={meterRef(['A', 'B', 'C', 'D'].indexOf(id))} on={mixer.assign[id]} />
        ))}
        <div className={styles.master}>
          <span className={styles.stripLetter}>Master</span>
          <MidiTarget id="masterVolume">
            <Knob
              spec={MASTER}
              value={mixer.master}
              label="Master volume"
              size={34}
              format={(v) => percent(v as number)}
              hint="Overall volume of the decks (a limiter stops it from clipping)"
              onChange={(v) => api.setMasterVolume(v as number)}
              onCommit={(v) => api.setMasterVolume(v as number)}
            />
          </MidiTarget>
          <div className={styles.masterMeters} aria-hidden>
            <div className={styles.meter}>
              <i ref={meterRef(4)} />
            </div>
            <div className={styles.meter}>
              <i ref={meterRef(5)} />
            </div>
          </div>
        </div>
      </div>
      <div className={styles.cross}>
        <span className={styles.crossLabel} data-hint="Deck A's side of the crossfader">
          A
        </span>
        <Slider
          target="crossfader"
          className={styles.crossfader}
          value={mixer.crossfader}
          min={-1}
          max={1}
          reset={0}
          marks={[0]}
          label="Crossfader"
          hint="Blends the decks on side A with the decks on side B: all the way left is only A, all the way right only B."
          format={(v) => (Math.abs(v) < 0.005 ? 'centered' : v < 0 ? `${Math.round(-v * 100)}% toward A` : `${Math.round(v * 100)}% toward B`)}
          onChange={(v) => api.setCrossfader(v)}
        />
        <span className={styles.crossLabel} data-hint="Deck B's side of the crossfader">
          B
        </span>
        <PadButton
          label="Crossfader curve"
          hint={
            mixer.curve === 'smooth'
              ? 'Crossfader curve: smooth (a gentle blend). Click for sharp (both decks stay loud until the very ends, for cutting and scratching)'
              : 'Crossfader curve: sharp (both decks stay loud until the very ends). Click for smooth (a gentle blend)'
          }
          on={mixer.curve === 'sharp'}
          onClick={() => api.setCrossfaderCurve?.(mixer.curve === 'smooth' ? 'sharp' : 'smooth')}
        >
          {mixer.curve === 'smooth' ? 'SMOOTH' : 'SHARP'}
        </PadButton>
        <span className={styles.crossGain} data-hint="What each side gets at the crossfader's position (A, then B)">
          {`${Math.round(crossfaderGainFor('A', mixer.crossfader, mixer.curve) * 100)} / ${Math.round(crossfaderGainFor('B', mixer.crossfader, mixer.curve) * 100)}%`}
        </span>
        <span className={styles.spacer} />
        <PadButton
          label={mixer.recording ? 'Stop recording' : 'Record the mix'}
          hint={
            mixer.recording
              ? 'Stop recording: the mix is added to your music library as “Live mix …”'
              : 'Record everything you hear from the decks; when you stop it is added to your music library'
          }
          on={mixer.recording}
          target="record"
          className={styles.record}
          onClick={() => void toggleRecord()}
        >
          <Icon name="record" size={12} />
          <span>{mixer.recording ? 'Stop' : 'Rec'}</span>
          <span ref={clock} className={styles.recClock} />
        </PadButton>
      </div>
      {error && <div className={styles.error}>{error}</div>}
    </div>
  );
}
