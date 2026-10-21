/**
 * What the MIDI effects look up while they run, built from a project: the song key, the chord track, the tempo and the
 * automation clips that drive an effect's knobs. The caller says how ticks map to the chord track (a song clip plays at song
 * ticks, a pattern played on its own at the place it first has in the song, the clip launcher not at all).
 */
import { encode, fromNormalized } from '@agstudio/sdk/params';
import { automationAt, automationModelOf } from '../automation/model';
import type { ChordSymbol } from '../harmony/chord';
import { targetKey } from '../model/targets';
import type { ChannelId, MidiFxSlot, ParamTarget, Project } from '../model/types';
import type { TempoMap } from '../time/ppq';
import { midiFxDef } from './registry';
import type { FxContext } from './types';

/** How to turn the notes' ticks into a chord of the chord track (or none). */
export type ChordLookup = (tick: number) => ChordSymbol | null;

/** What the context needs besides the project. */
export interface ContextOptions {
  project: Project;
  tempo: TempoMap;
  /** The chord at a tick of the timeline the notes are on. */
  chordAt: ChordLookup;
  /** Automation clips drive knobs only while the song plays (song mode), not in a pattern played on its own. */
  useAutomation: boolean;
  /** The channel the chain belongs to (the targets of its automation name it). */
  channelId: ChannelId;
  slots: readonly MidiFxSlot[];
  live?: boolean;
}

/** No chord anywhere: for clips that have no place on the song's chord track. */
export const NO_CHORDS: ChordLookup = () => null;

/** The context for a chain of effects on one channel. */
export function createFxContext(options: ContextOptions): FxContext {
  const { project, tempo } = options;
  const key = project.transport.key ?? null;
  const context: FxContext = {
    key: key ? { root: key.root, scale: key.scale } : null,
    chordAt: options.chordAt,
    msToTicks: (ms, tick) => ms / 1000 / tempo.secondsPerTick(tick),
    live: options.live ?? false,
  };
  const automated = options.useAutomation ? automationReader(options) : undefined;
  return automated ? { ...context, automated } : context;
}

/** Reads the automation clips that drive this chain's knobs; undefined when none does (the usual case: no work at all). */
function automationReader(options: ContextOptions): FxContext['automated'] {
  const model = automationModelOf(options.project);
  const prefix = `mfx:${options.channelId}:`;
  let drivesAnyKnob = false;
  for (const key of model.targets.keys()) if (key.startsWith(prefix)) drivesAnyKnob = true;
  if (!drivesAnyKnob) return undefined;
  const effectOf = new Map(options.slots.map((slot) => [slot.id as string, slot.effect]));
  return (slotId, paramId, tick) => {
    const target: ParamTarget = { kind: 'midiFx', channelId: options.channelId, slotId: slotId as MidiFxSlot['id'], paramId };
    const automation = model.targets.get(targetKey(target));
    const hit = automation ? automationAt(automation, tick) : null;
    const spec = midiFxDef(effectOf.get(slotId) ?? '')?.params[paramId];
    return hit && spec ? encode(spec, fromNormalized(spec, hit.value)) : undefined;
  };
}
