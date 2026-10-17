import type { Json } from '@core/model/json';
import type { Project } from '@core/model/types';
import type { Rect } from '@core/time/geometry';
import { SNAP_OPTIONS } from '@core/time/snap';
import type { Services } from '../services';
import {
  defaultPianoRoll,
  defaultPlaylist,
  NOTE_LANES,
  PIANO_ROLL_TOOLS,
  PLAYLIST_TOOLS,
  type PianoRollViewState,
  type PlaylistViewState,
} from '../stores/editor';
import type { TransportMode, ViewState, WindowInstance } from '../stores/view';

/**
 * The per-project UI state saved as `view.json` next to `project.json`: transport mode, current
 * pattern, loop, window layout, browser and editor settings. Never part of undo history. Reading is
 * forgiving: anything malformed falls back to defaults instead of failing the open.
 */
export interface ViewSnapshot {
  version: 1;
  mode: TransportMode;
  currentPatternId: string | null;
  loop: { start: number; end: number } | null;
  /** The audio punch range (absent in older files). */
  punch?: { start: number; end: number } | null;
  songStart: number;
  windows: Record<string, WindowInstance>;
  browser: ViewState['browser'];
  pianoRoll: PianoRollViewState;
  playlist: PlaylistViewState;
  selectedChannelId: string | null;
}

export function captureView(s: Services): ViewSnapshot {
  const v = s.view.getState();
  const e = s.editor.getState();
  return {
    version: 1,
    mode: v.mode,
    currentPatternId: v.currentPatternId,
    loop: v.loop,
    punch: v.punch,
    songStart: v.songStart,
    windows: v.windows,
    browser: v.browser,
    pianoRoll: e.pianoRoll,
    playlist: e.playlist,
    selectedChannelId: s.session.getState().selectedChannelId,
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function rect(v: unknown): Rect | null {
  if (!isObj(v) || !num(v.x) || !num(v.y) || !num(v.w) || !num(v.h) || v.w <= 0 || v.h <= 0) return null;
  return { x: v.x, y: v.y, w: v.w, h: v.h };
}

/** Windows whose props point at a channel or insert the project doesn't have are dropped. */
function refersToMissing(props: unknown, project: Project): boolean {
  if (!isObj(props)) return false;
  if (typeof props.channelId === 'string' && !project.channels[props.channelId as keyof Project['channels']])
    return true;
  if (typeof props.insertId === 'string' && !project.mixer.inserts[props.insertId as keyof Project['mixer']['inserts']])
    return true;
  return false;
}

function windows(v: unknown, project: Project): Record<string, WindowInstance> {
  const out: Record<string, WindowInstance> = {};
  if (!isObj(v)) return out;
  for (const [id, w] of Object.entries(v)) {
    if (!isObj(w) || typeof w.type !== 'string' || refersToMissing(w.props, project)) continue;
    const inst: WindowInstance = {
      id,
      type: w.type,
      props: (w.props ?? null) as Json,
      rect: rect(w.rect),
      z: num(w.z) ? w.z : 1,
      visible: w.visible !== false,
      maximized: w.maximized === true,
    };
    if (num(w.cascade)) inst.cascade = w.cascade;
    out[id] = inst;
  }
  return out;
}

const SNAPS = new Set<string>(SNAP_OPTIONS.map((o) => o.value));
const PIANO_ROLL_CHOICES: Record<string, ReadonlySet<string>> = {
  tool: new Set(PIANO_ROLL_TOOLS),
  snap: SNAPS,
  lane: new Set(NOTE_LANES),
};
const PLAYLIST_CHOICES: Record<string, ReadonlySet<string>> = { tool: new Set(PLAYLIST_TOOLS), snap: SNAPS };

/**
 * Keeps only known keys with the default's type (and, for `choices`, one of the allowed values), so
 * old or hand-edited files can't break editors.
 */
function merge<T extends object>(defaults: T, v: unknown, choices: Record<string, ReadonlySet<string>>): T {
  const out = { ...defaults };
  if (!isObj(v)) return out;
  for (const key of Object.keys(defaults) as (keyof T & string)[]) {
    const val = v[key];
    const def = defaults[key];
    if (val === undefined) continue;
    const allowed = choices[key];
    const ok = allowed
      ? allowed.has(val as string)
      : def === null
        ? num(val) || val === null
        : typeof def === 'number'
          ? num(val) && (def > 0 ? val > 0 : val >= 0)
          : typeof val === typeof def;
    if (ok) (out as Record<keyof T, unknown>)[key] = val;
  }
  return out;
}

/**
 * Applies a saved view (unvalidated JSON from a file or session snapshot) to the stores. Returns
 * false when it holds no window layout, so the caller can apply the default layout instead.
 */
export function applyView(s: Services, raw: unknown, project: Project): boolean {
  const v = isObj(raw) ? raw : {};
  const wins = windows(v.windows, project);
  const pattern =
    typeof v.currentPatternId === 'string' && project.patterns[v.currentPatternId as keyof Project['patterns']]
      ? (v.currentPatternId as ViewSnapshot['currentPatternId'])
      : (project.patternOrder[0] ?? null);
  const loop = isObj(v.loop) && num(v.loop.start) && num(v.loop.end) && v.loop.end > v.loop.start ? v.loop : null;
  const punch = isObj(v.punch) && num(v.punch.start) && num(v.punch.end) && v.punch.end > v.punch.start ? v.punch : null;
  const browser = isObj(v.browser)
    ? {
        visible: v.browser.visible !== false,
        width: num(v.browser.width) ? Math.max(160, Math.min(480, v.browser.width)) : 232,
      }
    : s.view.getState().browser;
  s.view.setState({
    mode: v.mode === 'song' ? 'song' : 'pattern',
    currentPatternId: pattern as ViewState['currentPatternId'],
    loop: loop ? { start: Math.round(loop.start as number), end: Math.round(loop.end as number) } : null,
    punch: punch ? { start: Math.max(0, Math.round(punch.start as number)), end: Math.round(punch.end as number) } : null,
    songStart: num(v.songStart) ? Math.max(0, Math.round(v.songStart)) : 0,
    windows: wins,
    focusedId: null,
    zTop: Object.values(wins).reduce((m, w) => Math.max(m, w.z), 0),
    browser,
  });
  s.editor.setState({
    pianoRoll: merge(defaultPianoRoll(), v.pianoRoll, PIANO_ROLL_CHOICES),
    playlist: merge(defaultPlaylist(), v.playlist, PLAYLIST_CHOICES),
    noteSelection: [],
    clipSelection: [],
  });
  const channel =
    typeof v.selectedChannelId === 'string' && project.channels[v.selectedChannelId as keyof Project['channels']]
      ? (v.selectedChannelId as keyof Project['channels'])
      : (project.channelOrder[0] ?? null);
  s.session.getState().selectChannel(channel);
  return Object.keys(wins).length > 0;
}
