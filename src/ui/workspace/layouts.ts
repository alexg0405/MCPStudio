import type { Services } from '@app/services';
import type { Rect, Size } from '@core/time/geometry';
import { openWindow } from './registry';

/** Size of the workspace, kept current by <Workspace> so layout presets can place windows. */
export const workspaceSize: Size = { w: 1200, h: 700 };

type Placement = { type: string; rect: (ws: Size) => Rect };

/** Window arrangements (View → Layout). Windows not listed are hidden. */
export const LAYOUTS: Record<string, { title: string; windows: Placement[] }> = {
  arrange: {
    title: 'Arrange',
    windows: [
      { type: 'playlist', rect: (ws) => ({ x: 8, y: 8, w: ws.w - 16, h: ws.h - 16 }) },
      { type: 'channel-rack', rect: (ws) => ({ x: 40, y: 32, w: Math.min(640, ws.w - 80), h: Math.min(320, ws.h - 64) }) },
    ],
  },
  compose: {
    title: 'Compose',
    windows: [
      { type: 'channel-rack', rect: (ws) => ({ x: 8, y: 8, w: Math.min(620, ws.w - 16), h: Math.round(ws.h * 0.36) }) },
      {
        type: 'piano-roll',
        rect: (ws) => ({ x: 8, y: Math.round(ws.h * 0.36) + 16, w: ws.w - 16, h: ws.h - Math.round(ws.h * 0.36) - 24 }),
      },
    ],
  },
  mix: {
    title: 'Mix',
    windows: [
      { type: 'playlist', rect: (ws) => ({ x: 8, y: 8, w: ws.w - 16, h: Math.round(ws.h * 0.42) }) },
      {
        type: 'mixer',
        rect: (ws) => ({ x: 8, y: Math.round(ws.h * 0.42) + 16, w: ws.w - 16, h: ws.h - Math.round(ws.h * 0.42) - 24 }),
      },
    ],
  },
};

export function applyLayout(services: Services, name: keyof typeof LAYOUTS): void {
  const layout = LAYOUTS[name];
  if (!layout) return;
  const view = services.view.getState();
  const wanted = new Set(layout.windows.map((w) => w.type));
  for (const w of Object.values(view.windows)) if (!wanted.has(w.type)) view.hideWindow(w.id);
  for (const p of layout.windows) {
    const id = openWindow(services, p.type);
    const v = services.view.getState();
    v.setMaximized(id, false);
    v.setRect(id, p.rect(workspaceSize));
  }
}

/** FL's default arrangement: the playlist fills the workspace with the channel rack floating on top. */
export function applyDefaultLayout(services: Services): void {
  openWindow(services, 'playlist');
  openWindow(services, 'channel-rack');
}
