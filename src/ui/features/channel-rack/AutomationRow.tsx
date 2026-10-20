import { targetName } from '@core/automation/labels';
import { type ChannelId } from '@core/model/types';
import { setChannelProp } from '@core/ops/channels';
import { ticksPerBar } from '@core/time/ppq';
import { type ParamSpecs } from '@agstudio/sdk/params';
import { deleteChannel } from '@app/actions/channels';
import { useDoc, useServices } from '../../services-context';
import { showContextMenu } from '../../controls/ContextMenu';
import { Icon } from '../../controls/Icon';
import { openWindow } from '../../workspace/registry';
import styles from './ChannelRack.module.css';

/**
 * An automation channel (FL lists them in the rack too): what it moves, and the way to its clips
 * in the playlist, where it is drawn and edited.
 */
export function AutomationRow({ id }: { id: ChannelId }) {
  const services = useServices();
  const ch = useDoc((pr) => pr.channels[id]);
  const what = useDoc((pr) => {
    const c = pr.channels[id];
    if (c?.kind !== 'automation' || !c.target) return null;
    return targetName(pr, c.target, (pluginId) => {
      const def = services.plugins.get(pluginId);
      return def ? { name: def.name, params: def.params as ParamSpecs } : undefined;
    });
  });
  // Where it plays: "bars 1–5", or the first of several clips.
  const where = useDoc((pr) => {
    const clips = Object.values(pr.playlist.clips)
      .filter((c) => c.kind === 'automation' && c.channelId === id)
      .sort((a, b) => a.start - b.start);
    const first = clips[0];
    if (!first) return null;
    const bar = ticksPerBar(pr.transport.timeSig);
    const from = Math.round((first.start / bar + 1) * 100) / 100;
    const to = Math.round(((first.start + first.length) / bar + 1) * 100) / 100;
    return `bars ${from}–${to}${clips.length > 1 ? ` (+${clips.length - 1} more)` : ''}`;
  });
  if (ch?.kind !== 'automation') return null;
  const reveal = () => {
    const clips = Object.values(services.doc.getState().project.playlist.clips)
      .filter((c) => c.kind === 'automation' && c.channelId === id)
      .map((c) => c.id);
    services.editor.getState().selectClips(clips);
    openWindow(services, 'playlist');
  };
  const toggleMute = () =>
    services.history.transact(ch.muted ? 'Unmute automation' : 'Mute automation', (d) =>
      setChannelProp(d, id, 'muted', !ch.muted),
    );
  const menu = (e: React.MouseEvent) => {
    e.preventDefault();
    showContextMenu(e, [
      { label: 'Show it in the playlist', onSelect: reveal },
      {
        label: ch.muted ? 'Unmute (let it move the control again)' : 'Mute (stop moving the control)',
        onSelect: toggleMute,
      },
      { kind: 'separator' },
      { label: 'Delete this automation', danger: true, onSelect: () => deleteChannel(services, id) },
    ]);
  };
  const subject = what ? `automation of “${what}”` : 'automation of a control that no longer exists';
  return (
    <div className={styles.row} data-channel-id={id}>
      <button
        className={`${styles.led} ${ch.muted ? '' : styles.ledOn}`}
        onPointerDown={(e) => e.preventDefault()}
        onClick={toggleMute}
        data-hint={`${ch.name}: ${ch.muted ? 'muted' : 'on'}. Click to ${ch.muted ? 'let it move the control again' : 'mute it'}`}
        aria-label={ch.muted ? 'Unmute' : 'Mute'}
      />
      <span className={styles.autoSpacer} />
      <button
        className={styles.name}
        style={{ ['--ch-color' as string]: ch.color }}
        onPointerDown={(e) => e.preventDefault()}
        onDoubleClick={reveal}
        onContextMenu={menu}
        data-hint={`${ch.name}: ${subject}. Double-click to show it in the playlist, right-click for options`}
      >
        {ch.name}
      </button>
      <div
        className={`${styles.notesBar} ${styles.autoBar}`}
        onDoubleClick={reveal}
        data-hint="Automation plays from its clips on the playlist (in Song mode). Double-click to show them"
      >
        <Icon name="wave" size={14} />
        {where ? `On the playlist: ${where}` : 'Not on the playlist yet'}
        {what && what !== ch.name ? ` · moves ${what}` : ''}
      </div>
    </div>
  );
}
