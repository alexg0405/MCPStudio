import { formatValue, type ParamSpec, type ParamSpecs, type ParamValue } from '@agstudio/sdk';
import { Knob, Select, Toggle } from '@agstudio/sdk/ui';
import styles from './PluginWindow.module.css';

interface Props {
  specs: ParamSpecs;
  values: Record<string, ParamValue>;
  beginEdit(param: string): void;
  setParam(param: string, value: ParamValue): void;
  endEdit(param: string): void;
}

function Control({ id, spec, value, edit }: { id: string; spec: ParamSpec; value: ParamValue; edit: Props }) {
  const label = spec.label ?? id;
  if (spec.type === 'bool') {
    return (
      <div className={styles.control}>
        <Toggle spec={spec} value={Boolean(value)} label={label} param={id} onCommit={(v) => edit.setParam(id, v)} />
      </div>
    );
  }
  if (spec.type === 'enum') {
    return (
      <div className={styles.control}>
        <Select spec={spec} value={String(value)} label={label} param={id} onCommit={(v) => edit.setParam(id, v)} />
        <span className={styles.label}>{label}</span>
      </div>
    );
  }
  return (
    <div className={styles.control} data-hint={spec.hint ? `${label}: ${spec.hint}` : undefined}>
      <Knob
        spec={spec}
        value={value}
        label={label}
        param={id}
        size={34}
        bipolar={spec.min < 0 && spec.max > 0}
        onBegin={() => edit.beginEdit(id)}
        onChange={(v) => edit.setParam(id, v)}
        onEnd={() => edit.endEdit(id)}
        onCommit={(v) => edit.setParam(id, v)}
      />
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>{formatValue(spec, value)}</span>
    </div>
  );
}

/** The generated editor for plugins without a custom UI: params grouped by `group`, in declaration order. */
export function AutoPanel(props: Props) {
  const groups = new Map<string, [string, ParamSpec][]>();
  for (const [id, spec] of Object.entries(props.specs)) {
    const g = spec.group ?? 'Settings';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push([id, spec]);
  }
  if (groups.size === 0) return <div className={styles.note}>This plugin has no parameters.</div>;
  return (
    <div className={styles.groups}>
      {[...groups].map(([name, params]) => (
        <section key={name} className={styles.group}>
          <h3 className={styles.groupTitle}>{name}</h3>
          <div className={styles.controls}>
            {params.map(([id, spec]) => (
              <Control key={id} id={id} spec={spec} value={props.values[id] ?? spec.default} edit={props} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
