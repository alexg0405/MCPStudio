import { Fragment } from 'react';
import { targetKey } from '@core/model/targets';
import { RACK_GAIN_SPEC, MIX_SPEC, CROSSOVER_SPEC } from '@core/rack/mapping';
import { branchCountRange, isRackSlot } from '@core/model/rack';
import type { FxSlot, InsertId, Rack, RackSplit, SlotId } from '@core/model/types';
import { setPluginParam } from '@core/ops/channels';
import { setFxSlotMix } from '@core/ops/mixer';
import { addBranch, setCrossover, setRackSplit } from '@core/ops/racks';
import { insertLabel } from '@core/query/mixer';
import { audibleBranches } from '@core/query/rack';
import { toggleEffect } from '@app/actions/mixer';
import { ungroupSlot } from '@app/actions/racks';
import { Knob } from '@agstudio/sdk/ui';
import { useGestureEdit } from '../../edit';
import { showContextMenu } from '../../controls/ContextMenu';
import { useDoc, useServices } from '../../services-context';
import type { WindowContentProps } from '../../workspace/registry';
import { BranchColumn } from './BranchColumn';
import { MacroPanel } from './MacroPanel';
import { mapToMacroEntries } from './map-menu';
import { exportRackSlot, saveRackDialog } from './rack-dialogs';
import styles from './Rack.module.css';

/** What a rack window is opened with: the track and the rack's slot. */
export interface RackWindowProps {
  insertId: InsertId;
  slotId: SlotId;
}

const SPLITS: readonly { id: RackSplit; label: string; hint: string }[] = [
  { id: 'parallel', label: 'Parallel', hint: 'Every branch hears the whole sound and the branches add up. An empty branch is the dry sound' },
  { id: 'bands', label: 'Frequency bands', hint: 'Crossovers cut the sound into bands (lows, mids, highs), one band per branch; they add up flat' },
  { id: 'midside', label: 'Mid / side', hint: 'The first branch hears what both sides share (the mid), the second what differs between them (the side)' },
  { id: 'leftright', label: 'Left / right', hint: 'The first branch hears the left channel, the second the right one' },
];

function RackHeader({ insertId, slot }: { insertId: InsertId; slot: FxSlot & { rack: Rack } }) {
  const services = useServices();
  const label = useDoc((project) => insertLabel(project, insertId));
  const owner = { kind: 'fx', insertId, slotId: slot.id } as const;
  const mix = useGestureEdit<number>('Rack dry/wet', (draft, value) => setFxSlotMix(draft, insertId, slot.id, value), `fxmix:${slot.id}`);
  const rawGain = slot.plugin.params.gain;
  const output = useGestureEdit<number>('Rack output', (draft, value) => setPluginParam(draft, owner, 'gain', value), `rackgain:${slot.id}`);
  const { rack } = slot;
  const range = branchCountRange(rack.split);

  const menu = (event: { clientX: number; clientY: number }) =>
    showContextMenu(event, [
      { label: 'Save as my rack…', onSelect: () => void saveRackDialog(services, insertId, slot.id), hint: 'Keep this rack, with its settings and macros, in your racks (browser and Add menu)' },
      { label: 'Export as a file…', onSelect: () => exportRackSlot(services, insertId, slot.id), hint: 'Download it as a .agrack file to share or keep' },
      { kind: 'separator' },
      {
        label: 'Add branch',
        disabled: rack.branches.length >= range.max,
        hint: rack.branches.length >= range.max ? `A ${rack.split} rack has at most ${range.max} branch${range.max === 1 ? '' : 'es'}` : 'A new empty branch',
        onSelect: () => services.history.transact('Add branch', (d) => void addBranch(d, insertId, slot.id)),
      },
      { kind: 'separator' },
      {
        label: 'Ungroup',
        hint: 'Take the rack apart: its effects go back on the track in its place (branches become one chain; macros are lost)',
        onSelect: () => void ungroupSlot(services, insertId, slot.id),
      },
    ]);

  return (
    <div className={styles.header} role="group" aria-label="Rack settings">
      <button
        className={`${styles.led} ${slot.enabled ? styles.ledOn : ''}`}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => toggleEffect(services, insertId, slot.id)}
        aria-label="Enable the rack"
        aria-pressed={slot.enabled}
        data-hint={`The rack is ${slot.enabled ? 'on' : 'bypassed (the sound passes through untouched)'}. Click to ${slot.enabled ? 'bypass' : 'turn it on'}`}
      />
      <span className={styles.title}>Rack · {label}</span>
      <label className={styles.field}>
        Split
        <select
          className={styles.select}
          value={rack.split}
          aria-label="How the rack splits the sound"
          data-hint={SPLITS.find((split) => split.id === rack.split)?.hint ?? 'How the rack splits the sound'}
          onChange={(e) => services.history.transact('Change rack split', (d) => void setRackSplit(d, insertId, slot.id, e.currentTarget.value as RackSplit))}
        >
          {SPLITS.map((split) => (
            <option key={split.id} value={split.id}>
              {split.label}
            </option>
          ))}
        </select>
      </label>
      <span className={styles.field}>
        <Knob spec={MIX_SPEC} value={slot.mix} size={24} label="Rack dry/wet" param={targetKey({ kind: 'slot', insertId, slotId: slot.id, param: 'mix' })} {...mix} />
        Dry/wet
      </span>
      <span className={styles.field}>
        <Knob
          spec={RACK_GAIN_SPEC}
          value={typeof rawGain === 'number' ? rawGain : 0}
          size={24}
          label="Rack output"
          param={targetKey({ kind: 'plugin', owner, paramId: 'gain' })}
          {...output}
        />
        Output
      </span>
      <button className={styles.button} onClick={(event) => menu(event)} aria-haspopup="menu" aria-label="Rack menu" data-hint="Save or export this rack, add a branch, or take it apart">
        ⋯
      </button>
    </div>
  );
}

/** The crossover between two bands: a log knob in Hz that a macro can move. */
function Crossover({ insertId, slot, index }: { insertId: InsertId; slot: FxSlot & { rack: Rack }; index: number }) {
  const services = useServices();
  const hz = slot.rack.crossovers[index] ?? CROSSOVER_SPEC.default;
  const edit = useGestureEdit<number>('Crossover', (draft, value) => void setCrossover(draft, insertId, slot.id, index, value), `crossover:${slot.id}:${index}`);
  const names = slot.rack.branches;
  return (
    <div
      className={styles.crossover}
      onContextMenu={(event) => {
        event.preventDefault();
        showContextMenu(event, [{ kind: 'label', label: `Crossover ${index + 1}` }, ...mapToMacroEntries(services, insertId, slot.id, { kind: 'crossover', index })]);
      }}
    >
      <Knob spec={CROSSOVER_SPEC} value={hz} size={26} label={`Crossover between ${names[index]?.name} and ${names[index + 1]?.name}`} {...edit} />
      <span aria-hidden>Split {index + 1}</span>
    </div>
  );
}

/** The editor of one rack: its split, macros and branches of effects. */
function RackEditor({ insertId, slot }: { insertId: InsertId; slot: FxSlot & { rack: Rack } }) {
  const services = useServices();
  const { rack } = slot;
  const audible = audibleBranches(rack);
  const range = branchCountRange(rack.split);
  const hasEffects = rack.branches.some((branch) => branch.fx.length > 0);
  return (
    <div className={styles.window}>
      <RackHeader insertId={insertId} slot={slot} />
      <MacroPanel insertId={insertId} slot={slot} />
      <div className={styles.branches} role="group" aria-label="Branches of the rack" data-roving="grid">
        {rack.branches.map((branch, index) => (
          <Fragment key={branch.id}>
            {rack.split === 'bands' && index > 0 && <Crossover insertId={insertId} slot={slot} index={index - 1} />}
            <BranchColumn insertId={insertId} slot={slot} branch={branch} index={index} isAudible={audible.has(branch.id)} />
          </Fragment>
        ))}
        {rack.branches.length < range.max && (
          <button
            className={styles.addBranch}
            onClick={() => services.history.transact('Add branch', (d) => void addBranch(d, insertId, slot.id))}
            aria-label="Add a branch"
            data-hint={rack.split === 'bands' ? 'Add a band at the top (a new crossover is made)' : 'Add an empty branch next to the others'}
          >
            + Branch
          </button>
        )}
      </div>
      {!hasEffects && (
        <p className={styles.hintLine} style={{ padding: '0 12px 10px' }}>
          This rack is empty. Add effects to a branch (the + Add effect button, or drag one here from the browser), then map the macros to the settings you want
          to move together. Choose Parallel with a second branch for parallel compression, Frequency bands to treat lows, mids and highs apart, or Mid / side to
          widen.
        </p>
      )}
    </div>
  );
}

/** The rack window: opens from a rack slot in the mixer (double-click) or the browser's Racks. */
export function RackWindow({ props }: WindowContentProps) {
  const { insertId, slotId } = (props ?? {}) as Partial<RackWindowProps>;
  const slot = useDoc((project) => (insertId && slotId ? project.mixer.inserts[insertId]?.fx.find((candidate) => candidate.id === slotId) : undefined));
  if (!insertId || !slot || !isRackSlot(slot)) {
    return (
      <div className={styles.gone}>
        This rack is not on a track any more. Racks are opened by double-clicking one in a mixer track’s effects, or from the Racks section of the browser.
      </div>
    );
  }
  return <RackEditor insertId={insertId} slot={slot} />;
}
