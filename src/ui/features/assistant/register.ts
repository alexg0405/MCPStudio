import { createElement } from 'react';
import type { Services } from '@app/services';
import { CommandButton } from '../../shell/Toolbar';
import { addToolbarSlot } from '../../shell/toolbar-slots';
import { registerWindowType } from '../../workspace/registry';
import { registerWindowToggle } from '../../workspace/window-commands';
import { AssistantWindow } from './AssistantWindow';
import styles from './Assistant.module.css';

/** The beat assistant window: describe or perform a beat and it gets written into the project. */
export function register(services: Services): void {
  registerWindowType({
    type: 'assistant',
    title: () => 'Beat assistant',
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
    title: 'Beat assistant',
    hint: 'Describe a beat (or beatbox / hum it) and the assistant writes it',
    chords: ['Alt+6'],
    menuOrder: 45,
  });
  addToolbarSlot({
    id: 'assistant',
    area: 'center',
    order: 1,
    component: () =>
      createElement(CommandButton, { command: 'view.assistant', icon: 'sparkle', className: styles.toolbarButton }),
  });
}
