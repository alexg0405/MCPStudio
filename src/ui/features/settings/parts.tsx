import type { ReactNode } from 'react';
import styles from './Settings.module.css';

export function Section({ title, intro, children }: { title: string; intro?: string; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <h3 className={styles.heading}>{title}</h3>
      {intro && <p className={styles.intro}>{intro}</p>}
      {children}
    </section>
  );
}

/** `hint` is the explanation under the row; a plain-text one also shows in the hint bar when you point at the row. */
export function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.row} data-hint={typeof hint === 'string' ? hint : undefined}>
      <div className={styles.label}>{label}</div>
      <div className={styles.control}>
        <div className={styles.inline}>{children}</div>
        {hint && <div className={styles.hint}>{hint}</div>}
      </div>
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange(): void; label: string }) {
  return (
    <label className={styles.switch}>
      <input type="checkbox" checked={checked} onChange={onChange} />
      <span>{label}</span>
    </label>
  );
}
