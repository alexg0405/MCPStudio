import { MASTER, type ChannelId } from '@core/model/types';
import { setChannelProp } from '@core/ops/channels';
import { useDoc } from '../../services-context';
import { useGestureEdit } from '../../edit';
import { DragNumber } from '../../controls/DragNumber';
import { parseTypedNumber } from '../../controls/number-text';
import styles from './ChannelRack.module.css';

/** The number of the mixer insert a channel plays through (-- is the master): drag, scroll or type it. */
export function InsertBox({ channelId }: { channelId: ChannelId }) {
  const order = useDoc((pr) => pr.mixer.order);
  const output = useDoc((pr) => {
    const ch = pr.channels[channelId];
    return ch && ch.kind !== 'automation' ? ch.output : MASTER;
  });
  const index = Math.max(0, order.indexOf(output));
  const edit = useGestureEdit<number>(
    'Route channel',
    (d, v) => setChannelProp(d, channelId, 'output', order[Math.round(v)] ?? MASTER),
    `route:${channelId}`,
  );
  return (
    <DragNumber
      className={styles.insert}
      value={index}
      min={0}
      max={order.length - 1}
      perPixel={0.15}
      step={1}
      format={(v) => (Math.round(v) === 0 ? '--' : String(Math.round(v)))}
      // “--”, “0” or “master” is the master; a number is that insert.
      parse={(t) => (/^\s*(--?|m(aster)?)\s*$/i.test(t) ? 0 : parseTypedNumber(t))}
      editText={(v) => String(Math.round(v))}
      {...edit}
      hint="Mixer insert this channel plays through (-- = master): drag, scroll, or click to type its number"
      editHint="Type a mixer insert number (0 or -- = master) · Enter sets it, Esc cancels"
      label="Mixer insert"
    />
  );
}
