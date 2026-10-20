import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { FILTERS, lengthNote, type FilterPreset } from '@core/filters/presets';
import { holdModal } from '../../controls/Dialog';
import { useDialogFocus } from '../../controls/dialog-focus';
import dialog from '../../controls/Dialog.module.css';
import { useServices } from '../../services-context';
import { filterStore } from './filter-store';
import { runFilter, targetChoices } from './run';
import styles from './FilterDialog.module.css';

/** Overlay host: renders the chooser while it is open. */
export function FilterOverlay() {
  const open = useStore(filterStore, (s) => s.open);
  return open ? <FilterDialog start={open.filter} /> : null;
}

const close = () => filterStore.setState({ open: null });

const GROUPS: { id: FilterPreset['group']; label: string }[] = [
  { id: 'speed', label: 'Speed and pitch (like a record: faster is higher)' },
  { id: 'tone', label: 'Tone (the timing stays the same)' },
];

/** The filter chooser: a part of the song and a filter, each with a plain description. */
function FilterDialog({ start }: { start: string | undefined }) {
  const s = useServices();
  const choices = useMemo(() => targetChoices(s), [s]);
  const [where, setWhere] = useState(0);
  const [chosen, setChosen] = useState(() => FILTERS.find((f) => f.id === start)?.id ?? FILTERS[0]!.id);
  const ref = useRef<HTMLDivElement>(null);
  const filter = FILTERS.find((f) => f.id === chosen) ?? FILTERS[0]!;
  const target = choices[where]?.target ?? null;

  const apply = () => {
    close();
    void runFilter(s, chosen, target);
  };

  useDialogFocus(ref);
  useEffect(() => {
    const release = holdModal();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      release();
    };
  }, []);

  return (
    <div className={dialog.backdrop} onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={ref}
        tabIndex={-1}
        className={`${dialog.dialog} ${styles.chooser}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ag-filter-title"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && target && !(e.target instanceof HTMLButtonElement)) {
            e.preventDefault();
            apply();
          }
        }}
      >
        <h2 id="ag-filter-title" className={dialog.title}>
          Apply a filter
        </h2>
        {choices.length === 0 ? (
          <p className={dialog.message}>The playlist is empty: put a pattern or audio on it first, then filter a part of it.</p>
        ) : (
          <>
            <label className={styles.where} data-hint="Which part of the song the filter replaces">
              <span>Apply to</span>
              <select value={where} onChange={(e) => setWhere(Number(e.target.value))}>
                {choices.map((c, i) => (
                  <option key={i} value={i}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <FilterPicker
              chosen={chosen}
              onChoose={setChosen}
              onApplyNow={(id) => {
                setChosen(id);
                close();
                void runFilter(s, id, target);
              }}
            />
            <p className={dialog.message}>
              <strong>{filter.name}</strong>: {filter.description}.
            </p>
            <p className={dialog.detail}>
              {lengthNote(filter)} The part is rendered to audio; Undo or right-click › Remove filter brings the original
              back.
            </p>
          </>
        )}
        <div className={dialog.buttons}>
          <button className={dialog.button} onClick={close} data-hint="Close without changing anything">
            Cancel
          </button>
          <button
            className={`${dialog.button} ${dialog.primary}`}
            disabled={!target}
            onClick={apply}
            data-hint="Render the part and play it through the filter (one undo step)"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

/** The filters in their groups: click one to choose it, double-click to apply it at once. */
function FilterPicker({ chosen, onChoose, onApplyNow }: { chosen: string; onChoose(id: string): void; onApplyNow(id: string): void }) {
  return (
    <>
      {GROUPS.map((g) => (
        <fieldset key={g.id} className={styles.group}>
          <legend>{g.label}</legend>
          <div className={styles.list} role="radiogroup">
            {FILTERS.filter((f) => f.group === g.id).map((f) => (
              <button
                key={f.id}
                type="button"
                role="radio"
                aria-checked={f.id === chosen}
                className={`${styles.item} ${f.id === chosen ? styles.on : ''}`}
                data-hint={`${f.name}: ${f.description}`}
                onClick={() => onChoose(f.id)}
                onDoubleClick={() => onApplyNow(f.id)}
              >
                {f.name}
              </button>
            ))}
          </div>
        </fieldset>
      ))}
    </>
  );
}
