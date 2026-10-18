import type { TrackAnalyzer } from '@app/dj/analysis-cache';
import { transitionLabel, tweakTransition } from '@app/dj/mix';
import type { MixPlan, TransitionRecipe, TransitionTweak } from '@core/dj/plan';
import type { DjMixState } from '@core/model/types';
import { Icon } from '../../controls/Icon';
import { useServices } from '../../services-context';
import { openWindow } from '../../workspace/registry';
import styles from './Dj.module.css';
import { LENGTH_CHOICES, RECIPE_CHOICES } from './dj-view';

/** Ticks in a bar of 4/4 (the mix is in 4/4). */
const TICKS_PER_BAR = 3840;

/** "Play" on a transition starts this many bars before it, so the change-over can be heard coming. */
const PLAY_LEAD_IN_BARS = 2;

/** The transitions of the mix on the playlist, each with its length, recipe and riser to change. */
export function TransitionsList({
  mix,
  plan,
  analyzer,
}: {
  /** What the project remembers of its mix. */
  mix: DjMixState;
  /** The plan of that mix, or null when its songs aren't analyzed in this browser. */
  plan: MixPlan | null;
  analyzer: TrackAnalyzer | null;
}) {
  const services = useServices();
  return (
    <div className={styles.transitions}>
      <div className={styles.bar}>
        <span className={styles.label}>Transitions</span>
        <span className={styles.dim}>{mix.songs.length} songs on the playlist</span>
        <span className={styles.spacer} />
        <button className={styles.button} onClick={() => openWindow(services, 'playlist')} data-hint="Show the mix on the playlist">
          <Icon name="playlist" size={13} /> Playlist
        </button>
        <button className={styles.button} onClick={() => void services.commands.run('dj.exportMix')} data-hint="Export the whole mix to a WAV, FLAC or MP3 file">
          Export mix…
        </button>
      </div>
      {!plan && <div className={styles.warning}>The songs of this mix aren’t analyzed in this browser yet: add them to the library to change transitions.</div>}
      {plan?.warnings.map((warning) => (
        <div key={warning} className={styles.warning}>
          {warning}
        </div>
      ))}
      {plan?.transitions.map((transition) => (
        <TransitionRow key={`${transition.from}>${transition.to}`} mix={mix} transition={transition} analyzer={analyzer} />
      ))}
    </div>
  );
}

/** One transition: its names, a length, a recipe, a riser switch, a preview and a reset. */
function TransitionRow({ mix, transition, analyzer }: { mix: DjMixState; transition: MixPlan['transitions'][number]; analyzer: TrackAnalyzer | null }) {
  const services = useServices();
  const songTitle = (sampleId: string) => mix.songs.find((song) => song.sampleId === sampleId)?.title ?? '?';
  const analysisOfSample = (sampleId: string) => {
    const sample = services.doc.getState().project.samples[sampleId as never];
    if (!sample || !analyzer) return null;
    return analyzer.peek(sample.source.kind === 'embedded' ? sample.source.hash : '');
  };
  const tweak = (patch: TransitionTweak | null) => {
    try {
      tweakTransition(services, transition.to, patch);
    } catch (e) {
      services.session.getState().toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };
  const bar = Math.floor(transition.start / TICKS_PER_BAR) + 1;
  return (
    <div className={styles.transition}>
      <span className={styles.num}>{transition.index + 1}</span>
      <span
        className={styles.transitionNames}
        data-hint={`${transitionLabel(transition, analysisOfSample(transition.from), analysisOfSample(transition.to))}. Why: ${transition.why}`}
      >
        {songTitle(transition.from)} → {songTitle(transition.to)}
        <span className={styles.artist}>bar {bar}</span>
      </span>
      <select
        className={styles.select}
        value={transition.bars}
        onChange={(e) => tweak({ bars: Number(e.target.value) })}
        data-hint="How long both songs play together (bars); 0 = a cut"
      >
        {[0, ...LENGTH_CHOICES].map((bars) => (
          <option key={bars} value={bars}>
            {bars === 0 ? 'Cut' : `${bars} bars`}
          </option>
        ))}
      </select>
      <select
        className={styles.select}
        value={transition.recipe}
        onChange={(e) => tweak({ recipe: e.target.value as TransitionRecipe })}
        data-hint={RECIPE_CHOICES.find((recipe) => recipe.value === transition.recipe)?.hint ?? 'How the songs change over'}
      >
        {RECIPE_CHOICES.map((recipe) => (
          <option key={recipe.value} value={recipe.value}>
            {recipe.label}
          </option>
        ))}
      </select>
      <label className={styles.dim} data-hint="A riser sound building into the moment the next song takes over">
        <input type="checkbox" checked={transition.riser} onChange={(e) => tweak({ riser: e.target.checked })} /> Riser
      </label>
      <button
        className={styles.ghost}
        onClick={() => {
          services.view.getState().setMode('song');
          services.engine.play(Math.max(0, transition.start - PLAY_LEAD_IN_BARS * TICKS_PER_BAR));
        }}
        data-hint="Play from 2 bars before this transition"
      >
        <Icon name="play" size={12} />
      </button>
      <button className={styles.ghost} onClick={() => tweak(null)} disabled={!mix.tweaks[transition.to]} data-hint="Back to what Studio picked for this transition">
        Reset
      </button>
    </div>
  );
}
