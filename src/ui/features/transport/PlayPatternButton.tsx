import { useCallback, useSyncExternalStore } from 'react';
import { isPatternPlaying } from '@app/actions/transport';
import type { PatternId } from '@core/model/types';
import { Icon } from '../../controls/Icon';
import { useServices } from '../../services-context';

/**
 * True while the pattern (default: the current one) loops in pattern mode. It listens to the engine's
 * play/stop events and the view's mode and pattern, never the playhead, so playing causes no renders.
 */
export function usePatternPlaying(patternId?: PatternId | null): boolean {
  const services = useServices();
  const subscribe = useCallback(
    (fn: () => void) => {
      const offEngine = services.engine.subscribe(fn);
      const offView = services.view.subscribe((next, prev) => {
        if (next.mode !== prev.mode || next.currentPatternId !== prev.currentPatternId) fn();
      });
      return () => {
        offEngine();
        offView();
      };
    },
    [services],
  );
  return useSyncExternalStore(subscribe, () => isPatternPlaying(services, patternId));
}

/**
 * ▶ plays a pattern on a loop (pattern mode); while it plays the button is ■ and stops it. Styled by
 * the window it sits in (`className`, plus `onClassName` while playing).
 */
export function PlayPatternButton({
  patternId,
  className,
  onClassName = '',
  disabled = false,
}: {
  /** Default: the current pattern. */
  patternId?: PatternId | null;
  className: string;
  onClassName?: string;
  disabled?: boolean;
}) {
  const services = useServices();
  const playing = usePatternPlaying(patternId);
  return (
    <button
      type="button"
      className={`${className} ${playing ? onClassName : ''}`}
      disabled={disabled}
      aria-label={playing ? 'Stop' : 'Play pattern'}
      data-play-pattern
      onPointerDown={(e) => e.preventDefault()}
      onClick={() =>
        playing
          ? services.commands.run('transport.stop')
          : services.commands.run('transport.playPattern', patternId ? { patternId } : undefined)
      }
      data-hint={
        playing
          ? 'Stop playing (Space)'
          : 'Play this pattern on a loop (Space plays whatever is selected)'
      }
    >
      <Icon name={playing ? 'stop' : 'play'} size={12} />
    </button>
  );
}
