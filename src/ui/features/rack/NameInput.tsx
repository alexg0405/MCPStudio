import styles from './Rack.module.css';

/** A name being edited in place: Enter or leaving the field keeps it, Escape puts the old one back. */
export function NameInput({ initialName, label, onDone }: { initialName: string; label: string; onDone(newName: string): void }) {
  return (
    <input
      className={styles.rename}
      autoFocus
      defaultValue={initialName}
      aria-label={label}
      data-hint={`${label}. Enter keeps it, Escape leaves it as it was`}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={(event) => onDone(event.currentTarget.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          event.currentTarget.value = initialName;
          event.currentTarget.blur();
        }
      }}
    />
  );
}
