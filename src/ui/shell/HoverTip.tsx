import { useEffect, useRef } from 'react';
import { useServices } from '../services-context';
import { installHoverTip } from './hover-tip';
import styles from './Shell.module.css';

/**
 * Tooltips for everything that has a `data-hint`: hover a control for a moment and its hint appears next to it (the behaviour
 * is in `hover-tip.ts`, imperative, so hovering never re-renders the app). They can be turned off in the settings.
 */
export function HoverTip() {
  const services = useServices();
  const tipRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const tip = tipRef.current;
    if (!tip) return;
    return installHoverTip(tip, styles.tipLive!, () => services.prefs.getState().tooltips);
  }, [services]);
  return <div ref={tipRef} className={styles.tip} role="tooltip" hidden />;
}
