import { useEffect, useRef, useState } from 'react';
import { useHistoryStatus, useServices } from '../../services-context';
import styles from './History.module.css';

const ago = (ms: number) => {
  const s = Math.round(ms / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

/**
 * Every change you made, in plain words: click one to go back to just after it (or forward again).
 * Undone changes stay listed, dimmed, until a new change replaces them.
 */
export function HistoryWindow() {
  const services = useServices();
  // Re-renders whenever the history changes.
  const status = useHistoryStatus();
  const { done, undone } = services.history.steps();
  // "2 min ago" refreshes on its own (history times are Date.now()).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector('[data-current]')?.scrollIntoView({ block: 'nearest' });
  }, [status.cursor]);
  const row = (id: number, label: string, time: number | null, state: 'done' | 'current' | 'undone') => (
    <button
      key={id}
      className={`${styles.row} ${state === 'current' ? styles.current : ''} ${state === 'undone' ? styles.undone : ''}`}
      data-current={state === 'current' || undefined}
      onClick={() => services.history.goTo(id)}
      data-hint={
        state === 'current'
          ? 'This is where you are now'
          : state === 'undone'
            ? `Redo up to “${label}”`
            : id === 0
              ? 'Go back to before every change listed here'
              : `Go back to just after “${label}”`
      }
    >
      <span className={styles.dot} />
      <span className={styles.label}>{label}</span>
      {time !== null && <span className={styles.time}>{ago(now - time)}</span>}
    </button>
  );
  return (
    <div className={styles.wrap}>
      <div className={styles.help}>Click a change to go back to it. Nothing is lost: undone changes stay below until you make a new one.</div>
      <div ref={listRef} className={styles.list}>
        {row(0, 'Start (when the project was opened)', null, done.length === 0 ? 'current' : 'done')}
        {done.map((step, i) => row(step.id, step.label, step.time, i === done.length - 1 ? 'current' : 'done'))}
        {undone.map((step) => row(step.id, step.label, step.time, 'undone'))}
      </div>
    </div>
  );
}
