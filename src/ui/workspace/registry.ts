import type { ComponentType } from 'react';
import type { Services } from '@app/services';
import type { Json } from '@core/model/json';
import type { Rect, Size } from '@core/time/geometry';

export interface WindowContentProps<P extends Json = Json> {
  windowId: string;
  props: P;
}

/** A kind of floating window (Channel Rack, Piano Roll, a plugin editor, …). Features register these. */
export interface WindowTypeDef<P extends Json = Json> {
  type: string;
  title(props: P, services: Services): string;
  component: ComponentType<WindowContentProps<P>>;
  /** Initial placement inside a workspace of the given size. */
  defaultRect(workspace: Size): Rect;
  minSize?: Size;
  /** Instance id for these props. Singletons (the default) use the type as id. */
  instanceId?(props: P): string;
  /** Offset each new instance so windows of this type don't open exactly on top of each other. */
  cascade?: boolean;
}

// Window types have heterogeneous props.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyWindowType = WindowTypeDef<any>;

const types = new Map<string, AnyWindowType>();

export function registerWindowType<P extends Json>(def: WindowTypeDef<P>): () => void {
  types.set(def.type, def as AnyWindowType);
  return () => {
    if (types.get(def.type) === def) types.delete(def.type);
  };
}

export function getWindowType(type: string): AnyWindowType | undefined {
  return types.get(type);
}

/** Every registered window type (the UX audit opens each one). */
export function windowTypes(): string[] {
  return [...types.keys()];
}

export function windowIdFor(type: string, props: Json = null): string {
  return types.get(type)?.instanceId?.(props) ?? type;
}

export function openWindow(services: Services, type: string, props: Json = null): string {
  const id = windowIdFor(type, props);
  const view = services.view.getState();
  const isNew = !view.windows[id];
  view.showWindow(id, type, props);
  if (isNew && types.get(type)?.cascade) {
    const siblings = Object.values(view.windows).filter((w) => w.type === type && w.visible).length;
    services.view.getState().setCascade(id, siblings % 8);
  }
  return id;
}

export function toggleWindow(services: Services, type: string, props: Json = null): void {
  services.view.getState().toggleWindow(windowIdFor(type, props), type, props);
}

export function isWindowOpen(services: Services, type: string, props: Json = null): boolean {
  return !!services.view.getState().windows[windowIdFor(type, props)]?.visible;
}

const MIN_VISIBLE = 64;

/** Keeps a window inside the workspace (its title bar always reachable) and at least its minimum size. */
export function clampRect(rect: Rect, ws: Size, min: Size = { w: 160, h: 90 }): Rect {
  const w = Math.max(min.w, Math.min(rect.w, Math.max(min.w, ws.w)));
  const h = Math.max(min.h, Math.min(rect.h, Math.max(min.h, ws.h)));
  const x = Math.min(Math.max(rect.x, MIN_VISIBLE - w), Math.max(0, ws.w - MIN_VISIBLE));
  const y = Math.min(Math.max(rect.y, 0), Math.max(0, ws.h - 28));
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}
