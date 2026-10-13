import { useLayoutEffect, useRef, useState } from 'react';
import type { Size } from '@core/time/geometry';
import { useServices, useView } from '../services-context';
import { FloatingWindow } from './FloatingWindow';
import { workspaceSize } from './layouts';
import styles from './Workspace.module.css';

/** The area holding FL-style floating windows. */
export function Workspace() {
  const services = useServices();
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  const windows = useView((s) => s.windows);
  const focusedId = useView((s) => s.focusedId);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      workspaceSize.w = Math.round(width);
      workspaceSize.h = Math.round(height);
      setSize((prev) =>
        prev.w === Math.round(width) && prev.h === Math.round(height)
          ? prev
          : { w: Math.round(width), h: Math.round(height) },
      );
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={styles.workspace}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) services.view.getState().focusWindow(null);
      }}
    >
      {size.w > 0 &&
        Object.values(windows)
          .filter((w) => w.visible)
          .map((w) => <FloatingWindow key={w.id} instance={w} workspace={size} focused={w.id === focusedId} />)}
    </div>
  );
}
