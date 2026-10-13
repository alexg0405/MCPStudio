import { useState } from 'react';
import { PALETTE } from '@core/model/defaults';
import type { PatternId } from '@core/model/types';
import { setPatternProps } from '@core/ops/playlist';
import { cloneCurrentPattern, deletePattern, newPattern, renamePattern } from '@app/actions/patterns';
import { useDoc, useServices, useView } from '../../services-context';
import { showContextMenu, type MenuEntry } from '../../controls/ContextMenu';
import styles from './PatternPicker.module.css';

/** FL's pattern selector: shows the current pattern; click for the pattern list and actions. */
export function PatternPicker({ compact = false }: { compact?: boolean }) {
  const services = useServices();
  const currentId = useView((v) => v.currentPatternId);
  const current = useDoc((p) => (currentId ? p.patterns[currentId] : undefined));
  const order = useDoc((p) => p.patternOrder);
  const patterns = useDoc((p) => p.patterns);
  const [renaming, setRenaming] = useState(false);

  const open = (e: React.MouseEvent) => {
    const items: MenuEntry[] = order.map((id) => ({
      label: patterns[id]?.name ?? '?',
      checked: id === currentId,
      onSelect: () => services.view.getState().setCurrentPattern(id as PatternId),
    }));
    items.push(
      { kind: 'separator' },
      { label: 'New pattern', shortcut: 'F4', onSelect: () => void newPattern(services) },
      { label: 'Clone pattern', onSelect: () => void cloneCurrentPattern(services) },
      { label: 'Rename…', onSelect: () => setRenaming(true) },
    );
    if (currentId) {
      items.push({
        kind: 'swatches',
        colors: PALETTE,
        ...(current ? { selected: current.color } : {}),
        onSelect: (color) =>
          services.history.transact('Pattern color', (d) => setPatternProps(d, currentId, { color })),
      });
      items.push({
        label: 'Delete pattern',
        danger: true,
        disabled: order.length <= 1,
        onSelect: () => deletePattern(services, currentId),
      });
    }
    showContextMenu(e, items);
  };

  if (renaming && current && currentId) {
    return (
      <input
        className={`${styles.picker} ${styles.input}`}
        autoFocus
        defaultValue={current.name}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => {
          setRenaming(false);
          const name = e.currentTarget.value.trim();
          if (name && name !== current.name) renamePattern(services, currentId, name);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            e.currentTarget.value = current.name;
            e.currentTarget.blur();
          }
        }}
      />
    );
  }

  return (
    <button
      tabIndex={-1}
      className={`${styles.picker} ${compact ? styles.compact : ''}`}
      style={{ ['--pat-color' as string]: current?.color ?? '#888' }}
      onPointerDown={(e) => e.preventDefault()}
      onClick={open}
      onDoubleClick={() => setRenaming(true)}
      data-hint="Current pattern. Click to switch or add patterns (F4 = new); double-click to rename"
    >
      <span className={styles.swatch} />
      <span className={styles.name}>{current?.name ?? 'No pattern'}</span>
      <span className={styles.caret}>▾</span>
    </button>
  );
}
