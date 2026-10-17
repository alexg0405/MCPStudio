import { useCallback, useSyncExternalStore } from 'react';
import { allChains, chainTarget } from '@app/actions/chains';
import { importChainFile, type ChainChoice } from '@app/chains';
import { insertLabel } from '@core/query/mixer';
import { showContextMenu, type MenuEntry } from '../../controls/ContextMenu';
import { useServices } from '../../services-context';
import browser from '../../shell/Browser.module.css';
import { deleteChainDialog, exportChainFile, putChainOn, renameChainDialog, saveChainDialog } from './chain-actions';
import styles from './Presets.module.css';

/**
 * Effect chains in the browser: the factory vocal chains and yours. Click one to put it on the mixer
 * track selected in the mixer (the master when none is); a track with effects is asked once whether to
 * replace them or add after them. Right-click for the other options, export and delete.
 */
export function ChainsSection() {
  const s = useServices();
  const subscribe = useCallback(
    (fn: () => void) => {
      const a = s.presets.subscribe(fn);
      const b = s.plugins.subscribe(fn);
      const c = s.session.subscribe((state, prev) => {
        if (state.selectedInsertId !== prev.selectedInsertId) fn();
      });
      return () => {
        a();
        b();
        c();
      };
    },
    [s],
  );
  useSyncExternalStore(subscribe, () => `${s.presets.getVersion()}:${s.plugins.getVersion()}:${s.session.getState().selectedInsertId ?? ''}`);

  const chains = allChains(s);
  const target = chainTarget(s);
  const where = insertLabel(s.doc.getState().project, target);

  const menu = (e: { clientX: number; clientY: number }, chain: ChainChoice) => {
    const entries: MenuEntry[] = [
      {
        label: `Replace the effects on ${where}`,
        onSelect: () => void putChainOn(s, chain, target, 'replace'),
        hint: 'Take off what the track has and put this chain on it (one undo step)',
      },
      {
        label: `Add after the effects on ${where}`,
        onSelect: () => void putChainOn(s, chain, target, 'append'),
        hint: 'Keep what the track has and put this chain behind it (one undo step)',
      },
      { kind: 'separator' },
      {
        label: 'Export as file…',
        onSelect: () => exportChainFile(chain),
        hint: 'Download this chain as a .agchain file, to share or keep',
      },
    ];
    if (chain.source === 'user')
      entries.push(
        { label: `Rename “${chain.name}”…`, onSelect: () => void renameChainDialog(s, chain) },
        { label: `Delete “${chain.name}”…`, danger: true, onSelect: () => void deleteChainDialog(s, chain) },
      );
    showContextMenu(e, entries);
  };

  return (
    <>
      {chains.map((chain) => (
        <button
          key={`${chain.source}/${chain.id ?? chain.name}`}
          className={browser.item}
          onClick={() => void putChainOn(s, chain, target)}
          onContextMenu={(e) => {
            e.preventDefault();
            menu(e, chain);
          }}
          data-hint={`“${chain.name}”: ${chain.description ?? `${chain.steps.length} effects`} Click to put it on ${where}. Right-click for more.`}
        >
          {chain.source === 'user' && <span className={styles.mine}>★</span>}
          {chain.name}
          <span className={browser.badge}>{chain.steps.length} fx</span>
        </button>
      ))}
      <button
        className={browser.item}
        onClick={() => void saveChainDialog(s, target)}
        data-hint={`Keep the effects on ${where}, with their settings, as a chain of your own`}
      >
        Save {where}’s chain…
      </button>
      <button
        className={browser.item}
        onClick={() => void importChainFile(s)}
        data-hint="Add a .agchain file (a chain someone shared, or one you exported) to your chains"
      >
        Import a chain file…
      </button>
    </>
  );
}
