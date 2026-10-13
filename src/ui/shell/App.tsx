import { useEffect, useSyncExternalStore } from 'react';
import { HINT_EVENT } from '@agstudio/sdk/ui';
import { ContextMenuHost } from '../controls/ContextMenu';
import { HostParamMenus } from '../HostParamMenus';
import { FormDialogHost } from '../controls/FormDialog';
import { DialogHost } from '../controls/Dialog';
import { useServices, useSession } from '../services-context';
import { Workspace } from '../workspace/Workspace';
import { Browser } from './Browser';
import { HoverTip } from './HoverTip';
import { Toolbar } from './Toolbar';
import { getOverlays, overlaysVersion, subscribeOverlays } from './overlays';
import styles from './Shell.module.css';

/** Shows the `data-hint` of whatever the pointer is over in the hint bar (FL's hint panel). */
function useHintTracking() {
  const services = useServices();
  useEffect(() => {
    const onOver = (e: PointerEvent) => {
      const el = (e.target as Element | null)?.closest?.('[data-hint]');
      services.session.getState().setHint(el?.getAttribute('data-hint') ?? '');
    };
    // Controls report live values while dragging ("Volume 82%").
    const onHint = (e: Event) => services.session.getState().setHint(String((e as CustomEvent).detail ?? ''));
    document.addEventListener('pointerover', onOver);
    document.addEventListener(HINT_EVENT, onHint);
    return () => {
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener(HINT_EVENT, onHint);
    };
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

function Overlays() {
  useSyncExternalStore(subscribeOverlays, overlaysVersion);
  return (
    <>
      {getOverlays().map(([id, Overlay]) => (
        <Overlay key={id} />
      ))}
    </>
  );
}

export function App() {
  useHintTracking();
  return (
    <HostParamMenus>
      <div className={styles.app}>
        <Toolbar />
        <Browser />
        <main>
          <Workspace />
        </main>
        <Toasts />
        <ContextMenuHost />
        <Overlays />
        <DialogHost />
        <FormDialogHost />
        <HoverTip />
      </div>
    </HostParamMenus>
  );
}
