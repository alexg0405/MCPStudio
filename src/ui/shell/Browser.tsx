import { useEffect, useState, type ComponentType, type PointerEvent as ReactPointerEvent } from 'react';
import { useServices, useView } from '../services-context';
import { Icon, type IconName } from '../controls/Icon';
import styles from './Browser.module.css';

/** Browser sidebar sections are contributed by features (plugins, sounds, sample folder, project). */
export interface BrowserSection {
  id: string;
  title: string;
  icon: IconName;
  order: number;
  component: ComponentType;
  defaultOpen?: boolean;
}

const sections = new Map<string, BrowserSection>();
const listeners = new Set<() => void>();

export function addBrowserSection(section: BrowserSection): () => void {
  sections.set(section.id, section);
  listeners.forEach((fn) => fn());
  return () => {
    if (sections.get(section.id) === section) sections.delete(section.id);
    listeners.forEach((fn) => fn());
  };
}

function useSections(): BrowserSection[] {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return [...sections.values()].sort((a, b) => a.order - b.order);
}

function Section({ section }: { section: BrowserSection }) {
  const [open, setOpen] = useState(section.defaultOpen ?? true);
  const Body = section.component;
  return (
    <section className={styles.section}>
      <button
        className={styles.sectionHeader}
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        data-hint={`${open ? 'Hide' : 'Show'} ${section.title}`}
      >
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
        <Icon name={section.icon} size={14} />
        <span>{section.title}</span>
      </button>
      {open && (
        <div className={styles.sectionBody}>
          <Body />
        </div>
      )}
    </section>
  );
}

export function Browser() {
  const services = useServices();
  const browser = useView((s) => s.browser);
  const list = useSections();

  if (!browser.visible) return <aside className={styles.hidden} />;

  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = browser.width;
    const move = (ev: PointerEvent) => {
      const w = Math.min(520, Math.max(160, startW + ev.clientX - startX));
      services.view.getState().setBrowser({ width: Math.round(w) });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  return (
    <aside className={styles.browser} style={{ width: browser.width }} data-tour="browser">
      <div className={styles.header}>
        <span>Browser</span>
      </div>
      <div className={styles.scroll}>
        {list.map((s) => (
          <Section key={s.id} section={s} />
        ))}
      </div>
      <div className={styles.resizer} onPointerDown={startResize} data-hint="Drag to resize the browser" />
    </aside>
  );
}
