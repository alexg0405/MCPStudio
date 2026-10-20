import { Fragment, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { type ChannelId, type PatternId } from '@core/model/types';
import { useDoc, useServices } from '../../services-context';
import { useWindowedRows } from '../../controls/windowed';
import { showContextMenu } from '../../controls/ContextMenu';
import { Icon } from '../../controls/Icon';
import { dragMayHaveAudio, takeAudioFiles } from '../../audio-drag';
import { STEP_W, stepX } from './layout';
import { StepGraph } from './StepGraph';
import styles from './ChannelRack.module.css';
import { addChannelMenu } from './ChannelRack';
import { ChannelRow } from './ChannelRow';
import { dropOnRack, SOUND } from './rack-drop';
import { StepLight } from './StepLight';

/** One channel row: 30 px and a 2 px gap (the CSS of `.row`); a long rack keeps only the rows near the viewport. */
const ROW_PITCH = 32;

/** The channel rows, the add button and the step light. */
export function RackRows({ patternId, stepCount }: { patternId: PatternId; stepCount: number }) {
  const services = useServices();
  const order = useDoc((pr) => pr.channelOrder);
  /** Where a drag would drop: a channel, or the end of the rack ('new'). */
  const [dropTarget, setDropTarget] = useState<ChannelId | 'new' | null>(null);
  const graphChannel = useStore(services.editor, (s) => s.stepGraph.channelId);
  // A long rack (150 channels in a long song) renders only the rows near the viewport, so opening the rack and
  // switching patterns cost what a screenful costs. With the step graph open a row is taller than the rest:
  // every row renders then.
  const scrollRef = useRef<HTMLDivElement>(null);
  const win = useWindowedRows(scrollRef, order.length, ROW_PITCH, { overscan: 10 });
  const windowed = graphChannel === null;
  const first = windowed ? win.first : 0;
  const last = windowed ? win.last : order.length;
  const targetOf = (e: React.DragEvent) =>
    (e.target as Element).closest<HTMLElement>('[data-channel-id]')?.dataset.channelId as ChannelId | undefined;

  return (
    <div
      ref={scrollRef}
      className={styles.scroll}
      onScroll={win.onScroll}
      onDragOver={(e) => {
        const dt = e.dataTransfer;
        if (!dt.types.includes(SOUND) && !dragMayHaveAudio(dt)) return;
        e.preventDefault();
        dt.dropEffect = 'copy';
        const target = targetOf(e) ?? 'new';
        if (target !== dropTarget) setDropTarget(target);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null);
      }}
      onDrop={(e) => {
        setDropTarget(null);
        const generator = e.dataTransfer.getData(SOUND);
        // Read during the event: the DataTransfer is emptied afterwards.
        const files = generator ? null : takeAudioFiles(e.dataTransfer);
        if (!generator && !files) return;
        e.preventDefault();
        void dropOnRack(services, targetOf(e), generator, files);
      }}
    >
      <div
        className={styles.rows}
        style={{ minWidth: 250 + stepX(stepCount - 1) + STEP_W }}
        role="group"
        aria-label="Channels and steps"
        data-roving="grid"
      >
        {windowed && win.padTop > 0 && <div aria-hidden style={{ height: win.padTop }} />}
        {order.slice(first, last).map((id) => (
          <Fragment key={id}>
            <ChannelRow id={id} dropTarget={dropTarget === id} />
            {graphChannel === id && <StepGraph channelId={id} patternId={patternId} stepCount={stepCount} />}
          </Fragment>
        ))}
        {windowed && win.padBottom > 0 && <div aria-hidden style={{ height: win.padBottom }} />}
        <StepLight stepCount={stepCount} />
        {order.length === 0 && (
          <div className={styles.empty}>
            No sounds yet. Click the + below to add a kit sound or an instrument, or drag a sample here from the
            browser.
          </div>
        )}
        <div className={`${styles.addRow} ${dropTarget === 'new' ? styles.addRowDrop : ''}`}>
          <button
            className={styles.addButton}
            onPointerDown={(e) => e.preventDefault()}
            onClick={(e) => showContextMenu(e, addChannelMenu(services))}
            data-hint="Add a channel (kit sound or instrument)"
            aria-label="Add a channel"
          >
            <Icon name="plus" size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
