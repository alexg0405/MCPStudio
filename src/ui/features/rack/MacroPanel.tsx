import { memo, useState } from 'react';
import { macroParamId } from '@core/model/rack';
import type { FxSlot, InsertId, MacroCurve, MacroMapping, Rack } from '@core/model/types';
import { setPluginParam } from '@core/ops/channels';
import { removeMacroMapping, renameMacro, setMacroMapping } from '@core/ops/racks';
import { describeMacroTarget } from '@core/query/rack';
import { targetKey } from '@core/model/targets';
import { macroTargetSpec } from '@app/racks/targets';
import { decode, encode, formatValue, p, type ParamSpec } from '@agstudio/sdk';
import { Knob } from '@agstudio/sdk/ui';
import { useGestureEdit } from '../../edit';
import { useServices } from '../../services-context';
import { NameInput } from './NameInput';
import styles from './Rack.module.css';

const MACRO = p.float(0, 1, 0, { label: 'Macro', unit: '%' });
const CURVES: readonly { id: MacroCurve; label: string; hint: string }[] = [
  { id: 'linear', label: 'Linear', hint: 'The knob and the setting move together' },
  { id: 'exponential', label: 'Exponential', hint: 'Slow at first, faster toward the end of the knob' },
  { id: 'inverted', label: 'Inverted', hint: 'Backwards: turning the knob up turns the setting down' },
];

interface MacroKnobProps {
  insertId: InsertId;
  slot: FxSlot & { rack: Rack };
  index: number;
  isSelected: boolean;
  onSelect(index: number): void;
}

/** One macro: its knob (automatable, MIDI-learnable like any setting), its name (double-click to rename) and how many things it moves. */
const MacroKnob = memo(function MacroKnob({ insertId, slot, index, isSelected, onSelect }: MacroKnobProps) {
  const services = useServices();
  const [isRenaming, setIsRenaming] = useState(false);
  const macro = slot.rack.macros[index] as Rack['macros'][number];
  const paramId = macroParamId(index);
  const raw = slot.plugin.params[paramId];
  const value = typeof raw === 'number' ? raw : 0;
  const owner = { kind: 'fx', insertId, slotId: slot.id } as const;
  const edit = useGestureEdit<number>(`Macro ${index + 1}`, (draft, v) => setPluginParam(draft, owner, paramId, v), `macro:${slot.id}:${index}`);
  const count = macro.mappings.length;
  return (
    <div className={`${styles.macro} ${isSelected ? styles.macroSelected : ''}`} role="group" aria-label={`Macro ${index + 1}, ${macro.name}`}>
      <Knob
        spec={MACRO}
        value={value}
        size={34}
        label={`${macro.name}`}
        accessibleName={`Macro ${index + 1}: ${macro.name}`}
        param={targetKey({ kind: 'plugin', owner, paramId })}
        hint={count ? `Moves ${count} thing${count === 1 ? '' : 's'} in the rack` : 'Moves nothing yet: right-click a setting in the rack and choose Map to macro'}
        {...edit}
      />
      {isRenaming ? (
        <NameInput
          initialName={macro.name}
          label={`Name of macro ${index + 1}`}
          onDone={(name) => {
            setIsRenaming(false);
            if (name.trim() && name.trim() !== macro.name) services.history.transact('Rename macro', (d) => void renameMacro(d, insertId, slot.id, index, name));
          }}
        />
      ) : (
        <button
          className={styles.macroName}
          onClick={() => onSelect(index)}
          onDoubleClick={() => setIsRenaming(true)}
          onKeyDown={(event) => {
            if (event.key === 'F2') setIsRenaming(true);
          }}
          aria-label={`Macro ${index + 1}: ${macro.name}. Shows what it moves`}
          aria-pressed={isSelected}
          data-hint={`Macro ${index + 1} “${macro.name}”. Click to see what it moves; double-click (or F2) to rename it`}
        >
          {macro.name}
        </button>
      )}
      <button
        className={`${styles.macroMore} ${count ? '' : styles.macroMoreNone}`}
        onClick={() => onSelect(index)}
        aria-label={`Macro ${index + 1} moves ${count} thing${count === 1 ? '' : 's'}`}
        data-hint={count ? `Moves ${count} thing${count === 1 ? '' : 's'}: click to see and change them` : 'Moves nothing yet'}
      >
        {count ? `◆ ${count}` : '–'}
      </button>
    </div>
  );
});

/** Numbers in the unit people read: a 0–1 setting shown as a percentage. */
const shown = (spec: ParamSpec, value: number): number => (spec.type !== 'bool' && spec.type !== 'enum' && spec.unit === '%' ? Math.round(value * 1000) / 10 : Math.round(value * 1000) / 1000);
const fromShown = (spec: ParamSpec, text: number): number => (spec.type !== 'bool' && spec.type !== 'enum' && spec.unit === '%' ? text / 100 : text);

/** One end of a mapping's range, in the target's own kind of input: a number, a choice or a switch. */
function RangeEnd({ spec, value, label, onChange }: { spec: ParamSpec; value: number; label: string; onChange(value: number): void }) {
  if (spec.type === 'enum' || spec.type === 'bool') {
    const options = spec.type === 'enum' ? spec.options.map((option) => ({ id: option, label: (spec.labels as Record<string, string> | undefined)?.[option] ?? option })) : [{ id: 'false', label: 'Off' }, { id: 'true', label: 'On' }];
    const current = String(decode(spec, value));
    return (
      <select className={styles.select} aria-label={label} data-hint={label} value={current} onChange={(e) => onChange(encode(spec, spec.type === 'bool' ? e.currentTarget.value === 'true' : e.currentTarget.value))}>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }
  const unit = spec.unit === '%' ? '%' : spec.unit ? ` ${spec.unit}` : '';
  return (
    <span className={styles.field}>
      <input
        key={value}
        className={styles.number}
        type="number"
        step="any"
        defaultValue={shown(spec, value)}
        aria-label={label}
        data-hint={`${label}${unit ? ` (in${unit})` : ''}. Now ${formatValue(spec, decode(spec, value))}. Enter keeps it`}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
        onBlur={(event) => {
          const text = Number.parseFloat(event.currentTarget.value);
          if (Number.isFinite(text)) onChange(fromShown(spec, text));
        }}
      />
      {unit && <span aria-hidden>{unit.trim()}</span>}
    </span>
  );
}

/** What the selected macro moves: each target with the range it sweeps and the curve, and a way to let go. */
function MappingList({ insertId, slot, index }: { insertId: InsertId; slot: FxSlot & { rack: Rack }; index: number }) {
  const services = useServices();
  const macro = slot.rack.macros[index] as Rack['macros'][number];
  const info = (pluginId: string) => {
    const def = services.plugins.get(pluginId);
    return def ? { name: def.name, params: def.params } : undefined;
  };
  const update = (mapping: MacroMapping, patch: Partial<MacroMapping>) =>
    services.history.transact('Change macro mapping', (d) => void setMacroMapping(d, insertId, slot.id, index, { ...mapping, ...patch }));
  return (
    <div className={styles.mappings} role="region" aria-label={`What macro ${index + 1} moves`}>
      <p className={styles.mappingsTitle}>
        Macro {index + 1} “{macro.name}” moves
      </p>
      {macro.mappings.length === 0 ? (
        <p className={styles.hintLine}>
          Nothing yet. Right-click a setting of an effect in the rack (or its dry/wet, a branch’s level or pan, a crossover, the rack’s output) and choose Map to
          macro, then pick this macro. The setting then follows the knob between the two ends you set here.
        </p>
      ) : (
        <ul className={styles.mappingList}>
          {macro.mappings.map((mapping) => {
            const spec = macroTargetSpec(services, slot.rack, mapping.target);
            const name = describeMacroTarget(slot.rack, mapping.target, info) ?? 'Something that is gone';
            const key = JSON.stringify(mapping.target);
            return (
              <li key={key} className={styles.mapping}>
                <span className={styles.mappingTarget} data-hint={name}>
                  {name}
                </span>
                {spec && (
                  <>
                    <RangeEnd spec={spec} value={mapping.min} label={`${name}: value with the macro at 0`} onChange={(min) => update(mapping, { min })} />
                    <span aria-hidden>→</span>
                    <RangeEnd spec={spec} value={mapping.max} label={`${name}: value with the macro at 1`} onChange={(max) => update(mapping, { max })} />
                  </>
                )}
                <select
                  className={styles.select}
                  aria-label={`${name}: curve`}
                  data-hint={CURVES.find((curve) => curve.id === mapping.curve)?.hint ?? 'How the setting follows the knob'}
                  value={mapping.curve}
                  onChange={(e) => update(mapping, { curve: e.currentTarget.value as MacroCurve })}
                >
                  {CURVES.map((curve) => (
                    <option key={curve.id} value={curve.id}>
                      {curve.label}
                    </option>
                  ))}
                </select>
                <button
                  className={`${styles.button} ${styles.buttonDanger}`}
                  aria-label={`Let go of ${name}`}
                  data-hint={`Take ${name} off this macro (it follows its own value again)`}
                  onClick={() => services.history.transact('Let go of the macro', (d) => void removeMacroMapping(d, insertId, slot.id, index, mapping.target))}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** The eight macro knobs and, under them, what the selected one moves. */
export function MacroPanel({ insertId, slot }: { insertId: InsertId; slot: FxSlot & { rack: Rack } }) {
  const [selected, setSelected] = useState(0);
  return (
    <div className={styles.macros}>
      <div className={styles.macroRow} role="group" aria-label="Macro knobs" data-roving="grid">
        {slot.rack.macros.map((_, index) => (
          <MacroKnob key={index} insertId={insertId} slot={slot} index={index} isSelected={index === selected} onSelect={setSelected} />
        ))}
      </div>
      <MappingList insertId={insertId} slot={slot} index={selected} />
    </div>
  );
}
