import { createElement } from 'react';
import type { Services } from '@app/services';
import { CommandButton } from '../../shell/Toolbar';
import { addToolbarSlot } from '../../shell/toolbar-slots';
import { openWindow, registerWindowType } from '../../workspace/registry';
import { registerWindowToggle } from '../../workspace/window-commands';
import { AssistantWindow } from './AssistantWindow';
import styles from './Assistant.module.css';

/**
 * The AI studio window: ask for a beat or any change (mixer, plugins, routing, arrangement…), or
 * perform part of a beat; Claude's answer is applied as one undoable edit.
 */
export function register(services: Services): void {
  registerWindowType({
    type: 'assistant',
    title: () => 'AI studio',
    component: AssistantWindow,
    defaultRect: (ws) => ({
      x: Math.max(0, ws.w - 452),
      y: 24,
      w: 440,
      h: Math.max(380, Math.min(640, ws.h - 48)),
    }),
    minSize: { w: 340, h: 360 },
  });
  registerWindowToggle(services, {
    command: 'view.assistant',
    type: 'assistant',
    title: 'AI studio',
    hint: 'Ask the AI for a beat or any change to the project (mixer, plugins, routing, arrangement…)',
    chords: ['Alt+6'],
    menuOrder: 45,
  });
  // Windows an answer asked to show ("open the mixer", the effect it just added…).
  services.assistant.store.subscribe((st) => {
    if (st.uiRequests.length === 0) return;
    const requests = st.uiRequests;
    services.assistant.clearUiRequests();
    for (const r of requests) {
      if (r.kind !== 'open') continue;
      if (r.window === 'plugin') {
        if (r.slotId && r.insertId)
          openWindow(services, 'plugin', { kind: 'fx', insertId: r.insertId, slotId: r.slotId });
        else if (r.channelId) openWindow(services, 'plugin', { kind: 'channel', channelId: r.channelId });
        continue;
      }
      if (r.window === 'piano-roll' && r.channelId) services.session.getState().selectChannel(r.channelId);
      openWindow(services, r.window);
    }
  });
  addToolbarSlot({
    id: 'assistant',
    area: 'center',
    order: 1,
    component: () =>
      createElement(CommandButton, { command: 'view.assistant', icon: 'sparkle', className: styles.toolbarButton }),
  });
}
