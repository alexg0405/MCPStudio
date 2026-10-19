import styles from './Mixer.module.css';

/** The name field while renaming: Enter or leaving it keeps the name, Escape puts the old one back. */
export function RenameInput({ initialName, onDone }: { initialName: string; onDone(newName: string): void }) {
  return (
    <input
      className={styles.rename}
      autoFocus
      defaultValue={initialName}
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
