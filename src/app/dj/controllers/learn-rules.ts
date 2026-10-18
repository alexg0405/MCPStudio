/**
 * The rules of MIDI learn that need no devices: whether a touched control fits a target, what to tell the musician, and
 * how a learned control is linked into a mapping. The manager (`manager.ts`) feeds it what the detector found.
 */
import type { MidiMessage } from '@core/midi-map/message';
import { targetInfo, type TargetKind } from '@core/midi-map/targets';
import { describeInput, inputKey, type ControllerMapping, type InputSpec } from '@core/midi-map/types';

/** What a learn session aims at: a target from the target list, or the Shift key itself. */
export type LearnKind = TargetKind | 'shift';

/** The kind of control a learn target needs (the Shift key is a button). */
export function learnKindOf(target: string): LearnKind {
  return target === 'shift' ? 'shift' : targetInfo(target)!.kind;
}

/** What the musician sees the target called. */
export function learnLabelOf(target: string): string {
  return target === 'shift' ? 'the Shift key' : (targetInfo(target)?.label ?? target);
}

/** The kind the detector expects to see (a Shift key is found like a button). */
export function detectorKindOf(kind: LearnKind): TargetKind {
  return kind === 'shift' ? 'button' : kind;
}

/** Is this message sent by that input (a button's note on or off, a CC)? */
export function isInputMessage(input: InputSpec, msg: MidiMessage): boolean {
  if (input.type === 'note') return (msg.kind === 'noteOn' || msg.kind === 'noteOff') && msg.channel === input.channel && msg.note === input.note;
  if (input.type === 'cc') return msg.kind === 'cc' && msg.channel === input.channel && msg.cc === input.cc;
  return false;
}

/** Why a learned control does not fit a target, in plain words (null = it fits). */
export function learnMismatch(kind: LearnKind, input: InputSpec, label: string): string | null {
  const touched = input.type;
  if (kind === 'button' || kind === 'shift') {
    if (touched === 'note' || touched === 'cc') return null;
    return `That is a ${touched === 'rel' ? 'jog wheel or endless dial' : 'fader or knob'}, but ${label} needs a button. Press a button.`;
  }
  if (kind === 'abs') {
    if (touched === 'cc' || touched === 'cc14' || touched === 'bend') return null;
    return touched === 'note'
      ? `That is a button, but ${label} needs a fader or knob. Move one.`
      : `That is a jog wheel or endless dial, but ${label} needs a fader or knob. Move one.`;
  }
  if (touched === 'rel') return null;
  return touched === 'note'
    ? `That is a button, but ${label} needs a jog wheel or endless dial. Turn one.`
    : `That looks like a fader or knob (it has a start and an end), but ${label} needs a jog wheel or endless dial. Turn one slowly both ways.`;
}

/** What to ask the musician to do to teach a target ("Press the button for Deck A: Play…"). */
export function learnPrompt(kind: LearnKind, label: string, isShifted: boolean): string {
  const action = kind === 'abs' ? 'move the fader or knob' : kind === 'rel' ? 'turn the jog wheel or dial a few clicks (both ways)' : 'press the button';
  const text = `${isShifted ? 'Hold Shift if you like, then ' : ''}${action} for ${label}…`;
  return text.replace(/^[a-z]/, (c) => c.toUpperCase());
}

/** What happened when a learned control was linked into a mapping. */
export type LinkResult =
  /** Linked: the new mapping, and what to tell the musician. */
  | { status: 'linked'; mapping: ControllerMapping; done: string }
  /** The control does not fit the target: say why and keep waiting for the right one. */
  | { status: 'retry'; message: string }
  /** A shifted function needs the Shift key linked first: say so and stop learning. */
  | { status: 'needsShift'; message: string };

/**
 * Links `input` to `target` (or the Shift key) in the mapping. Whatever the input or the target was linked to before
 * (in the same layer) is replaced, so one control does one thing.
 */
export function linkLearnedControl(mapping: ControllerMapping, target: string, isShifted: boolean, input: InputSpec): LinkResult {
  const kind = learnKindOf(target);
  const label = learnLabelOf(target);
  const problem = learnMismatch(kind, input, label);
  if (problem) return { status: 'retry', message: problem };
  if (target === 'shift') {
    return {
      status: 'linked',
      mapping: { ...mapping, shifts: [{ id: 'shift', input }] },
      done: `Shift key linked (${describeInput(input)}).`,
    };
  }
  const shiftLayer = mapping.shifts[0];
  if (isShifted && !shiftLayer) {
    return { status: 'needsShift', message: 'Link the Shift key first (the “Shift key” row), then learn the shifted control.' };
  }
  const layer = isShifted ? shiftLayer!.id : undefined;
  const layerName = layer ?? '';
  const bindings = mapping.bindings.filter(
    (b) => !(b.target === target && (b.layer ?? '') === layerName) && !(inputKey(b.input) === inputKey(input) && (b.layer ?? '') === layerName),
  );
  bindings.push({ input, target, ...(layer ? { layer } : {}) });
  return {
    status: 'linked',
    mapping: { ...mapping, bindings },
    done: `${label}${isShifted ? ' (with Shift)' : ''} linked to ${describeInput(input)}.`,
  };
}
