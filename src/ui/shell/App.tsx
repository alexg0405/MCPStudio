import { useEffect } from 'react';
import { useServices, useSession } from '../services-context';
import { Workspace } from '../workspace/Workspace';
import { Browser } from './Browser';
import { Toolbar } from './Toolbar';
import styles from './Shell.module.css';

/** Shows the `data-hint` of whatever the pointer is over in the hint bar (FL's hint panel). */
function useHintTracking() {
  const services = useServices();
  useEffect(() => {
    const onOver = (e: PointerEvent) => {
      const el = (e.target as Element | null)?.closest?.('[data-hint]');
      services.session.getState().setHint(el?.getAttribute('data-hint') ?? '');
    };
    document.addEventListener('pointerover', onOver);
    return () => document.removeEventListener('pointerover', onOver);
  }, [services]);
}

function Toasts() {
  const services = useServices();
  const toasts = useSession((s) => s.toasts);
  return (
    <div className={styles.toasts}>
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`${styles.toast} ${t.kind === 'error' ? styles.toastError : ''}`}
          onClick={() => services.session.getState().dismissToast(t.id)}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function App() {
  useHintTracking();
  return (
    <div className={styles.app}>
      <Toolbar />
      <Browser />
      <main>
        <Workspace />
      </main>
      <Toasts />
    </div>
  );
}
