import { targetKey } from '@core/model/targets';
import { memo, useState } from 'react';
import type { ChannelId } from '@core/model/types';
import { setChannelProp, toggleSoloChannel } from '@core/ops/channels';
import { p } from '@agstudio/sdk/params';
import { Knob } from '@agstudio/sdk/ui';
import { useDoc, useServices, useSession } from '../../services-context';
import { usePluginDef } from '../../plugin-hooks';
import { useGestureEdit } from '../../edit';
import { showContextMenu } from '../../controls/ContextMenu';
import styles from './ChannelRack.module.css';
import { AutomationRow } from './AutomationRow';
import { channelMenuEntries } from './channel-menu';
import { InsertBox } from './InsertBox';
import { StepGrid } from './StepGrid';

const VOLUME = p.float(0, 1.25, 0.78, { label: 'Volume', unit: '%' });
const PAN = p.float(-1, 1, 0, { label: 'Pan' });

/** The name of a channel being edited in place: Enter or leaving the box renames it, Esc keeps the old name. */
function RenameInput({ channelId, name, onDone }: { channelId: ChannelId; name: string; onDone(): void }) {
  const services = useServices();
  return (
    <input
      className={styles.rename}
      autoFocus
      defaultValue={name}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => {
        onDone();
        const newName = e.currentTarget.value.trim();
        if (newName && newName !== name) services.history.transact('Rename channel', (d) => setChannelProp(d, channelId, 'name', newName));
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          e.currentTarget.value = name;
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/**
 * One channel's row. It takes no pattern: the step grid inside follows the open pattern itself, so
 * switching patterns doesn't re-render the knobs, names and routing of every channel.
 */
export const ChannelRow = memo(function ChannelRow({ id, dropTarget }: { id: ChannelId; dropTarget: boolean }) {
  const services = useServices();
  const ch = useDoc((pr) => pr.channels[id]);
  const selected = useSession((s) => s.selectedChannelId === id);
  const [renaming, setRenaming] = useState(false);
  const volume = useGestureEdit<number>('Channel volume', (d, v) => setChannelProp(d, id, 'volume', v), `vol:${id}`);
  const pan = useGestureEdit<number>('Channel pan', (d, v) => setChannelProp(d, id, 'pan', v), `pan:${id}`);
  const def = usePluginDef(ch?.kind === 'instrument' ? ch.plugin.pluginId : undefined);
  if (!ch) return null;
  if (ch.kind === 'automation') return <AutomationRow id={id} />;
  const missing = ch.kind === 'instrument' && !def;

  const menu = (e: React.MouseEvent) => {
    e.preventDefault();
    services.session.getState().selectChannel(id);
    showContextMenu(e, channelMenuEntries(services, ch, () => setRenaming(true)));
  };

  return (
    <div
      className={`${styles.row} ${selected ? styles.rowSelected : ''} ${dropTarget ? styles.rowDrop : ''}`}
      data-channel-id={id}
    >
      <button
        className={`${styles.led} ${ch.muted ? '' : styles.ledOn} ${ch.solo ? styles.ledSolo : ''}`}
        onPointerDown={(e) => e.preventDefault()}
        onClick={() =>
          services.history.transact(ch.muted ? 'Unmute' : 'Mute', (d) => setChannelProp(d, id, 'muted', !ch.muted))
        }
        onContextMenu={(e) => {
          e.preventDefault();
          services.history.transact('Solo', (d) => toggleSoloChannel(d, id));
        }}
        data-hint={`${ch.name}: ${ch.muted ? 'muted' : 'on'}. Click to mute, right-click to solo`}
        aria-label={ch.muted ? 'Unmute' : 'Mute'}
      />
      <Knob
        spec={PAN}
        value={ch.pan}
        size={20}
        bipolar
        label="Pan"
        param={targetKey({ kind: 'channel', channelId: id, param: 'pan' })}
        {...pan}
      />
      <Knob
        spec={VOLUME}
        value={ch.volume}
        size={20}
        label="Volume"
        param={targetKey({ kind: 'channel', channelId: id, param: 'volume' })}
        {...volume}
      />
      <InsertBox channelId={id} />
      {renaming ? (
        <RenameInput channelId={id} name={ch.name} onDone={() => setRenaming(false)} />
      ) : (
        <button
          className={`${styles.name} ${missing ? styles.nameMissing : ''}`}
          style={{ ['--ch-color' as string]: ch.color }}
          onPointerDown={(e) => {
            e.preventDefault();
            if (e.button === 0) services.session.getState().selectChannel(id);
          }}
          onDoubleClick={() => services.commands.run('plugin.openEditor', { channelId: id })}
          onContextMenu={menu}
          data-hint={
            missing
              ? `${ch.name}: plugin "${ch.kind === 'instrument' ? ch.plugin.pluginId : ''}" is not installed (settings are kept)`
              : `${ch.name}${def ? ` (${def.name})` : ''}. Double-click to open, right-click for options`
          }
        >
          {ch.name}
        </button>
      )}
      {ch.kind === 'instrument' ? (
        <StepGrid channelId={id} rootKey={ch.rootKey} />
      ) : (
        <div className={styles.notesBar}>audio clip</div>
      )}
      <span className={`${styles.select} ${selected ? styles.selectOn : ''}`} />
    </div>
  );
});
