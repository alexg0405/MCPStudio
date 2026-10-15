import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { WindowInstance } from '@app/stores/view';
import type { Rect, Size } from '@core/time/geometry';
import { useServices } from '../services-context';
import { Icon } from '../controls/Icon';
import { clampRect, getWindowType } from './registry';
import { subscribeWindowHelp, windowHelp, type WindowHelp } from './window-help';
import styles from './Workspace.module.css';

type DragMode = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const HANDLES: Exclude<DragMode, 'move'>[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

function applyDrag(mode: DragMode, r: Rect, dx: number, dy: number, min: Size): Rect {
  if (mode === 'move') return { ...r, x: r.x + dx, y: r.y + dy };
  let { x, y, w, h } = r;
  if (mode.includes('e')) w = Math.max(min.w, r.w + dx);
  if (mode.includes('s')) h = Math.max(min.h, r.h + dy);
  if (mode.includes('w')) {
    w = Math.max(min.w, r.w - dx);
    x = r.x + (r.w - w);
  }
  if (mode.includes('n')) {
    h = Math.max(min.h, r.h - dy);
    y = r.y + (r.h - h);
  }
  return { x, y, w, h };
}

function cascaded(r: Rect, steps: number): Rect {
  return steps ? { ...r, x: r.x + steps * 26, y: r.y + steps * 26 } : r;
}

interface Props {
  instance: WindowInstance;
  workspace: Size;
  focused: boolean;
}

export const FloatingWindow = memo(function FloatingWindow({ instance, workspace, focused }: Props) {
  const services = useServices();
  const elRef = useRef<HTMLDivElement>(null);
  const def = getWindowType(instance.type);
  // Titles can depend on app state (e.g. the piano roll's channel), so follow it.
  const subscribe = useCallback((fn: () => void) => services.subscribe(fn), [services]);
  const title = useSyncExternalStore(subscribe, () => def?.title(instance.props, services) ?? '');
  const help = useSyncExternalStore(subscribeWindowHelp, () => windowHelp(instance.type));
  const [helpOpen, setHelpOpen] = useState(false);
  if (!def) return null;

  const min = def.minSize ?? { w: 220, h: 120 };
  const base = instance.rect ?? cascaded(def.defaultRect(workspace), instance.cascade ?? 0);
  const rect = instance.maximized ? { x: 0, y: 0, w: workspace.w, h: workspace.h } : clampRect(base, workspace, min);
  const Content = def.component;

  const startDrag = (e: ReactPointerEvent, mode: DragMode) => {
    if (e.button !== 0 || instance.maximized) return;
    if ((e.target as HTMLElement).closest('button')) return;
    const el = elRef.current;
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    // Capture on the grabbed element itself (not the window) so click/dblclick still target it.
    const grip = e.currentTarget as HTMLElement;
    grip.setPointerCapture(e.pointerId);
    const sx = e.clientX;
    const sy = e.clientY;
    let current = rect;
    const move = (ev: PointerEvent) => {
      current = clampRect(applyDrag(mode, rect, ev.clientX - sx, ev.clientY - sy, min), workspace, min);
      // Move the DOM directly while dragging; React only hears about the final rect.
      el.style.transform = `translate(${current.x}px, ${current.y}px)`;
      el.style.width = `${current.w}px`;
      el.style.height = `${current.h}px`;
    };
    const up = (ev: PointerEvent) => {
      grip.releasePointerCapture(ev.pointerId);
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      if (current !== rect) services.view.getState().setRect(instance.id, current);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  };

  const toggleMax = () => services.view.getState().setMaximized(instance.id, !instance.maximized);
  const close = () => services.view.getState().hideWindow(instance.id);

  return (
    <div
      ref={elRef}
      className={`${styles.window} ${focused ? styles.focused : ''}`}
      style={{ transform: `translate(${rect.x}px, ${rect.y}px)`, width: rect.w, height: rect.h, zIndex: instance.z }}
      onPointerDownCapture={() => services.view.getState().focusWindow(instance.id)}
      data-window-id={instance.id}
      data-window-type={instance.type}
    >
      <div className={styles.titleBar} onPointerDown={(e) => startDrag(e, 'move')} onDoubleClick={toggleMax}>
        <span className={styles.title}>{title}</span>
        <div className={styles.titleButtons}>
          {help && (
            <button
              className={`${styles.titleButton} ${helpOpen ? styles.titleButtonOn : ''}`}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => setHelpOpen((o) => !o)}
              data-hint="How this window works: what it is for, and its mouse and key moves"
              aria-expanded={helpOpen}
            >
              <span className={styles.helpMark}>?</span>
            </button>
          )}
          <button
            className={styles.titleButton}
            onPointerDown={(e) => e.preventDefault()}
            onClick={toggleMax}
            data-hint={instance.maximized ? 'Restore window size' : 'Maximize window'}
          >
            <Icon name={instance.maximized ? 'restore' : 'maximize'} size={11} />
          </button>
          <button
            className={`${styles.titleButton} ${styles.titleClose}`}
            onPointerDown={(e) => e.preventDefault()}
            onClick={close}
            data-hint="Close window"
          >
            <Icon name="close" size={11} />
          </button>
        </div>
      </div>
      <div className={styles.body}>
        <Content windowId={instance.id} props={instance.props} />
        {help && helpOpen && <HelpPanel help={help} onClose={() => setHelpOpen(false)} />}
      </div>
      {!instance.maximized &&
        HANDLES.map((h) => (
          <div key={h} className={`${styles.handle} ${styles[`h_${h}`]}`} onPointerDown={(e) => startDrag(e, h)} />
        ))}
    </div>
  );
});

/** The window's how-to, over its content (Escape or the × closes it). */
function HelpPanel({ help, onClose }: { help: WindowHelp; onClose(): void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className={styles.helpPanel} role="note" onPointerDown={(e) => e.stopPropagation()}>
      <button className={styles.helpClose} onClick={onClose} data-hint="Close this help (Esc)">
        <Icon name="close" size={11} />
      </button>
      <p className={styles.helpIntro}>{help.intro}</p>
      <table className={styles.helpMoves}>
        <tbody>
          {help.moves.map(([how, what]) => (
            <tr key={how}>
              <td>{how}</td>
              <td>{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
