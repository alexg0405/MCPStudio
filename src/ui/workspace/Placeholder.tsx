import { Icon, type IconName } from '../controls/Icon';
import styles from './Placeholder.module.css';

/** Empty-state body for windows whose real content arrives in a later milestone. */
export function Placeholder({ icon, title, text }: { icon: IconName; title: string; text: string }) {
  return (
    <div className={styles.placeholder}>
      <Icon name={icon} size={28} />
      <div className={styles.title}>{title}</div>
      <div className={styles.text}>{text}</div>
    </div>
  );
}
