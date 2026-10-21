import { useRef } from 'react';
import type { Gesture } from '@core/history/history';
import type { ChannelId, MidiFxSlot } from '@core/model/types';
import { midiFxDef } from '@core/midi-fx/registry';
import { setMidiFxParam } from '@core/ops/midi-fx';
import type { ParamValue } from '@agstudio/sdk/params';
import { useServices } from '../../services-context';

/**
 * Edit callbacks for one effect's knobs, mapped onto undo history: a knob drag is one gesture (one undo step, heard live while
 * dragging); a typed or stepped value is one step that merges with the next one on the same knob.
 */
export function useMidiFxEditing(channelId: ChannelId, slot: MidiFxSlot) {
  const services = useServices();
  const gestures = useRef(new Map<string, Gesture>());
  const name = midiFxDef(slot.effect)?.name ?? 'MIDI effect';
  const label = (param: string) => `${name}: ${midiFxDef(slot.effect)?.params[param]?.label ?? param}`;
  return {
    beginEdit(param: string) {
      gestures.current.get(param)?.commit();
      gestures.current.set(param, services.history.gesture(label(param)));
    },
    setParam(param: string, value: ParamValue) {
      const recipe = (d: Parameters<typeof setMidiFxParam>[0]) => setMidiFxParam(d, channelId, slot.id, param, value);
      const gesture = gestures.current.get(param);
      if (gesture?.active) gesture.update(recipe);
      else services.history.transact(label(param), recipe, { mergeKey: `midifx:${slot.id}:${param}` });
    },
    endEdit(param: string) {
      gestures.current.get(param)?.commit();
      gestures.current.delete(param);
    },
  };
}
