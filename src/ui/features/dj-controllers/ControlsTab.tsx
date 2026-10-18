import type { MouseEvent as ReactMouseEvent } from 'react';
import { useStore } from 'zustand';
import { djControllers } from '@app/dj/controllers';
import type { LearnState } from '@app/dj/controllers';
import { bindingsOfTarget } from '@core/midi-map/mapping-edit';
import type { ControllerPreset } from '@core/midi-map/presets';
import { REL_ENCODING_LABEL } from '@core/midi-map/relative';
import type { TargetInfo } from '@core/midi-map/targets';
import type { Binding, ControllerMapping } from '@core/midi-map/types';
import { showContextMenu, type MenuEntry } from '../../controls/ContextMenu';
import { useServices } from '../../services-context';
import styles from './Controllers.module.css';
import { chipText, groupedTargets, rowLabel, type Section } from './view';

/** The speeds a jog wheel or dial can be scaled to (× the normal step). */
const SPEED_CHOICES = [0.5, 1, 2, 4] as const;

/** What the note above the list says about where the current links came from. */
function MapNote({ device, mapping, preset }: { device: string; mapping: ControllerMapping; preset: ControllerPreset | null }) {
  return (
    <div className={styles.note}>
      {preset ? (
        <>
          Ready-made map for {preset.name}. {preset.notes} Source: {preset.source}.
        </>
      ) : mapping.bindings.length ? (
        <>
          Your own map for {device}: {mapping.bindings.length} controls linked.
        </>
      ) : (
        <>No ready-made map for {device}. Press “Learn controls”, click a control below, then move or press it on your controller.</>
      )}
    </div>
  );
}

/** The controls of the decks and mixer, grouped, each with the control of the controller that drives it. */
export function ControlsTab({
  device,
  mapping,
  preset,
  section,
  learning,
}: {
  device: string;
  mapping: ControllerMapping;
  preset: ControllerPreset | null;
  section: Section;
  learning: LearnState | null;
}) {
  const dj = djControllers(useServices());
  return (
    <div className={styles.body}>
      <MapNote device={device} mapping={mapping} preset={preset} />
      <div className={styles.group}>Shift key</div>
      <ShiftRow onLearn={() => dj.learnTarget('shift')} learningTarget={learning?.target ?? null} />
      {groupedTargets(section).map((group) => (
        <div key={group.group}>
          <div className={styles.group}>{group.group}</div>
          {group.targets.map((target) => (
            <TargetRow
              key={target.id}
              target={target}
              device={device}
              isLearningThis={learning?.target === target.id}
              isLearning={!!learning}
              onLearn={(shifted) => dj.learnTarget(target.id, shifted)}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** The row of the Shift button: which control is linked to it, and a Learn button. */
function ShiftRow({ onLearn, learningTarget }: { onLearn(): void; learningTarget: string | null }) {
  const dj = djControllers(useServices());
  const device = useStore(dj.store, (s) => s.selected);
  const shifts = useStore(dj.store, (s) => (device ? (s.mappings[device]?.shifts ?? []) : []));
  return (
    <div className={learningTarget === 'shift' ? styles.rowLearning : styles.row}>
      <span className={styles.rowName} data-hint="The button that changes what other buttons do while you hold it">
        Shift button
      </span>
      <span className={styles.chips}>
        {shifts.length ? (
          shifts.map((shift, i) => (
            <span key={i} className={styles.chip}>
              {chipText({ input: shift.input, target: 'shift' })}
            </span>
          ))
        ) : (
          <span className={styles.unmapped}>not linked (only needed for “with Shift” controls)</span>
        )}
      </span>
      <button className={styles.small} onClick={onLearn} data-hint="Click, then press your controller’s Shift button">
        Learn
      </button>
    </div>
  );
}

/** One control of the decks or mixer: its linked controls (click one for options), Learn, + Shift and Clear. */
function TargetRow({
  target,
  device,
  isLearningThis,
  isLearning,
  onLearn,
}: {
  target: TargetInfo;
  device: string;
  /** This row is the one waiting for a touch. */
  isLearningThis: boolean;
  /** Learn mode is on (a click on the row picks it). */
  isLearning: boolean;
  onLearn(shifted: boolean): void;
}) {
  const dj = djControllers(useServices());
  const mapping = useStore(dj.store, (s) => s.mappings[device]);
  const linked = mapping ? bindingsOfTarget(mapping, target.id) : [];
  const hasShift = (mapping?.shifts.length ?? 0) > 0;

  /** The options of a linked control: reverse, speed, remove. */
  const openLinkMenu = (e: ReactMouseEvent, binding: Binding, index: number) => {
    const items: MenuEntry[] = [];
    if (binding.input.type === 'rel') items.push({ kind: 'label', label: REL_ENCODING_LABEL[binding.input.encoding] });
    if (target.kind !== 'button' && binding.input.type !== 'note') {
      items.push({ label: 'Reverse the direction', checked: !!binding.invert, onSelect: () => dj.updateBinding(device, index, { invert: !binding.invert }) });
    }
    if (binding.input.type === 'rel') {
      for (const speed of SPEED_CHOICES) {
        items.push({ label: `Speed ×${speed}`, checked: (binding.scale ?? 1) === speed, onSelect: () => dj.updateBinding(device, index, { scale: speed }) });
      }
    }
    items.push({ kind: 'separator' }, { label: 'Remove this link', danger: true, onSelect: () => dj.removeBinding(device, index) });
    showContextMenu(e, items);
  };

  const learnAction = target.kind === 'abs' ? 'move the fader or knob' : target.kind === 'rel' ? 'turn the wheel or dial' : 'press the button';
  return (
    <div
      className={isLearningThis ? styles.rowLearning : styles.row}
      data-dj-target={target.id}
      onClick={() => isLearning && !isLearningThis && onLearn(false)}
      data-hint={`${target.hint}. ${isLearning ? 'Click to link it to a control.' : ''}`}
    >
      <span className={styles.rowName}>{rowLabel(target)}</span>
      <span className={styles.chips}>
        {linked.length ? (
          linked.map(({ binding, index }) => (
            <button
              key={index}
              className={styles.chip}
              onClick={(e) => {
                e.stopPropagation();
                openLinkMenu(e, binding, index);
              }}
              data-hint="A control linked to this. Click for options (reverse, speed, remove)"
            >
              {chipText(binding)}
            </button>
          ))
        ) : (
          <span className={styles.unmapped}>not linked</span>
        )}
      </span>
      <button
        className={styles.small}
        onClick={(e) => {
          e.stopPropagation();
          onLearn(false);
        }}
        data-hint={`Click, then ${learnAction} on your controller`}
      >
        Learn
      </button>
      <button
        className={styles.small}
        onClick={(e) => {
          e.stopPropagation();
          onLearn(true);
        }}
        disabled={!hasShift}
        data-hint={hasShift ? 'Learn what this control does while the Shift button is held' : 'Link the Shift button first (the “Shift button” row)'}
      >
        + Shift
      </button>
      <button
        className={styles.small}
        onClick={(e) => {
          e.stopPropagation();
          dj.clearTarget(device, target.id);
        }}
        disabled={linked.length === 0}
        data-hint="Remove the links of this control"
      >
        Clear
      </button>
    </div>
  );
}
