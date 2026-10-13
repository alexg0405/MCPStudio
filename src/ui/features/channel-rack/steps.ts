/**
 * The channel rack's step tools: fill every 2/4/8 steps, rotate, shift, reverse, randomize and
 * clear one channel's steps in the current pattern (each one undo step), plus the graph editor's
 * per-step lanes (velocity, pan, release, pitch, fine pitch).
 */
import { noteName } from '@agstudio/sdk/notes';
import type { Services } from '@app/services';
import type { StepLane } from '@app/stores/editor';
import type { Draft } from 'immer';
import { formatChord } from '@core/commands/keymap';
import type { ChannelId, Note, NoteId, PatternId, Project } from '@core/model/types';
import type { NoteEdit } from '@core/ops/notes';
import { clearSteps, fillSteps, randomizeSteps, reverseSteps, rotateSteps, shiftSteps } from '@core/ops/steps';
import type { MenuEntry } from '../../controls/ContextMenu';
import { formatLaneAmount, laneEdit, laneValue } from '../piano-roll/lanes';

type StepRecipe = (d: Draft<Project>, patternId: PatternId, channelId: ChannelId, rootKey: number) => void;

/** The instrument channel (default: the selected one) and pattern a step tool works on, or null. */
export function stepTarget(
  s: Services,
  channel?: ChannelId | null,
): { channelId: ChannelId; patternId: PatternId; rootKey: number; name: string } | null {
  const channelId = channel ?? s.session.getState().selectedChannelId;
  const project = s.doc.getState().project;
  const patternId = s.view.getState().currentPatternId;
  const ch = channelId ? project.channels[channelId] : undefined;
  if (!channelId || !patternId || !project.patterns[patternId] || ch?.kind !== 'instrument') return null;
  return { channelId, patternId, rootKey: ch.rootKey, name: ch.name };
}

/** Runs a step tool on a channel as one undo step. Returns false when the channel can't have steps. */
function run(s: Services, channelId: ChannelId | null, label: string, recipe: StepRecipe): boolean {
  const t = stepTarget(s, channelId);
  if (!t) return false;
  s.history.transact(`${label} (${t.name})`, (d) => recipe(d, t.patternId, t.channelId, t.rootKey));
  return true;
}

export const stepTools = {
  fill: (s: Services, id: ChannelId | null, every: number) =>
    run(s, id, `Fill every ${every} steps`, (d, p, c, rootKey) => fillSteps(d, p, c, every, { rootKey })),
  rotate: (s: Services, id: ChannelId | null, by: number) =>
    run(s, id, by < 0 ? 'Rotate steps left' : 'Rotate steps right', (d, p, c) => rotateSteps(d, p, c, by)),
  shift: (s: Services, id: ChannelId | null, by: number) =>
    run(s, id, by < 0 ? 'Shift steps left' : 'Shift steps right', (d, p, c) => shiftSteps(d, p, c, by)),
  reverse: (s: Services, id: ChannelId | null) => run(s, id, 'Reverse steps', (d, p, c) => reverseSteps(d, p, c)),
  randomize: (s: Services, id: ChannelId | null, rand: () => number = Math.random) =>
    run(s, id, 'Randomize steps', (d, p, c, rootKey) => randomizeSteps(d, p, c, { rootKey, rand })),
  clear: (s: Services, id: ChannelId | null) => run(s, id, 'Clear steps', (d, p, c) => clearSteps(d, p, c)),
};

/** Opens or closes the graph editor under a channel (one at a time). */
export function toggleGraph(s: Services, channelId: ChannelId): void {
  const open = s.editor.getState().stepGraph.channelId === channelId;
  s.editor.getState().setStepGraph({ channelId: open ? null : channelId });
}

function shortcut(s: Services, command: string): string | undefined {
  const chord = s.keymap.chordsFor(command)[0];
  return chord ? formatChord(chord, s.platform) : undefined;
}

/** The Steps menu for a channel: the rack header's "Steps ▾" button and the channel's right-click menu. */
export function stepsMenu(s: Services, channelId: ChannelId | null): MenuEntry[] {
  const t = stepTarget(s, channelId);
  if (!t) return [{ kind: 'label', label: 'Select an instrument channel first' }];
  const id = t.channelId;
  const key = (cmd: string) => {
    const k = shortcut(s, cmd);
    return k ? { shortcut: k } : {};
  };
  return [
    { kind: 'label', label: `Steps of ${t.name}` },
    { label: 'Fill every 2 steps', onSelect: () => stepTools.fill(s, id, 2) },
    { label: 'Fill every 4 steps', onSelect: () => stepTools.fill(s, id, 4) },
    { label: 'Fill every 8 steps', onSelect: () => stepTools.fill(s, id, 8) },
    { kind: 'separator' },
    { label: 'Rotate left (wraps around)', ...key('rack.rotateLeft'), onSelect: () => stepTools.rotate(s, id, -1) },
    { label: 'Rotate right (wraps around)', ...key('rack.rotateRight'), onSelect: () => stepTools.rotate(s, id, 1) },
    { label: 'Shift left (drops the first step)', onSelect: () => stepTools.shift(s, id, -1) },
    { label: 'Shift right (drops the last step)', onSelect: () => stepTools.shift(s, id, 1) },
    { label: 'Reverse', onSelect: () => stepTools.reverse(s, id) },
    { kind: 'separator' },
    { label: 'Randomize', onSelect: () => stepTools.randomize(s, id) },
    { label: 'Clear', danger: true, onSelect: () => stepTools.clear(s, id) },
    { kind: 'separator' },
    {
      label: 'Graph editor (velocity, pan, pitch…)',
      checked: s.editor.getState().stepGraph.channelId === id,
      onSelect: () => toggleGraph(s, id),
    },
  ];
}

// ---- Graph editor lanes ----

export interface StepLaneInfo {
  label: string;
  /** Bars grow from the centre line (−1…1) instead of the bottom (0–1). */
  bipolar: boolean;
  hint: string;
}

/** Semitones the pitch lane spans each way from the channel's root key. */
export const PITCH_RANGE = 24;

export const STEP_LANE_INFO: Record<StepLane, StepLaneInfo> = {
  velocity: { label: 'Velocity', bipolar: false, hint: 'how hard each step plays' },
  pan: { label: 'Pan', bipolar: true, hint: 'left (down) or right (up)' },
  release: { label: 'Release', bipolar: false, hint: 'release velocity (how the note ends)' },
  key: { label: 'Pitch', bipolar: true, hint: 'the note each step plays, up to 2 octaves from the root key' },
  fine: { label: 'Fine pitch', bipolar: true, hint: 'detune each step by up to ±100 cents' },
};

/** A step note's value in lane units: 0–1, or −1…1 for bipolar lanes. */
export function stepValue(n: Note, lane: StepLane, rootKey: number): number {
  if (lane === 'key') return Math.max(-1, Math.min(1, (n.key - rootKey) / PITCH_RANGE));
  return laneValue(n, lane);
}

/** The edit that gives a step note `value` (lane units). */
export function stepEdit(id: NoteId, lane: StepLane, value: number, rootKey: number): NoteEdit {
  if (lane === 'key') return { id, key: rootKey + Math.round(Math.max(-1, Math.min(1, value)) * PITCH_RANGE) };
  return laneEdit(id, lane, value);
}

/** The value a right-drag resets to. */
export function stepReset(lane: StepLane): number {
  return lane === 'velocity' ? 100 / 128 : lane === 'release' ? 0.5 : 0;
}

/** A value in words and units: "78%", "D#5 (+3 st)", "25% left". */
export function formatStepValue(lane: StepLane, value: number, rootKey: number): string {
  if (lane === 'key') {
    const st = Math.round(value * PITCH_RANGE);
    return `${noteName(rootKey + st)} (${st > 0 ? '+' : ''}${st} st)`;
  }
  return formatLaneAmount(lane, value);
}
