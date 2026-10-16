import { createElement } from 'react';
import type { Services } from '@app/services';
import { showDialog } from '../../controls/Dialog';
import { addToolbarSlot } from '../../shell/toolbar-slots';
import { openWindow, registerWindowType } from '../../workspace/registry';
import { registerWindowToggle } from '../../workspace/window-commands';
import { AiStudioButton } from './AiStudioButton';
import { lazyWindow, whenIdle } from '../../workspace/lazy';

/**
 * A command the AI asked for that opens a file dialog: browsers allow that only right after a
 * click, so the musician confirms here (the click is the gesture the dialog needs).
 */
async function confirmCommand(s: Services, id: string, args: unknown): Promise<void> {
  const def = s.commands.get(id);
  if (!def) return;
  const title = def.title.replace(/…$/, '');
  const choice = await showDialog({
    title: `Studio: ${title}?`,
    message: def.hint ?? `Studio wants to run “${title}”.`,
    detail: 'Your browser opens file dialogs only after a click, so this one is yours.',
    buttons: [
      { id: 'cancel', label: 'Not now' },
      { id: 'run', label: title, primary: true },
    ],
    cancelId: 'cancel',
  });
  if (choice === 'run') s.commands.run(id, args);
}

/**
 * The AI studio window: ask for a beat or any change (mixer, plugins, routing, arrangement…), or
 * perform part of a beat; Claude's answer is applied as one undoable edit.
 */
export function register(services: Services): void {
  registerWindowType({
    type: 'assistant',
    title: () => 'Studio',
    component: lazyWindow(() => import('./AssistantWindow'), (m) => m.AssistantWindow),
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
    title: 'Studio',
    hint: 'Ask Studio to make or change anything: a beat, the mixer, plugins, routing, the arrangement',
    chords: ['Alt+6'],
    menuOrder: 45,
    // The AI studio shouldn't close itself mid-conversation.
    ai: false,
  });
  // The assistant's code (a quarter of a megabyte) isn't part of startup: fetched once the first paint is done.
  whenIdle(() => services.assistant.prefetch());
  // Windows an answer asked to show ("open the mixer", the effect it just added…).
  services.assistant.store.subscribe((st) => {
    if (st.uiRequests.length === 0) return;
    const requests = st.uiRequests;
    services.assistant.clearUiRequests();
    for (const r of requests) {
      if (r.kind === 'command') {
        void confirmCommand(services, r.id, r.args);
        continue;
      }
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
  // The most prominent control in the toolbar: the first center slot, right after the transport (the
  // lowest order there never folds into "More").
  addToolbarSlot({ id: 'assistant', area: 'center', order: -10, component: () => createElement(AiStudioButton) });
}
