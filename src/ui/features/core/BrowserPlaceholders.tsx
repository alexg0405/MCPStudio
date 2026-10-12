import styles from '../../shell/Browser.module.css';

export function PluginsPlaceholder() {
  return <div className={styles.empty}>Instruments and effects appear here.</div>;
}

export function SoundsPlaceholder() {
  return <div className={styles.empty}>The built-in drum kit arrives in M1.</div>;
}
