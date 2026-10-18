import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import { HOT_CUES, type DeckId, type DecksApi } from '@app/dj/decks-api';
import { AUTO_LOOP_BEATS, formatDeckTime, loopBeats, loopBeatsLabel } from '@core/dj/decks-math';
import { showContextMenu } from '../../controls/ContextMenu';
import { deckTarget, PadButton } from './controls';
import styles from './DjDecks.module.css';
import { HOT_CUE_VARS } from './scope';
import type { DeckView } from './use-decks';

/** The sizes the beat-jump selector offers (beats). */
const BEAT_JUMP_SIZES = [1, 2, 4, 8, 16, 32] as const;

/** The tempo assumed to size a loop when the song has none (BPM): only used to count its beats. */
const FALLBACK_BPM = 120;

/** Two loop lengths closer than this (beats) are the same size. */
const SAME_LOOP_TOLERANCE_BEATS = 1e-6;

/** The row of hot cue pads: click sets or jumps, right-click clears. */
export function HotCuePads({ api, deckId, deck }: { api: DecksApi; deckId: DeckId; deck: DeckView }) {
  const hasSong = deck.song !== null;
  const clearMenu = (e: ReactMouseEvent, padIndex: number) => {
    e.preventDefault();
    if (deck.hotCues[padIndex] === null) return;
    showContextMenu(e, [{ label: `Clear hot cue ${padIndex + 1}`, onSelect: () => api.clearHotCue(deckId, padIndex) }]);
  };
  return (
    <div className={styles.hotCues} role="group" aria-label={`Deck ${deckId} hot cues`}>
      {Array.from({ length: HOT_CUES }, (_, padIndex) => {
        const cueSec = deck.hotCues[padIndex];
        const isSet = cueSec !== null && cueSec !== undefined;
        return (
          <PadButton
            key={padIndex}
            label={`Deck ${deckId} hot cue ${padIndex + 1}`}
            hint={
              isSet
                ? `Hot cue ${padIndex + 1} at ${formatDeckTime(cueSec)}: click to jump there and play. Right-click to clear it`
                : `Hot cue ${padIndex + 1} (empty): click to set it at the playhead, on the beat`
            }
            on={isSet}
            disabled={!hasSong}
            target={deckTarget(deckId, `hotcue:${padIndex + 1}`)}
            className={styles.hotCue}
            style={{ '--pad': HOT_CUE_VARS[padIndex] } as CSSProperties}
            onClick={() => api.hotCue(deckId, padIndex)}
            onContextMenu={(e) => clearMenu(e, padIndex)}
          >
            {padIndex + 1}
          </PadButton>
        );
      })}
    </div>
  );
}

/** The loop row: in, out, halve, double, the auto loop sizes, and the beat jump buttons. */
export function LoopPads({ api, deckId, deck }: { api: DecksApi; deckId: DeckId; deck: DeckView }) {
  const hasSong = deck.song !== null;
  const hasLoopEnd = deck.loop !== null && deck.loop.endSec > deck.loop.startSec;
  const loopSizeBeats = deck.loop && hasLoopEnd ? loopBeats(deck.loop, { bpm: deck.baseBpm ?? FALLBACK_BPM, firstDownbeat: 0 }) : 0;
  return (
    <div className={styles.loops}>
      <PadButton
        label={`Deck ${deckId} loop in`}
        hint="Loop in: mark where a loop starts (on the beat)"
        disabled={!hasSong}
        target={deckTarget(deckId, 'loopIn')}
        onClick={() => api.loopIn(deckId)}
      >
        IN
      </PadButton>
      <PadButton
        label={`Deck ${deckId} loop out`}
        hint="Loop out: close the loop here and start repeating it; press again to leave, once more to go back into it"
        on={deck.loop?.active ?? false}
        disabled={!hasSong}
        target={deckTarget(deckId, 'loopOut')}
        onClick={() => api.loopOut(deckId)}
      >
        OUT
      </PadButton>
      <PadButton
        label={`Deck ${deckId} loop half`}
        hint="Halve the loop (half as many beats)"
        disabled={!hasSong || !deck.loop}
        target={deckTarget(deckId, 'loopHalve')}
        onClick={() => api.loopHalve(deckId)}
      >
        ½
      </PadButton>
      <PadButton
        label={`Deck ${deckId} loop double`}
        hint="Double the loop (twice as many beats)"
        disabled={!hasSong || !deck.loop}
        target={deckTarget(deckId, 'loopDouble')}
        onClick={() => api.loopDouble(deckId)}
      >
        2×
      </PadButton>
      <span className={styles.sep} />
      {AUTO_LOOP_BEATS.map((beats) => (
        <PadButton
          key={beats}
          label={`Deck ${deckId} loop ${loopBeatsLabel(beats)} beats`}
          hint={`Loop ${loopBeatsLabel(beats)} beat${beats === 1 ? '' : 's'} from the beat under the playhead; press again to leave`}
          on={!!deck.loop?.active && Math.abs(loopSizeBeats - beats) < SAME_LOOP_TOLERANCE_BEATS}
          disabled={!hasSong}
          target={deckTarget(deckId, `autoLoop:${beats}`)}
          className={styles.autoLoop}
          onClick={() => api.autoLoop(deckId, beats)}
        >
          {loopBeatsLabel(beats)}
        </PadButton>
      ))}
      <span className={styles.sep} />
      <BeatJumpPads api={api} deckId={deckId} deck={deck} />
    </div>
  );
}

/** Jump back, the jump size selector, jump forward. */
function BeatJumpPads({ api, deckId, deck }: { api: DecksApi; deckId: DeckId; deck: DeckView }) {
  const hasSong = deck.song !== null;
  return (
    <>
      <PadButton
        label={`Deck ${deckId} jump back`}
        hint={`Jump ${deck.beatJump} beats back (keeps the beat)`}
        disabled={!hasSong}
        target={deckTarget(deckId, 'beatJumpBack')}
        onClick={() => api.beatJumpBy(deckId, -deck.beatJump)}
      >
        ◀
      </PadButton>
      <select
        className={styles.jumpSize}
        aria-label={`Deck ${deckId} beat jump size`}
        data-hint="How many beats the jump buttons move"
        value={deck.beatJump}
        onChange={(e) => api.setBeatJump?.(deckId, Number(e.target.value))}
      >
        {BEAT_JUMP_SIZES.map((beats) => (
          <option key={beats} value={beats}>
            {beats} beats
          </option>
        ))}
      </select>
      <PadButton
        label={`Deck ${deckId} jump forward`}
        hint={`Jump ${deck.beatJump} beats forward (keeps the beat)`}
        disabled={!hasSong}
        target={deckTarget(deckId, 'beatJumpFwd')}
        onClick={() => api.beatJumpBy(deckId, deck.beatJump)}
      >
        ▶
      </PadButton>
    </>
  );
}
