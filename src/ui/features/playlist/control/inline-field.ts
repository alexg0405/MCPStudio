/** The small text field that appears over a track name or a marker flag to rename it. */

/**
 * Shows `input` (already placed by the caller) with `currentValue` selected. Enter or leaving the field keeps what was
 * typed (`onDone` gets it); Esc drops it. The field hides itself either way and stops its keys reaching shortcuts.
 */
export function editInline(input: HTMLInputElement, currentValue: string, onDone: (typedValue: string) => void): void {
  input.style.display = 'block';
  input.value = currentValue;
  input.focus();
  input.select();
  const finish = (save: boolean): void => {
    input.style.display = 'none';
    input.onblur = null;
    input.onkeydown = null;
    if (save) onDone(input.value);
  };
  input.onblur = () => finish(true);
  input.onkeydown = (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') finish(true);
    if (event.key === 'Escape') finish(false);
  };
}
