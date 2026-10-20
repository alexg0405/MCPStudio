import type { ReactNode } from 'react';
import styles from './table-editor.module.css';

/** A small text button of the table editor. */
export function Button({
  children,
  hint,
  onClick,
  disabled,
}: {
  children: ReactNode;
  hint: string;
  onClick(): void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={styles.button}
      disabled={disabled}
      onClick={onClick}
      data-hint={hint}
    >
      {children}
    </button>
  );
}

/** A drop-down of `[value, text]` options that hands back the picked value with its real type (number or string). */
export function Pick<T extends number | string>({
  value,
  options,
  label,
  hint,
  onChange,
}: {
  value: T;
  options: readonly (readonly [T, string])[];
  label: string;
  hint: string;
  onChange(value: T): void;
}) {
  return (
    <select
      className={styles.select}
      value={String(value)}
      aria-label={label}
      data-hint={hint}
      onChange={(e) => {
        const picked = options.find(([optionValue]) => String(optionValue) === e.target.value);
        if (picked) onChange(picked[0]);
      }}
    >
      {options.map(([optionValue, text]) => (
        <option key={String(optionValue)} value={String(optionValue)}>
          {text}
        </option>
      ))}
    </select>
  );
}

/** Saves bytes as a WAV file through the browser's download. */
export function downloadWav(bytes: Uint8Array, fileName: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'audio/wav' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  // Give the browser a moment to start the download before the address is dropped.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
