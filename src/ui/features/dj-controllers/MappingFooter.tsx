import { djControllers, pickMappingFile, saveMappingFile } from '@app/dj/controllers';
import { CONTROLLER_PRESETS, type ControllerPreset } from '@core/midi-map/presets';
import type { ControllerMapping } from '@core/midi-map/types';
import { useServices } from '../../services-context';
import styles from './Controllers.module.css';

/** The bottom bar of a controller's map: pick-up and light options, ready-made maps, export, import, reset. */
export function MappingFooter({ device, mapping, preset }: { device: string; mapping: ControllerMapping; preset: ControllerPreset | null }) {
  const services = useServices();
  const dj = djControllers(services);

  /** Loads a map file picked by the musician and says how it went. */
  const importMap = async () => {
    const text = await pickMappingFile();
    if (text === null) return;
    const result = dj.importJson(device, text);
    const skipped = result?.dropped ? ` (${result.dropped} entries were not understood and skipped)` : '';
    services.session
      .getState()
      .toast(result ? `Imported ${result.bindings} links${skipped}.` : 'That file is not a controller map.', result ? 'info' : 'error');
  };

  return (
    <div className={styles.footer}>
      <label className={styles.check} data-hint="Faders and knobs wait until they reach the value on screen, so nothing jumps when you touch one that is somewhere else">
        <input type="checkbox" checked={mapping.softTakeover} onChange={(e) => dj.setOptions(device, { softTakeover: e.target.checked })} />
        Pick up values (no jumps)
      </label>
      <label className={styles.check} data-hint="Light a button’s own light at the note it sends (for learned controllers; ready-made maps list their lights)">
        <input type="checkbox" checked={mapping.ledFromButtons} onChange={(e) => dj.setOptions(device, { ledFromButtons: e.target.checked })} />
        Lights at button notes
      </label>
      <span className={styles.spacer} />
      <select
        className={styles.select}
        value=""
        onChange={(e) => {
          if (e.target.value) dj.usePreset(device, e.target.value);
        }}
        aria-label="Use a ready-made map"
        data-hint="Replace this controller’s links with a ready-made map"
      >
        <option value="">Use a ready-made map…</option>
        {CONTROLLER_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <button className={styles.small} onClick={() => saveMappingFile(device, dj.exportJson(device))} data-hint="Save this controller’s links as a file you can share or keep">
        Export…
      </button>
      <button className={styles.small} onClick={() => void importMap()} data-hint="Load links from a controller map file (replaces the current ones)">
        Import…
      </button>
      <button className={styles.small} onClick={() => dj.resetMapping(device)} data-hint={preset ? 'Go back to the ready-made map' : 'Remove every link'}>
        {preset ? 'Reset' : 'Clear all'}
      </button>
      {preset && (
        <button className={styles.small} onClick={() => dj.clearMapping(device)} data-hint="Remove every link, to learn from scratch">
          Clear all
        </button>
      )}
    </div>
  );
}
