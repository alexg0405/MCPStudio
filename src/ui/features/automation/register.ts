import type { Services } from '@app/services';
import { targetKey } from '@core/model/targets';
import type { ClipId } from '@core/model/types';
import { isAutomatable } from '@agstudio/sdk';
import type { MenuEntry } from '../../controls/ContextMenu';
import { addContextMenuItems } from '../../context-menus';
import { addParamMenuItems } from '../../param-menu';
import { openWindow } from '../../workspace/registry';
import { automationClipMenu, createAutomationFor } from './actions';

/**
 * Automation clips: "Create automation clip" on every automatable control (knobs, faders, the
 * tempo), and the automation entries of a clip's ▾ menu (LFO, point shapes, what it controls).
 * Drawing and point editing live in the playlist (features/playlist/automation.ts).
 */
export function register(_services: Services): void {
  addParamMenuItems((info, s) => {
    if (!isAutomatable(info.spec)) return [];
    const entries: MenuEntry[] = [
      { label: 'Create automation clip', onSelect: () => createAutomationFor(s, info.target) },
    ];
    const channels = s.automation.channelsFor(targetKey(info.target));
    if (channels.length > 0) {
      entries.push({
        label: 'Show its automation in the playlist',
        onSelect: () => {
          const ids = new Set(channels.map((c) => c.id));
          const clips = Object.values(s.doc.getState().project.playlist.clips)
            .filter((c) => c.kind === 'automation' && ids.has(c.channelId))
            .map((c) => c.id as ClipId);
          s.editor.getState().selectClips(clips);
          openWindow(s, 'playlist');
        },
      });
    }
    return entries;
  });
  addContextMenuItems('playlist.clip', ({ clip }, s) => (clip.kind === 'automation' ? automationClipMenu(s, clip) : []));
}
