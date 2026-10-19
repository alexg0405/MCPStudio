/**
 * What an automation target (or a controller link) controls: its spec, its document value, and how
 * the normalized 0–1 values of curves map onto it. Volume faders and send levels use the fader
 * taper, so a curve at 80 % is 0 dB like the fader; plugin params use their own scale (log, …).
 */
import { decode, encode, fromNormalized, toNormalized, type ParamSpec, type ParamSpecs } from '@agstudio/sdk/params';
import { faderToGain, gainToFader } from '../model/fader';
import {
  CHANNEL_PAN_SPEC,
  CHANNEL_PITCH_SPEC,
  CHANNEL_VOLUME_SPEC,
  INSERT_PAN_SPEC,
  INSERT_VOLUME_SPEC,
  ROUTE_LEVEL_SPEC,
  SLOT_MIX_SPEC,
  TEMPO_SPEC,
  VCA_SPEC,
} from '../model/target-specs';
import { targetKey } from '../model/targets';
import type { ParamTarget, Project } from '../model/types';
import { pluginInstanceOf } from '../query/mixer';

/** Param specs of a plugin by id (the app's registry; core can't see plugin definitions). */
export type SpecsResolver = (pluginId: string) => ParamSpecs | undefined;

/** Default tempo range of a tempo automation clip (BPM). */
export const TEMPO_RANGE = { min: 60, max: 180 } as const;

export interface ResolvedTarget {
  key: string;
  spec: ParamSpec;
  /** The document value, numeric (enum → option index, bool → 0/1). */
  base: number;
  toNormalized(value: number): number;
  fromNormalized(n: number): number;
}

const clamp01 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x);

function bySpec(key: string, spec: ParamSpec, base: number): ResolvedTarget {
  return {
    key,
    spec,
    base,
    toNormalized: (v) => toNormalized(spec, decode(spec, v)),
    fromNormalized: (n) => encode(spec, fromNormalized(spec, n)),
  };
}

function byFader(key: string, spec: ParamSpec, base: number): ResolvedTarget {
  const max = spec.type === 'float' ? spec.max : 1;
  return {
    key,
    spec,
    base,
    toNormalized: (g) => clamp01(gainToFader(g)),
    fromNormalized: (n) => Math.min(max, faderToGain(clamp01(n))),
  };
}

/**
 * Resolves a target against the project, or null when what it points at no longer exists.
 * `range` (tempo clips) overrides the tempo's normalized span.
 */
export function resolveTarget(
  p: Project,
  t: ParamTarget,
  specsOf: SpecsResolver,
  range?: { min: number; max: number },
): ResolvedTarget | null {
  const key = targetKey(t);
  switch (t.kind) {
    case 'channel': {
      const ch = p.channels[t.channelId];
      if (!ch || ch.kind === 'automation') return null;
      if (t.param === 'volume') return bySpec(key, CHANNEL_VOLUME_SPEC, ch.volume);
      if (t.param === 'pan') return bySpec(key, CHANNEL_PAN_SPEC, ch.pan);
      return ch.kind === 'instrument' ? bySpec(key, CHANNEL_PITCH_SPEC, ch.pitch ?? 0) : null;
    }
    case 'insert': {
      const ins = p.mixer.inserts[t.insertId];
      if (!ins) return null;
      return t.param === 'volume'
        ? byFader(key, INSERT_VOLUME_SPEC, ins.volume)
        : bySpec(key, INSERT_PAN_SPEC, ins.pan);
    }
    case 'slot': {
      const slot = p.mixer.inserts[t.insertId]?.fx.find((s) => s.id === t.slotId);
      return slot ? bySpec(key, SLOT_MIX_SPEC, slot.mix) : null;
    }
    case 'route': {
      const r = p.mixer.inserts[t.insertId]?.routes.find((x) => x.to === t.to);
      return r ? byFader(key, ROUTE_LEVEL_SPEC, r.level) : null;
    }
    case 'vca': {
      const group = p.mixer.groups?.find((g) => g.id === t.groupId);
      return group?.vca === undefined ? null : byFader(key, VCA_SPEC, group.vca);
    }
    case 'plugin': {
      const inst = pluginInstanceOf(p, t.owner);
      const spec = inst ? specsOf(inst.pluginId)?.[t.paramId] : undefined;
      if (!inst || !spec) return null;
      const raw = inst.params[t.paramId];
      return bySpec(key, spec, encode(spec, raw ?? spec.default));
    }
    case 'tempo': {
      const r = range && range.min < range.max ? range : TEMPO_RANGE;
      return {
        key,
        spec: TEMPO_SPEC,
        base: p.transport.bpm,
        toNormalized: (bpm) => clamp01((bpm - r.min) / (r.max - r.min)),
        fromNormalized: (n) => r.min + clamp01(n) * (r.max - r.min),
      };
    }
  }
}
