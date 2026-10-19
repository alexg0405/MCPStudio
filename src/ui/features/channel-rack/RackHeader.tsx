import { useStore } from 'zustand';
import { type PatternId } from '@core/model/types';
import { setStepCount, setSwing } from '@core/ops/notes';
import { p } from '@agstudio/sdk/params';
import { Knob } from '@agstudio/sdk/ui';
import { useDoc, useServices, useSession } from '../../services-context';
import { useGestureEdit } from '../../edit';
import { showContextMenu, type MenuEntry } from '../../controls/ContextMenu';
import { PatternPicker } from '../patterns/PatternPicker';
import { PlayPatternButton } from '../transport/PlayPatternButton';
import { stepsMenu, stepTarget, toggleGraph } from './steps';
import styles from './ChannelRack.module.css';

const SWING = p.float(0, 1, 0, { label: 'Swing', unit: '%' });

/**
 * The rack's header: play, pattern, steps, swing and the tools of the selected channel. It follows the selection
 * itself, so selecting a channel (every right-click and double-click does) re-renders this and not the rows.
 */
export function RackHeader({ patternId, stepCount }: { patternId: PatternId; stepCount: number }) {
  const services = useServices();
  const swing = useDoc((pr) => pr.transport.swing);
  const swingEdit = useGestureEdit<number>('Swing', (d, v) => setSwing(d, v), 'swing');
  const graphChannel = useStore(services.editor, (s) => s.stepGraph.channelId);
  const selected = useSession((s) => s.selectedChannelId);
  const selectedName = useDoc((pr) => {
    const ch = selected ? pr.channels[selected] : undefined;
    return ch?.kind === 'instrument' ? ch.name : null;
  });
  const menuBelow = (e: React.MouseEvent<HTMLElement>, items: MenuEntry[]) => {
    const r = e.currentTarget.getBoundingClientRect();
    showContextMenu({ x: r.left, y: r.bottom + 2 }, items);
  };
  const noChannel = 'Select an instrument channel first (click its name)';
  return (
    <div className={styles.header}>
      <PlayPatternButton
        patternId={patternId}
        className={`${styles.headerButton} ${styles.playButton}`}
        onClassName={styles.headerButtonOn}
      />
      <PatternPicker compact />
      <label className={styles.headerControl} data-hint="Number of steps in this pattern">
        Steps
        <select
          value={stepCount}
          onChange={(e) =>
            services.history.transact('Pattern steps', (d) => setStepCount(d, patternId, Number(e.target.value)))
          }
        >
          {[8, 16, 24, 32, 48, 64].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <span className={styles.headerControl}>
        <Knob spec={SWING} value={swing} size={20} label="Swing" {...swingEdit} />
        Swing
      </span>
      <button
        tabIndex={-1}
        className={styles.headerButton}
        disabled={!selectedName}
        onPointerDown={(e) => e.preventDefault()}
        onClick={(e) => menuBelow(e, stepsMenu(services, selected))}
        data-hint={
          selectedName
            ? `Step tools for ${selectedName}: fill every 2, 4 or 8 steps, rotate, shift, reverse, randomize or clear`
            : noChannel
        }
      >
        Steps ▾
      </button>
      <button
        tabIndex={-1}
        className={`${styles.headerButton} ${selected && graphChannel === selected ? styles.headerButtonOn : ''}`}
        disabled={!selectedName}
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => selected && stepTarget(services, selected) && toggleGraph(services, selected)}
        data-hint={
          selectedName
            ? `Graph editor: a row under ${selectedName} to draw each step’s velocity, pan, release, pitch or fine pitch`
            : noChannel
        }
      >
        Graph editor
      </button>
    </div>
  );
}
