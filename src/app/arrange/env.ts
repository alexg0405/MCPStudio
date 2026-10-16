/**
 * What the arranger (core/arrange) needs from the app: the roles the app's plugins imply, the song
 * key's scale, plugin param specs for automation, and the controls filter sweeps and throws move.
 * Sweeps automate EQ Pro bands on the Chords and Lead buses (b1, a low cut, for the build's
 * high-pass; b8, a high cut, for the intro and breakdown low-pass). When the song has no such bus,
 * one is made with the mix layout's names (reusing an empty "Insert N"), the chords or lead parts
 * that play straight to the master go through it, and it gets one EQ Pro with both bands on at
 * neutral (20 Hz and 20 kHz); the mix setup finds and reuses them by name.
 */
import type { Draft } from 'immer';
import type { ApplyEnv, SweepTargets } from '@core/arrange/apply';
import type { VariantEnv } from '@core/arrange/fills';
import { channelRoles, type Role, type RoleHint } from '@core/arrange/roles';
import { variantEnv } from '@core/arrange/variants';
import type { Style } from '@core/beat/style';
import { tempoMapOf } from '@core/automation/tempo';
import { makeInsert, makePluginInstance } from '@core/model/defaults';
import { newId } from '@core/model/ids';
import { MASTER, type ChannelId, type InsertId, type Project, type SampleRef, type SlotId } from '@core/model/types';
import { addFxSlot } from '@core/ops/mixer';
import { findEmptyInsert } from '@core/query/mixer';
import { wouldCycle } from '@core/query/routing';
import { getScale } from '@agstudio/sdk/notes';
import { defaultValues, type ParamSpecs } from '@agstudio/sdk';
import { kitDuration } from '../actions/samples';
import { BUS_NAMES, findMixLayout, type MixLayout } from '../mix/layout';
import type { Services } from '../services';

/** Roles the app's own plugins imply. */
export const roleHint: RoleHint = (pluginId) => {
  switch (pluginId) {
    case 'agstudio.bass808':
      return '808';
    case 'agstudio.drum-pads':
    case 'agstudio.drum-synth':
      return 'kit';
    case 'agstudio.slicer':
      return 'perc';
    default:
      return undefined;
  }
};

/** The song key's root and scale intervals (null without a key). */
export function scaleOf(p: Project): VariantEnv['scale'] {
  const key = p.transport.key;
  return key ? { root: key.root, intervals: getScale(key.scale).intervals } : null;
}

/** Every channel's role (the app's plugin hints included). */
export const rolesOf = (p: Project): Map<ChannelId, Role> => channelRoles(p, roleHint);

/** The generators' view of the project (draft-safe). */
export function variantEnvFor(p: Project, style: Style): VariantEnv {
  return variantEnv(p, { style, hint: roleHint, scale: scaleOf(p) });
}

export const specsResolver = (s: Services) => (pluginId: string) => s.plugins.get(pluginId)?.params as ParamSpecs | undefined;

const EQ_PRO = 'agstudio.eq-pro';
/** EQ Pro's sweep bands at neutral: a 20 Hz low cut and a 20 kHz high cut. */
const NEUTRAL_BANDS = { b1On: true, b1Type: 'lowCut24', b1Freq: 20, b8On: true, b8Type: 'highCut24', b8Freq: 20000 } as const;

const BUS_ROLES: Record<'chords' | 'lead', (r: Role) => boolean> = {
  chords: (r) => r === 'chords' || r === 'pad' || r === 'keys',
  lead: (r) => r === 'lead' || r === 'pluck' || r === 'arp' || r === 'vox',
};

const insertNumber = (p: Project, id: InsertId) => p.mixer.order.indexOf(id);

/**
 * Finds (or, with `create`, makes) the controls the arranger's curves move. Returns them and change
 * lines for what it made or rerouted.
 */
export function sweepTargets(
  d: Draft<Project>,
  s: Services,
  opts: { create: boolean; layout?: MixLayout },
): { targets: SweepTargets; layout: MixLayout; changes: string[] } {
  const p = d as unknown as Project;
  const layout = opts.layout ?? findMixLayout(p);
  const roles = rolesOf(p);
  const changes: string[] = [];
  const targets: SweepTargets = {};
  const eqDef = s.plugins.get(EQ_PRO);
  for (const bus of ['chords', 'lead'] as const) {
    const parts = p.channelOrder.filter((cid) => {
      const ch = p.channels[cid];
      return ch && ch.kind !== 'automation' && BUS_ROLES[bus](roles.get(cid) ?? 'other');
    });
    if (!parts.length) continue;
    let insertId = layout.buses[bus];
    if (!insertId) {
      if (!opts.create || !eqDef) continue;
      insertId = findEmptyInsert(p) ?? undefined;
      if (insertId) d.mixer.inserts[insertId]!.name = BUS_NAMES[bus];
      else {
        insertId = newId.insert();
        d.mixer.inserts[insertId] = makeInsert(insertId, BUS_NAMES[bus]);
        d.mixer.order.push(insertId);
      }
      layout.buses[bus] = insertId;
      // Its parts that play straight to the master go through it; so do tracks that only carry them.
      const moved: string[] = [];
      for (const cid of parts) {
        const ch = d.channels[cid];
        if (!ch || ch.kind === 'automation') continue;
        if (ch.output === MASTER) {
          ch.output = insertId;
          moved.push(ch.name);
          continue;
        }
        const via = d.mixer.inserts[ch.output];
        if (!via || via.id === insertId || Object.values(layout.buses).includes(via.id)) continue;
        const carries = p.channelOrder.filter((x) => {
          const c = p.channels[x];
          return c && c.kind !== 'automation' && c.output === via.id;
        });
        if (!carries.every((x) => BUS_ROLES[bus](roles.get(x) ?? 'other'))) continue;
        const toMaster = via.routes.findIndex((r) => r.to === MASTER);
        if (toMaster < 0 || via.routes.some((r) => r.to === insertId) || wouldCycle(d.mixer.inserts, via.id, insertId)) continue;
        via.routes[toMaster]!.to = insertId;
        moved.push(`${via.name} (Insert ${insertNumber(p, via.id)})`);
      }
      changes.push(
        `Made a ${BUS_NAMES[bus]} bus (Insert ${insertNumber(p, insertId)}) for filter sweeps${moved.length ? `: ${[...new Set(moved)].join(', ')} play through it` : ''}`,
      );
    }
    let slotId: SlotId | undefined = layout.eq[bus];
    const slot = slotId ? d.mixer.inserts[insertId]?.fx.find((f) => f.id === slotId) : undefined;
    if (slot) {
      if (!opts.create) {
        targets[bus] = { insertId, slotId: slot.id };
        continue;
      }
      // Bands that are off come on at neutral (they change nothing until a sweep moves them).
      const params = slot.plugin.params;
      if (params.b1On !== true) Object.assign(params, { b1On: true, b1Type: NEUTRAL_BANDS.b1Type, b1Freq: NEUTRAL_BANDS.b1Freq });
      if (params.b8On !== true) Object.assign(params, { b8On: true, b8Type: NEUTRAL_BANDS.b8Type, b8Freq: NEUTRAL_BANDS.b8Freq });
    } else {
      if (!opts.create || !eqDef) continue;
      const plugin = makePluginInstance(EQ_PRO, eqDef.version, { ...defaultValues(eqDef.params), ...NEUTRAL_BANDS });
      slotId = addFxSlot(d, insertId, plugin, 0) ?? undefined;
      if (!slotId) continue;
      layout.eq[bus] = slotId;
      changes.push(`Added EQ Pro to ${d.mixer.inserts[insertId]!.name} (its low and high cut move in the transitions)`);
    }
    if (slotId) targets[bus] = { insertId, slotId };
  }
  const chords = targets.chords?.insertId;
  const reverb = layout.buses.reverb;
  if (chords && reverb && d.mixer.inserts[chords]?.routes.some((r) => r.to === reverb)) targets.throw = { from: chords, to: reverb };
  return { targets, layout, changes };
}

/** The crash sound for crash hits: the song's crash channel's sample (its track and level), else the kit crash. */
function crashSound(p: Project): ApplyEnv['crash'] {
  const roles = rolesOf(p);
  for (const cid of p.channelOrder) {
    const ch = p.channels[cid];
    if (!ch || ch.kind !== 'instrument' || roles.get(cid) !== 'crash') continue;
    const sid = ch.plugin.samples?.main;
    const sample = sid ? p.samples[sid] : undefined;
    if (sample) return { sample, output: ch.output, volume: Math.min(0.8, ch.volume) };
  }
  return undefined;
}

/** Seconds a sample lasts (built-ins generated once, FX from their names). */
export const sampleSeconds = (ref: SampleRef): number | null =>
  ref.durationSec ?? (ref.source.kind === 'builtin' ? kitDuration(ref.source.generator) || null : null);

/**
 * Everything applying needs, for a draft: the variant env, specs, tempo, sweep targets (made when
 * `create`), the FX bus and the crash sound. `base` is the committed project (its tempo map).
 */
export function applyEnvFor(
  d: Draft<Project>,
  s: Services,
  base: Project,
  style: Style,
  opts: { create: boolean; layout?: MixLayout },
): { env: ApplyEnv; changes: string[]; layout: MixLayout } {
  const p = d as unknown as Project;
  const { targets, layout, changes } = sweepTargets(d, s, opts);
  const env: ApplyEnv = {
    variant: variantEnvFor(p, style),
    specsOf: specsResolver(s),
    tempo: tempoMapOf(base, 'song'),
    targets,
    sampleSeconds,
  };
  const crash = crashSound(p);
  if (crash) env.crash = crash;
  else if (layout.buses.drums) env.crash = { sample: { id: newId.sample(), name: 'Crash', source: { kind: 'builtin', generator: 'kit/crash', version: 1 } }, output: layout.buses.drums, volume: 0.55 };
  if (layout.buses.fx) env.fxOutput = layout.buses.fx;
  return { env, changes, layout };
}
