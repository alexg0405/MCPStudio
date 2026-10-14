/**
 * Applies the AI's actions to the project as ONE undoable edit. Every field is validated: things are
 * found by id, exact name, mixer number or an @ref created earlier in the same answer; plugin
 * settings are coerced to each param's real spec (units, ranges, option ids). An action that can't
 * be applied is skipped with a warning; the rest still apply. UI-only requests (open a window, play)
 * are returned for the caller to run after the edit.
 */
import type { Draft } from 'immer';
import { LFO_SHAPES, lfoPoints, type LfoShape } from '@core/automation/generate';
import { formatAutomationValue, targetName } from '@core/automation/labels';
import { resolveTarget, TEMPO_RANGE, type ResolvedTarget } from '@core/automation/targets';
import { validateBeatSpec } from '@core/beat/spec';
import { makeInsert, makePattern, makePluginInstance, paletteColor } from '@core/model/defaults';
import { MAX_INSERT_VOLUME } from '@core/model/fader';
import { newId } from '@core/model/ids';
import { KIT } from '@core/model/kit';
import {
  MASTER,
  type AutoPoint,
  type AutoShape,
  type ChannelId,
  type Clip,
  type FxSlot,
  type InsertId,
  type Note,
  type PatternClip,
  type ParamTarget,
  type PatternId,
  type PluginInstance,
  type PluginOwner,
  type Project,
  type SlotId,
} from '@core/model/types';
import { createAutomationClip } from '@core/ops/automation';
import { addChannel, addSample, removeChannel, setChannelProp } from '@core/ops/channels';
import {
  addFxSlot,
  addInsert,
  moveFxSlot,
  removeFxSlot,
  removeInsert,
  replaceFxPlugin,
  setFxSlotEnabled,
  setFxSlotMix,
  setInsertProp,
} from '@core/ops/mixer';
import { applyNoteReplacement, planNoteReplacement } from '@core/ops/note-replace';
import { addNotes, setBpm, setSongKey, setSwing } from '@core/ops/notes';
import { clearSteps, fillSteps, randomizeSteps, reverseSteps, rotateSteps, shiftSteps } from '@core/ops/steps';
import { addClips, addPattern, removeClips, removePattern, setPatternProps } from '@core/ops/playlist';
import { removeRoute, routeOnlyTo, setRoute, setSlotSidechain } from '@core/ops/routing';
import { insertLabel } from '@core/query/mixer';
import { notesSorted, patternLength } from '@core/query/queries';
import { PPQ, stepsPerBar, ticksPerBar, TICKS_PER_STEP } from '@core/time/ppq';
import { SCALES } from '@agstudio/sdk/notes';
import {
  dbToGain,
  defaultValues,
  encode,
  formatValue,
  isAutomatable,
  type JsonValue,
  type ParamSpec,
  type ParamSpecs,
  type ParamValue,
  type PluginDef,
} from '@agstudio/sdk';
import { NoteScriptError, runNoteScript } from '../actions/note-scripts';
import { tempoRange } from '../automation';
import { planBeat, showBeat, writeBeat, type AppliedBeat, type BeatPlan } from '../assistant/apply';
import { instrumentChannelFor, kitSampleRef, SAMPLER_ID } from '../default-project';
import type { Services } from '../services';
import type { AiAction, AiAnswer } from './schema';

/** What the UI should do after the edit. */
export type AfterEdit =
  | {
      kind: 'open';
      window: 'mixer' | 'channel-rack' | 'piano-roll' | 'playlist' | 'plugin';
      channelId?: ChannelId;
      insertId?: InsertId;
      slotId?: SlotId;
    }
  | { kind: 'play'; fromTick?: number; mode?: 'pattern' | 'song'; record?: boolean }
  | { kind: 'stop' }
  | { kind: 'metronome'; on: boolean }
  | { kind: 'mode'; mode: 'pattern' | 'song' };

export interface AppliedTurn {
  /** One line per change, for the chat. */
  changes: string[];
  /** Actions that couldn't be applied, and why. */
  warnings: string[];
  /** Set when a beat was written (follow-ups change the same pattern). */
  beat: AppliedBeat | null;
  after: AfterEdit[];
  /** Whether the project changed (an undo step was made). */
  edited: boolean;
}

class ActionError extends Error {}
const fail = (message: string): never => {
  throw new ActionError(message);
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
const lower = (x: string) => x.trim().toLowerCase();
const r2 = (v: number) => Math.round(v * 100) / 100;

const NOTE_NAMES: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

const SCALE_ALIASES: Record<string, string> = {
  '': 'major',
  m: 'minor',
  min: 'minor',
  maj: 'major',
  ionian: 'major',
  aeolian: 'minor',
  'natural-minor': 'minor',
  'pentatonic-minor': 'minor-pentatonic',
  'pentatonic-major': 'major-pentatonic',
  pentatonic: 'major-pentatonic',
  'minor-blues': 'blues',
  'blues-major': 'major-blues',
};

/** "F# minor" → { root: 6, scale: 'minor' }; "none" → null; undefined if unreadable. Scales are the SDK's ids. */
export function parseKey(text: string): { root: number; scale: string } | null | undefined {
  const t = lower(text);
  if (t === 'none' || t === 'no key' || t === '') return null;
  const m = /^([a-g])\s*(#|♯|b|♭)?\s*(.*)$/.exec(t);
  if (!m) return undefined;
  let root = NOTE_NAMES[m[1]!]!;
  if (m[2] === '#' || m[2] === '♯') root += 1;
  if (m[2] === 'b' || m[2] === '♭') root -= 1;
  const words = (m[3] ?? '').replace(/\b(scale|mode|key)\b/g, '').trim().replace(/\s+/g, '-');
  const scale =
    SCALE_ALIASES[words] ??
    SCALES.find((sc) => sc.id === words || lower(sc.label).replace(/\s+/g, '-') === words)?.id;
  return scale ? { root: ((root % 12) + 12) % 12, scale } : undefined;
}

/** A value the AI wrote, turned into a valid value of the param (null when it can't be). */
export function coerceParam(spec: ParamSpec, raw: unknown): ParamValue | null {
  switch (spec.type) {
    case 'float':
    case 'int': {
      let n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseFloat(raw) : Number.NaN;
      if (typeof raw === 'boolean') n = raw ? spec.max : spec.min;
      if (!Number.isFinite(n)) return null;
      // "50" for 50 % → 0.5.
      if (spec.unit === '%' && spec.max <= 1 && n > 1 && n <= 100) n /= 100;
      n = Math.min(spec.max, Math.max(spec.min, n));
      return spec.type === 'int' ? Math.round(n) : n;
    }
    case 'enum': {
      const t = lower(String(raw));
      const labels = spec.labels as Record<string, string | undefined> | undefined;
      const hit =
        spec.options.find((o) => lower(o) === t) ?? spec.options.find((o) => labels?.[o] && lower(labels[o]!) === t);
      if (hit) return hit;
      if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw < spec.options.length)
        return spec.options[raw]!;
      return null;
    }
    case 'bool': {
      if (typeof raw === 'boolean') return raw;
      if (typeof raw === 'number') return raw >= 0.5;
      const t = lower(String(raw));
      if (['on', 'true', 'yes', '1'].includes(t)) return true;
      if (['off', 'false', 'no', '0'].includes(t)) return false;
      return null;
    }
  }
}

function findParamId(specs: ParamSpecs, name: string): string | undefined {
  if (specs[name]) return name;
  const t = lower(name);
  return Object.keys(specs).find((id) => lower(id) === t || lower((specs[id] as ParamSpec).label ?? '') === t);
}

export interface ApplyContext {
  /** The beat the conversation is working on (a beat action changes it in place). */
  previousBeat: AppliedBeat | null;
  /** Undo label (the request); defaults to the start of the message. */
  label?: string;
}

export function applyAnswer(s: Services, answer: AiAnswer, ctx: ApplyContext): AppliedTurn {
  const changes: string[] = [];
  const warnings: string[] = [];
  const after: AfterEdit[] = [];
  let beatPlan: BeatPlan | null = null;
  // Selections are applied after the edit (the stores then point at committed things).
  let selectChannel: ChannelId | null = null;
  let selectPattern: PatternId | null = null;
  type Ref =
    | { kind: 'channel'; id: ChannelId }
    | { kind: 'insert'; id: InsertId }
    | { kind: 'effect'; insertId: InsertId; slotId: SlotId }
    | { kind: 'pattern'; id: PatternId };
  const refs = new Map<string, Ref>();
  const docActions = answer.actions.filter((a) => a.op !== 'transport' && a.op !== 'open');
  const words = (ctx.label ?? answer.message.split(/[.!?]/)[0] ?? '').trim();
  const label = words.length > 48 ? `${words.slice(0, 47).trimEnd()}…` : words || 'edit';

  const edited =
    docActions.length > 0 &&
    s.history.transact(`AI: ${label}`, (d) => {
      const project = d as unknown as Project;
      const bar = () => ticksPerBar(d.transport.timeSig);

      // ---- lookups (on the draft, so earlier actions are visible) ----
      const fromRef = <K extends Ref['kind']>(ref: string, kind: K): Extract<Ref, { kind: K }> | undefined => {
        if (!ref.startsWith('@')) return undefined;
        const r = refs.get(lower(ref));
        if (!r) fail(`nothing called ${ref} was created earlier in this answer`);
        if (r!.kind !== kind) fail(`${ref} is a ${r!.kind}, not a ${kind}`);
        return r as Extract<Ref, { kind: K }>;
      };
      const byName = <T extends { id: string; name: string }>(items: T[], ref: string): T | undefined => {
        const t = lower(ref);
        const exact = items.filter((x) => lower(x.name) === t);
        if (exact.length === 1) return exact[0];
        const partial = items.filter((x) => lower(x.name).includes(t));
        return partial.length === 1 ? partial[0] : undefined;
      };
      const channel = (raw: unknown): ChannelId => {
        const ref = str(raw) ?? fail('which channel?');
        const r = fromRef(ref, 'channel');
        if (r) return r.id;
        if (d.channels[ref as ChannelId]) return ref as ChannelId;
        const list = d.channelOrder.map((id) => d.channels[id]).filter((c) => !!c) as { id: string; name: string }[];
        return (byName(list, ref)?.id as ChannelId | undefined) ?? fail(`there is no channel "${ref}"`);
      };
      const insert = (raw: unknown): InsertId => {
        const ref = str(raw) ?? (typeof raw === 'number' ? String(raw) : fail('which mixer track?'));
        if (lower(ref) === 'master') return MASTER;
        const r = fromRef(ref, 'insert');
        if (r) return r.id;
        if (d.mixer.inserts[ref as InsertId]) return ref as InsertId;
        const m = /^(?:insert|track|mixer track)?\s*#?(\d+)$/i.exec(ref);
        if (m) return (d.mixer.order[Number(m[1])] as InsertId | undefined) ?? fail(`there is no mixer track ${m[1]}`);
        const list = d.mixer.order.map((id) => d.mixer.inserts[id]).filter((x) => !!x) as {
          id: string;
          name: string;
        }[];
        return (byName(list, ref)?.id as InsertId | undefined) ?? fail(`there is no mixer track "${ref}"`);
      };
      const effect = (raw: unknown): { insertId: InsertId; slotId: SlotId } => {
        const ref = str(raw) ?? fail('which effect?');
        const r = fromRef(ref, 'effect');
        if (r) return { insertId: r.insertId, slotId: r.slotId };
        for (const id of d.mixer.order) {
          const ins = d.mixer.inserts[id];
          if (ins?.fx.some((f) => f.id === ref)) return { insertId: id, slotId: ref as SlotId };
        }
        const m = /^(?:insert\s*)?(\w+)\s*[:/]\s*(?:slot\s*)?(\d+)$/i.exec(ref);
        if (m) {
          const insertId = insert(m[1]);
          const slot = d.mixer.inserts[insertId]?.fx[Number(m[2]) - 1];
          if (slot) return { insertId, slotId: slot.id };
        }
        return fail(`there is no effect "${ref}"`);
      };
      const pattern = (raw: unknown): PatternId => {
        const ref = str(raw) ?? fail('which pattern?');
        if (lower(ref) === 'current') {
          const cur = s.view.getState().currentPatternId;
          if (cur && d.patterns[cur]) return cur;
          return (d.patternOrder[0] as PatternId | undefined) ?? fail('there are no patterns');
        }
        const r = fromRef(ref, 'pattern');
        if (r) return r.id;
        if (d.patterns[ref as PatternId]) return ref as PatternId;
        const list = d.patternOrder.map((id) => d.patterns[id]).filter((x) => !!x) as { id: string; name: string }[];
        return (byName(list, ref)?.id as PatternId | undefined) ?? fail(`there is no pattern "${ref}"`);
      };
      const plugin = (raw: unknown, kind: PluginDef['kind']): PluginDef => {
        const id = str(raw) ?? fail('which plugin?');
        const def =
          s.plugins.get(id) ??
          s.plugins.list(kind).find((e) => lower(e.def.name) === lower(id) || lower(e.def.id) === lower(id))?.def;
        if (!def) fail(`there is no plugin "${id}"`);
        if (def!.kind !== kind) fail(`"${def!.name}" is an ${def!.kind}, not an ${kind}`);
        return def!;
      };
      const remember = (raw: unknown, r: Ref) => {
        const ref = str(raw);
        if (ref) refs.set(lower(ref.startsWith('@') ? ref : `@${ref}`), r);
      };

      // ---- plugin settings ----
      const settings = (inst: Draft<PluginInstance>, def: PluginDef, a: AiAction): string[] => {
        const out: string[] = [];
        const presetName = str(a.preset);
        if (presetName) {
          const preset = def.presets?.find((p) => lower(p.name) === lower(presetName));
          if (!preset) warnings.push(`${def.name} has no preset "${presetName}"`);
          else {
            inst.params = { ...defaultValues(def.params), ...(preset.params as Record<string, ParamValue>) };
            if (preset.state !== undefined) inst.state = preset.state as JsonValue as never;
            out.push(`preset ${preset.name}`);
          }
        }
        if (Array.isArray(a.params)) {
          const specs = def.params as ParamSpecs;
          for (const e of a.params) {
            if (!isObj(e) || typeof e.name !== 'string') continue;
            const id = findParamId(specs, e.name);
            if (!id) {
              warnings.push(`${def.name} has no setting "${e.name}"`);
              continue;
            }
            const spec = specs[id] as ParamSpec;
            const v = coerceParam(spec, e.value);
            if (v === null) {
              warnings.push(`${def.name} ${id}: can't use ${JSON.stringify(e.value)}`);
              continue;
            }
            inst.params[id] = v;
            out.push(`${spec.label ?? id} ${formatValue(spec, v)}`);
          }
        }
        return out;
      };
      const channelGain = (dbv: number) => Math.min(1.25, dbv <= -100 ? 0 : dbToGain(dbv));
      const insertGain = (dbv: number) => Math.min(MAX_INSERT_VOLUME, dbv <= -100 ? 0 : dbToGain(dbv));
      const kitSample = (raw: unknown, fallbackName: string): string | undefined => {
        const want = lower(str(raw) ?? fallbackName);
        const alias: Record<string, string> = {
          kick: 'kit/kick',
          snare: 'kit/snare',
          clap: 'kit/clap',
          hat: 'kit/hat-closed',
          'closed hat': 'kit/hat-closed',
          hihat: 'kit/hat-closed',
          'hi-hat': 'kit/hat-closed',
          'open-hat': 'kit/hat-open',
          'open hat': 'kit/hat-open',
          'tom-low': 'kit/tom-low',
          'tom-mid': 'kit/tom-mid',
          'tom-high': 'kit/tom-high',
          rim: 'kit/rim',
          cowbell: 'kit/cowbell',
          crash: 'kit/crash',
        };
        if (alias[want]) return alias[want];
        const piece = KIT.find((k) => lower(k.name) === want || want.includes(lower(k.short)));
        return piece?.generator;
      };

      const ops: Record<string, (a: AiAction) => string | null> = {
        song: (a) => {
          const out: string[] = [];
          const bpm = num(a.bpm);
          if (bpm !== undefined) {
            setBpm(d, bpm);
            out.push(`tempo ${d.transport.bpm} BPM`);
          }
          const swing = num(a.swing);
          if (swing !== undefined) {
            setSwing(d, swing > 1 && swing <= 100 ? swing / 100 : swing);
            out.push(`swing ${Math.round(d.transport.swing * 100)}%`);
          }
          const keyText = str(a.key);
          if (keyText) {
            const key = parseKey(keyText);
            if (key === undefined) warnings.push(`can't read the key "${keyText}"`);
            else {
              setSongKey(d, key);
              out.push(key ? `key ${keyText}` : 'no key');
            }
          }
          const sig = str(a.time_signature);
          if (sig) {
            const m = /^(\d+)\s*\/\s*(\d+)$/.exec(sig);
            const n = m ? Number(m[1]) : 0;
            const den = m ? Number(m[2]) : 0;
            if (n >= 1 && n <= 32 && [1, 2, 4, 8, 16, 32].includes(den)) {
              d.transport.timeSig = { num: n, den };
              out.push(`time signature ${n}/${den}`);
            } else warnings.push(`can't use the time signature "${sig}"`);
          }
          return out.length ? `Song: ${out.join(', ')}` : null;
        },

        add_channel: (a) => {
          const def = plugin(a.plugin, 'instrument');
          const name = str(a.name) ?? def.name;
          let samples: Record<string, ReturnType<typeof newId.sample>> | undefined;
          if (def.sampleSlots?.includes('main') || def.id === SAMPLER_ID) {
            const generator = kitSample(a.sample, name);
            if (generator) {
              const ref = kitSampleRef(generator);
              addSample(d, ref);
              samples = { main: ref.id };
            } else warnings.push(`"${name}" has no sample yet (say which kit sound it should play)`);
          }
          const ch = instrumentChannelFor(def, name, d.channelOrder.length, samples);
          const parts = settings(ch.plugin as Draft<PluginInstance>, def, a);
          const vol = num(a.volume_db);
          if (vol !== undefined) {
            ch.volume = channelGain(vol);
            parts.push(`volume ${r2(vol)} dB`);
          }
          const pan = num(a.pan);
          if (pan !== undefined) {
            ch.pan = Math.max(-1, Math.min(1, pan));
            parts.push(`pan ${r2(pan)}`);
          }
          const color = str(a.color);
          if (color && /^#[0-9a-f]{6}$/i.test(color)) ch.color = color;
          if (a.insert !== undefined) ch.output = insert(a.insert);
          addChannel(d, ch);
          remember(a.ref, { kind: 'channel', id: ch.id });
          after.push({ kind: 'open', window: 'channel-rack' });
          selectChannel = ch.id;
          return `Added channel “${name}” (${def.name}${parts.length ? `: ${parts.join(', ')}` : ''})${
            ch.output !== MASTER ? ` → ${insertLabel(project, ch.output)}` : ''
          }`;
        },

        edit_channel: (a) => {
          const id = channel(a.channel);
          const ch = d.channels[id]!;
          const out: string[] = [];
          if (ch.kind === 'instrument') {
            const swap = str(a.plugin);
            let def = s.plugins.get(ch.plugin.pluginId);
            if (swap) {
              def = plugin(swap, 'instrument');
              ch.plugin = makePluginInstance(def.id, def.version, defaultValues(def.params), {
                ...(ch.plugin.samples && def.sampleSlots?.length ? { samples: { ...ch.plugin.samples } } : {}),
              }) as Draft<PluginInstance>;
              out.push(`instrument ${def.name}`);
            }
            if (def && (a.preset !== undefined || a.params !== undefined)) out.push(...settings(ch.plugin, def, a));
            else if (!def && (a.preset !== undefined || a.params !== undefined))
              warnings.push(`“${ch.name}”'s plugin isn't installed`);
            const pitch = num(a.pitch_cents);
            if (pitch !== undefined) {
              ch.pitch = Math.max(-2400, Math.min(2400, pitch));
              out.push(`pitch ${ch.pitch} ct`);
            }
          } else if (a.plugin !== undefined || a.params !== undefined || a.preset !== undefined)
            warnings.push(`“${ch.name}” has no instrument`);
          const name = str(a.name);
          if (name) {
            setChannelProp(d, id, 'name', name);
            out.push(`renamed “${name}”`);
          }
          const vol = num(a.volume_db);
          if (vol !== undefined) {
            setChannelProp(d, id, 'volume', channelGain(vol));
            out.push(`volume ${r2(vol)} dB`);
          }
          const pan = num(a.pan);
          if (pan !== undefined) {
            setChannelProp(d, id, 'pan', pan);
            out.push(`pan ${r2(pan)}`);
          }
          const mute = bool(a.mute);
          if (mute !== undefined) {
            ch.muted = mute;
            out.push(mute ? 'muted' : 'unmuted');
          }
          const solo = bool(a.solo);
          if (solo !== undefined) {
            ch.solo = solo;
            out.push(solo ? 'solo' : 'unsolo');
          }
          if (a.insert !== undefined) {
            const to = insert(a.insert);
            setChannelProp(d, id, 'output', to);
            out.push(`→ ${insertLabel(project, to)}`);
          }
          const color = str(a.color);
          if (color && /^#[0-9a-f]{6}$/i.test(color)) setChannelProp(d, id, 'color', color);
          return out.length ? `“${ch.name}”: ${out.join(', ')}` : null;
        },

        remove_channel: (a) => {
          const id = channel(a.channel);
          const name = d.channels[id]!.name;
          removeChannel(d, id);
          return `Deleted channel “${name}”`;
        },

        add_insert: (a) => {
          const id = newId.insert();
          addInsert(d, makeInsert(id, str(a.name) ?? `Insert ${d.mixer.order.length}`));
          const extra: string[] = [];
          const vol = num(a.volume_db);
          if (vol !== undefined) {
            setInsertProp(d, id, 'volume', insertGain(vol));
            extra.push(`fader ${r2(vol)} dB`);
          }
          const pan = num(a.pan);
          if (pan !== undefined) {
            setInsertProp(d, id, 'pan', pan);
            extra.push(`pan ${r2(pan)}`);
          }
          const color = str(a.color);
          if (color) setInsertProp(d, id, 'color', color);
          remember(a.ref, { kind: 'insert', id });
          return `Added mixer track ${insertLabel(project, id)} “${d.mixer.inserts[id]!.name}”${
            extra.length ? ` (${extra.join(', ')})` : ''
          }`;
        },

        edit_insert: (a) => {
          const id = insert(a.insert);
          const out: string[] = [];
          const name = str(a.name);
          if (name) {
            setInsertProp(d, id, 'name', name);
            out.push(`renamed “${name}”`);
          }
          const vol = num(a.volume_db);
          if (vol !== undefined) {
            setInsertProp(d, id, 'volume', insertGain(vol));
            out.push(`fader ${r2(vol)} dB`);
          }
          const pan = num(a.pan);
          if (pan !== undefined) {
            setInsertProp(d, id, 'pan', pan);
            out.push(`pan ${r2(pan)}`);
          }
          const mute = bool(a.mute);
          if (mute !== undefined) {
            setInsertProp(d, id, 'muted', mute);
            out.push(mute ? 'muted' : 'unmuted');
          }
          const solo = bool(a.solo);
          if (solo !== undefined) {
            setInsertProp(d, id, 'solo', solo);
            out.push(solo ? 'solo' : 'unsolo');
          }
          const color = str(a.color);
          if (color) setInsertProp(d, id, 'color', color);
          return out.length ? `${insertLabel(project, id)}: ${out.join(', ')}` : null;
        },

        remove_insert: (a) => {
          const id = insert(a.insert);
          if (id === MASTER) fail("the Master track can't be deleted");
          const label = insertLabel(project, id);
          removeInsert(d, id);
          return `Deleted mixer track ${label}`;
        },

        add_effect: (a) => {
          const insertId = insert(a.insert);
          const def = plugin(a.plugin, 'effect');
          const inst = makePluginInstance(def.id, def.version, defaultValues(def.params)) as Draft<PluginInstance>;
          const parts = settings(inst, def, a);
          const pos = num(a.position);
          const slotId = addFxSlot(d, insertId, inst as PluginInstance, pos !== undefined ? pos - 1 : undefined);
          if (!slotId) fail(`${insertLabel(project, insertId)} has no free effect slot`);
          const mix = num(a.mix);
          if (mix !== undefined) setFxSlotMix(d, insertId, slotId!, mix > 1 && mix <= 100 ? mix / 100 : mix);
          if (bool(a.enabled) === false) setFxSlotEnabled(d, insertId, slotId!, false);
          remember(a.ref, { kind: 'effect', insertId, slotId: slotId! });
          return `Added ${def.name} to ${insertLabel(project, insertId)}${parts.length ? ` (${parts.join(', ')})` : ''}`;
        },

        edit_effect: (a) => {
          const { insertId, slotId } = effect(a.effect);
          const slot = d.mixer.inserts[insertId]!.fx.find((f) => f.id === slotId) as Draft<FxSlot>;
          const out: string[] = [];
          let def = s.plugins.get(slot.plugin.pluginId);
          const swap = str(a.plugin);
          if (swap) {
            def = plugin(swap, 'effect');
            replaceFxPlugin(d, insertId, slotId, makePluginInstance(def.id, def.version, defaultValues(def.params)));
            out.push(`now ${def.name}`);
          }
          if (def && (a.preset !== undefined || a.params !== undefined)) {
            const live = d.mixer.inserts[insertId]!.fx.find((f) => f.id === slotId)!;
            out.push(...settings(live.plugin, def, a));
          }
          const mix = num(a.mix);
          if (mix !== undefined) {
            setFxSlotMix(d, insertId, slotId, mix > 1 && mix <= 100 ? mix / 100 : mix);
            out.push(`mix ${Math.round(slot.mix * 100)}%`);
          }
          const enabled = bool(a.enabled);
          if (enabled !== undefined) {
            setFxSlotEnabled(d, insertId, slotId, enabled);
            out.push(enabled ? 'on' : 'bypassed');
          }
          const pos = num(a.position);
          if (pos !== undefined) {
            moveFxSlot(d, insertId, slotId, pos - 1);
            out.push(`slot ${pos}`);
          }
          return out.length ? `${def?.name ?? 'Effect'} on ${insertLabel(project, insertId)}: ${out.join(', ')}` : null;
        },

        remove_effect: (a) => {
          const { insertId, slotId } = effect(a.effect);
          const slot = d.mixer.inserts[insertId]!.fx.find((f) => f.id === slotId)!;
          const name = s.plugins.get(slot.plugin.pluginId)?.name ?? slot.plugin.pluginId;
          removeFxSlot(d, insertId, slotId);
          return `Removed ${name} from ${insertLabel(project, insertId)}`;
        },

        route: (a) => {
          const from = insert(a.from);
          const to = insert(a.to);
          const level = num(a.level_db);
          const pre = bool(a.pre);
          const ok = setRoute(d, from, to, {
            ...(level !== undefined ? { level: insertGain(level) } : {}),
            ...(pre !== undefined ? { pre } : {}),
          });
          if (!ok)
            fail(`${insertLabel(project, from)} can't route to ${insertLabel(project, to)} (it would loop back)`);
          return `${insertLabel(project, from)} → ${insertLabel(project, to)}${level !== undefined ? ` at ${r2(level)} dB` : ''}${pre ? ' (pre-fader)' : ''}`;
        },

        unroute: (a) => {
          const from = insert(a.from);
          const to = insert(a.to);
          removeRoute(d, from, to);
          return `${insertLabel(project, from)} no longer routes to ${insertLabel(project, to)}`;
        },

        route_only: (a) => {
          const from = insert(a.from);
          const to = insert(a.to);
          if (!routeOnlyTo(d, from, to))
            fail(`${insertLabel(project, from)} can't route to ${insertLabel(project, to)} (it would loop back)`);
          return `${insertLabel(project, from)} now routes only to ${insertLabel(project, to)}`;
        },

        sidechain: (a) => {
          const { insertId, slotId } = effect(a.effect);
          const slot = d.mixer.inserts[insertId]!.fx.find((f) => f.id === slotId)!;
          const def = s.plugins.get(slot.plugin.pluginId);
          const fromText = str(a.from);
          const source = !fromText || lower(fromText) === 'none' ? null : insert(fromText);
          if (source && def?.kind === 'effect' && !def.sidechain) fail(`${def.name} has no sidechain input`);
          if (!setSlotSidechain(d, insertId, slotId, source)) fail('that sidechain would make audio loop');
          return source
            ? `${def?.name ?? 'Effect'} on ${insertLabel(project, insertId)} listens to ${insertLabel(project, source)}`
            : `${def?.name ?? 'Effect'} on ${insertLabel(project, insertId)}: no sidechain`;
        },

        add_pattern: (a) => {
          const id = newId.pattern();
          const name = str(a.name) ?? `Pattern ${d.patternOrder.length + 1}`;
          addPattern(d, makePattern(name, paletteColor(d.patternOrder.length), id));
          const bars = num(a.bars);
          if (bars !== undefined && bars > 0) {
            d.patterns[id]!.length = Math.round(bars * bar());
            d.patterns[id]!.stepCount = Math.max(1, Math.round(bars * stepsPerBar(d.transport.timeSig)));
          }
          remember(a.ref, { kind: 'pattern', id });
          selectPattern = id;
          return `Added pattern “${name}”`;
        },

        edit_pattern: (a) => {
          const id = pattern(a.pattern);
          const out: string[] = [];
          const name = str(a.name);
          const color = str(a.color);
          if (name || color) setPatternProps(d, id, { ...(name ? { name } : {}), ...(color ? { color } : {}) });
          if (name) out.push(`renamed “${name}”`);
          const bars = num(a.bars);
          if (bars !== undefined && bars > 0) {
            d.patterns[id]!.length = Math.round(bars * bar());
            d.patterns[id]!.stepCount = Math.max(1, Math.round(bars * stepsPerBar(d.transport.timeSig)));
            out.push(`${r2(bars)} bars`);
          }
          return out.length ? `Pattern “${d.patterns[id]!.name}”: ${out.join(', ')}` : null;
        },

        remove_pattern: (a) => {
          const id = pattern(a.pattern);
          if (d.patternOrder.length <= 1) fail('the project needs at least one pattern');
          const name = d.patterns[id]!.name;
          removePattern(d, id);
          return `Deleted pattern “${name}”`;
        },

        write_notes: (a) => {
          const pid = pattern(a.pattern);
          const cid = channel(a.channel);
          const ch = d.channels[cid]!;
          if (ch.kind !== 'instrument') fail(`“${ch.name}” doesn't play notes`);
          const root = ch.kind === 'instrument' ? ch.rootKey : 60;
          const raw = Array.isArray(a.notes) ? a.notes : [];
          const notes: Note[] = [];
          for (const n of raw) {
            if (!isObj(n)) continue;
            const step = num(n.step);
            if (step === undefined || step < 0) continue;
            const len = num(n.len) ?? 1;
            const key = num(n.key);
            const vel = num(n.vel);
            notes.push({
              id: newId.note(),
              tick: Math.round(step * TICKS_PER_STEP),
              length: Math.max(10, Math.round(Math.max(0.05, len) * TICKS_PER_STEP)),
              key: Math.max(0, Math.min(127, Math.round(key ?? root))),
              velocity: Math.max(0, Math.min(1, vel !== undefined && vel > 1 ? vel / 127 : (vel ?? 0.8))),
            });
          }
          const pat = d.patterns[pid]!;
          if (a.replace !== false) delete pat.notes[cid];
          addNotes(d, pid, cid, notes.slice(0, 1024));
          // Grow an explicit pattern length to fit the notes.
          const end = Math.max(0, ...notes.map((n) => n.tick + n.length));
          if (pat.length !== undefined && end > pat.length) pat.length = Math.ceil(end / bar()) * bar();
          return `Wrote ${notes.length} note${notes.length === 1 ? '' : 's'} for “${ch.name}” in “${pat.name}”`;
        },

        clear_notes: (a) => {
          const pid = pattern(a.pattern);
          const pat = d.patterns[pid]!;
          if (a.channel !== undefined) {
            const cid = channel(a.channel);
            delete pat.notes[cid];
            return `Cleared “${d.channels[cid]!.name}” in “${pat.name}”`;
          }
          pat.notes = {} as never;
          return `Cleared “${pat.name}”`;
        },

        note_tool: (a) => {
          const id = str(a.tool) ?? fail('which tool?');
          const def =
            s.plugins.script(id) ??
            s.plugins.scripts().find((e) => lower(e.def.name) === lower(id) || lower(e.def.id) === lower(id))?.def;
          if (!def) fail(`there is no piano-roll tool "${id}"`);
          const pid = pattern(a.pattern);
          const cid = channel(a.channel);
          const ch = d.channels[cid]!;
          if (ch.kind !== 'instrument') fail(`“${ch.name}” has no notes`);
          const pat = d.patterns[pid]!;
          const values: Record<string, ParamValue> = {};
          const set: string[] = [];
          if (Array.isArray(a.params)) {
            const specs = def!.params as ParamSpecs;
            for (const e of a.params) {
              if (!isObj(e) || typeof e.name !== 'string') continue;
              const pidm = findParamId(specs, e.name);
              const v = pidm ? coerceParam(specs[pidm] as ParamSpec, e.value) : null;
              if (!pidm || v === null) {
                warnings.push(`${def!.name}: can't set "${e.name}" to ${JSON.stringify(e.value)}`);
                continue;
              }
              values[pidm] = v;
              set.push(`${(specs[pidm] as ParamSpec).label ?? pidm} ${formatValue(specs[pidm] as ParamSpec, v)}`);
            }
          }
          // On the draft: notes written earlier in this answer are shaped too.
          const notes = notesSorted(pat.notes[cid]) as Note[];
          let out;
          try {
            out = runNoteScript(
              def!,
              {
                notes,
                grid: PPQ / 4,
                bar: bar(),
                length: patternLength(pat as never, d.transport.timeSig),
                key: d.transport.key ?? null,
              },
              values,
            );
          } catch (err) {
            fail(err instanceof NoteScriptError ? err.message : String(err));
          }
          if (notes.length === 0 && out!.length === 0)
            fail(`“${ch.name}” has no notes in “${pat.name}” for ${def!.name} to work on`);
          const plan = planNoteReplacement(notes, out!, () => newId.note());
          applyNoteReplacement(d, pid, cid, plan);
          return `${def!.name} on “${ch.name}” in “${pat.name}”${set.length ? ` (${set.join(', ')})` : ''}`;
        },

        steps: (a) => {
          const pid = pattern(a.pattern);
          const cid = channel(a.channel);
          const ch = d.channels[cid]!;
          if (ch.kind !== 'instrument') fail(`“${ch.name}” has no steps`);
          const rootKey = ch.kind === 'instrument' ? ch.rootKey : 60;
          const where = `“${ch.name}” in “${d.patterns[pid]!.name}”`;
          const by = Math.round(num(a.by) ?? 1);
          switch (str(a.action)) {
            case 'fill': {
              const every = Math.max(1, Math.min(64, Math.round(num(a.every) ?? 4)));
              fillSteps(d, pid, cid, every, { rootKey });
              return `Filled every ${every} steps of ${where}`;
            }
            case 'rotate':
              rotateSteps(d, pid, cid, by);
              return `Rotated ${where} by ${by} steps`;
            case 'shift':
              shiftSteps(d, pid, cid, by);
              return `Shifted ${where} by ${by} steps`;
            case 'reverse':
              reverseSteps(d, pid, cid);
              return `Reversed ${where}`;
            case 'randomize': {
              const density = Math.min(1, Math.max(0, num(a.density) ?? 0.4));
              randomizeSteps(d, pid, cid, { rootKey, rand: Math.random, density });
              return `Randomized ${where} (${Math.round(density * 100)}% of the steps)`;
            }
            case 'clear':
              clearSteps(d, pid, cid);
              return `Cleared the steps of ${where}`;
            default:
              return fail(`unknown step action "${String(a.action)}"`);
          }
        },

        automate: (a) => {
          const t = isObj(a.target) ? a.target : fail('what should the automation move?');
          const kind = str(t.kind);
          let target: ParamTarget;
          switch (kind) {
            case 'channel_volume':
            case 'channel_pan':
            case 'channel_pitch':
              target = {
                kind: 'channel',
                channelId: channel(t.channel),
                param: kind === 'channel_volume' ? 'volume' : kind === 'channel_pan' ? 'pan' : 'pitch',
              };
              break;
            case 'track_volume':
            case 'track_pan':
              target = { kind: 'insert', insertId: insert(t.insert), param: kind === 'track_volume' ? 'volume' : 'pan' };
              break;
            case 'send':
              target = { kind: 'route', insertId: insert(t.insert), to: insert(t.to) };
              break;
            case 'effect_mix': {
              const e = effect(t.effect);
              target = { kind: 'slot', insertId: e.insertId, slotId: e.slotId, param: 'mix' };
              break;
            }
            case 'plugin': {
              const name = str(t.param) ?? fail('which setting should it move?');
              let owner: PluginOwner;
              let pluginId: string;
              if (t.effect !== undefined) {
                const e = effect(t.effect);
                owner = { kind: 'fx', insertId: e.insertId, slotId: e.slotId };
                pluginId = d.mixer.inserts[e.insertId]!.fx.find((f) => f.id === e.slotId)!.plugin.pluginId;
              } else {
                const cid = channel(t.channel);
                const ch = d.channels[cid]!;
                if (ch.kind !== 'instrument') fail(`“${ch.name}” has no instrument settings`);
                owner = { kind: 'channel', channelId: cid };
                pluginId = (ch as { plugin: { pluginId: string } }).plugin.pluginId;
              }
              const def = s.plugins.get(pluginId) ?? fail(`the plugin ${pluginId} isn't installed`);
              const paramId = findParamId(def.params as ParamSpecs, name) ?? fail(`${def.name} has no setting "${name}"`);
              target = { kind: 'plugin', owner, paramId };
              break;
            }
            case 'tempo':
              target = { kind: 'tempo' };
              break;
            default:
              return fail(`can't automate "${String(t.kind)}"`);
          }
          const specsOf = (id: string) => s.plugins.get(id)?.params as ParamSpecs | undefined;
          const lfo = isObj(a.lfo) ? a.lfo : null;
          const rawPoints = Array.isArray(a.points) ? a.points.filter(isObj) : [];
          // Tempo clips span 60–180 BPM unless the ramp goes further.
          let range: { min: number; max: number } | undefined;
          if (target.kind === 'tempo') {
            const bpms = [d.transport.bpm, ...rawPoints.map((pt) => num(pt.value)).filter((v) => v !== undefined)];
            if (lfo && num(lfo.center) !== undefined) bpms.push(num(lfo.center)!);
            const lo = Math.min(...(bpms as number[]));
            const hi = Math.max(...(bpms as number[]));
            range =
              lo < TEMPO_RANGE.min || hi > TEMPO_RANGE.max
                ? { min: tempoRange(lo).min, max: tempoRange(hi).max }
                : { ...TEMPO_RANGE };
          }
          const res: ResolvedTarget =
            resolveTarget(project, target, specsOf, range) ?? fail('that control does not exist');
          if (!isAutomatable(res.spec)) fail(`${res.spec.label ?? 'that setting'} can't be automated`);
          // A value in the control's own unit → 0–1 on the clip.
          const norm = (raw: unknown): number | null => {
            switch (target.kind) {
              case 'channel':
              case 'insert':
              case 'route': {
                const v = num(raw);
                if (v === undefined) return null;
                const isLevel = target.kind === 'route' || target.param === 'volume';
                return res.toNormalized(isLevel ? (v <= -100 ? 0 : dbToGain(v)) : v);
              }
              case 'slot': {
                const v = num(raw);
                return v === undefined ? null : res.toNormalized(v > 1 && v <= 100 ? v / 100 : v);
              }
              case 'plugin': {
                const v = coerceParam(res.spec, raw);
                return v === null ? null : res.toNormalized(encode(res.spec, v));
              }
              case 'tempo': {
                const v = num(raw);
                return v === undefined ? null : res.toNormalized(v);
              }
            }
          };
          const barT = bar();
          const start = Math.max(0, Math.round(((num(a.from_bar) ?? 1) - 1) * barT));
          const length = Math.max(1, Math.round((num(a.bars) ?? 4) * barT));
          let points: AutoPoint[];
          let shapeText: string;
          if (lfo) {
            const shape = LFO_SHAPES.find((x) => x === str(lfo.shape)) ?? fail(`unknown LFO shape "${String(lfo.shape)}"`);
            const beats = Math.max(1 / 16, num(lfo.beats) ?? 1);
            const center = lfo.center === undefined ? res.toNormalized(res.base) : norm(lfo.center);
            if (center === null) fail(`can't use ${JSON.stringify(lfo.center)} as the middle of the wave`);
            points = lfoPoints(0, length, {
              shape: shape as LfoShape,
              period: beats * PPQ,
              depth: Math.min(1, Math.max(0, num(lfo.depth) ?? 0.5)),
              center: center!,
              phase: 0,
            });
            shapeText = `${shape} wave every ${r2(beats)} beat${beats === 1 ? '' : 's'}`;
          } else {
            points = [];
            for (const pt of rawPoints) {
              const value = norm(pt.value);
              const at = num(pt.bar);
              if (value === null || at === undefined) {
                warnings.push(`automation point ${JSON.stringify(pt)} skipped`);
                continue;
              }
              const shape = (['curve', 'hold', 'stairs', 'smooth'] as const).find((x) => x === str(pt.shape));
              const tension = num(pt.tension);
              points.push({
                tick: Math.min(length, Math.max(0, Math.round(at * barT))),
                value,
                ...(shape && shape !== 'curve' ? { shape: shape as AutoShape } : {}),
                ...(tension !== undefined && tension !== 0 ? { tension: Math.min(1, Math.max(-1, tension)) } : {}),
              });
            }
            if (points.length === 0) fail('the automation needs points or an lfo');
            points.sort((x, y) => x.tick - y.tick);
            // One point is a held value.
            if (points.length === 1) points.push({ tick: length, value: points[0]!.value });
            const fmt = (pt: AutoPoint) => formatAutomationValue(res, target, pt.value);
            shapeText = `${fmt(points[0]!)} → ${fmt(points[points.length - 1]!)}`;
          }
          const pluginInfo = (id: string) => {
            const def = s.plugins.get(id);
            return def ? { name: def.name, params: def.params as ParamSpecs } : undefined;
          };
          const name = targetName(project, target, pluginInfo) ?? 'Automation';
          const automationCount = Object.values(d.channels).filter((c) => c?.kind === 'automation').length;
          const made = createAutomationClip(d, {
            target,
            name,
            color: paletteColor(automationCount * 3 + 5),
            start,
            length,
            points,
            ...(range ? { range } : {}),
          });
          remember(a.ref, { kind: 'channel', id: made.channelId });
          return `Automation “${name}”, bars ${r2(start / barT + 1)}–${r2((start + length) / barT + 1)}: ${shapeText}`;
        },

        place_pattern: (a) => {
          const pid = pattern(a.pattern);
          const barNo = Math.max(1, Math.round(num(a.bar) ?? 1));
          const length = Math.max(
            1,
            Math.round((num(a.bars) ?? patternLength(d.patterns[pid]!, d.transport.timeSig) / bar()) * bar()),
          );
          const times = Math.max(1, Math.min(64, Math.round(num(a.times) ?? 1)));
          const start = (barNo - 1) * bar();
          const end = start + length * times;
          let laneId = d.playlist.laneOrder[Math.round((num(a.track) ?? 0) - 1)];
          if (!laneId) {
            const busy = (lane: string) =>
              Object.values(d.playlist.clips).some(
                (c) => c.laneId === lane && c.start < end && c.start + c.length > start,
              );
            laneId = d.playlist.laneOrder.find((l) => !busy(l)) ?? d.playlist.laneOrder[0];
          }
          if (!laneId) fail('the playlist has no tracks');
          const clips: Clip[] = [];
          for (let i = 0; i < times; i++) {
            const c: PatternClip = {
              kind: 'pattern',
              id: newId.clip(),
              laneId: laneId!,
              start: start + i * length,
              length,
              patternId: pid,
              offset: 0,
            };
            clips.push(c);
          }
          addClips(d, clips);
          after.push({ kind: 'mode', mode: 'song' });
          const lane = d.playlist.laneOrder.indexOf(laneId!) + 1;
          return `Placed “${d.patterns[pid]!.name}” on track ${lane} at bar ${barNo}${times > 1 ? ` ×${times}` : ''}`;
        },

        clear_playlist: (a) => {
          const from = num(a.from_bar);
          const to = num(a.to_bar);
          const t0 = from !== undefined ? (from - 1) * bar() : -Infinity;
          const t1 = to !== undefined ? to * bar() : Infinity;
          const laneId = num(a.track) !== undefined ? d.playlist.laneOrder[Math.round(num(a.track)! - 1)] : undefined;
          const ids = Object.values(d.playlist.clips)
            .filter((c) => c.start < t1 && c.start + c.length > t0 && (!laneId || c.laneId === laneId))
            .map((c) => c.id);
          removeClips(d, ids);
          return `Removed ${ids.length} playlist clip${ids.length === 1 ? '' : 's'}`;
        },

        beat: (a) => {
          const checked = validateBeatSpec({ ...a, message: answer.message });
          if ('error' in checked) fail(`the beat can't be used: ${checked.error}`);
          const { spec, warnings: w } = checked as Exclude<typeof checked, { error: string }>;
          warnings.push(...w);
          const previous = beatPlan
            ? { patternId: beatPlan.patternId, channels: beatPlan.channels, created: [...beatPlan.created] }
            : ctx.previousBeat;
          beatPlan = planBeat(s, project, spec, previous);
          writeBeat(s, d, spec, beatPlan);
          return `Wrote the beat “${spec.title}” (${spec.tracks.map((t) => t.name).join(', ')})`;
        },
      };

      for (const a of docActions) {
        const fn = ops[a.op];
        if (!fn) continue;
        try {
          const note = fn(a);
          if (note) changes.push(note);
        } catch (e) {
          if (e instanceof ActionError) warnings.push(`${a.op.replace(/_/g, ' ')}: ${e.message}`);
          else throw e;
        }
      }
    });

  for (const a of answer.actions) {
    if (a.op === 'transport') {
      const mode = a.mode === 'pattern' || a.mode === 'song' ? a.mode : undefined;
      if (typeof a.metronome === 'boolean') after.push({ kind: 'metronome', on: a.metronome });
      if (a.action === 'stop') after.push({ kind: 'stop' });
      else if (a.action === 'play' || a.action === 'record') {
        const fromBar = num(a.from_bar);
        const tick =
          fromBar !== undefined
            ? Math.max(0, (fromBar - 1) * ticksPerBar(s.doc.getState().project.transport.timeSig))
            : undefined;
        after.push({
          kind: 'play',
          ...(tick !== undefined ? { fromTick: tick } : {}),
          ...(mode ? { mode } : {}),
          ...(a.action === 'record' ? { record: true } : {}),
        });
      } else if (mode) after.push({ kind: 'mode', mode });
    } else if (a.op === 'open') {
      const w = a.window;
      if (w === 'mixer' || w === 'channel-rack' || w === 'piano-roll' || w === 'playlist' || w === 'plugin') {
        const p = s.doc.getState().project;
        const chRef = str(a.channel);
        const channelId = chRef
          ? (Object.values(p.channels).find((c) => c.id === chRef || lower(c.name) === lower(chRef))?.id ??
            (refs.get(lower(chRef))?.kind === 'channel' ? (refs.get(lower(chRef)) as { id: ChannelId }).id : undefined))
          : undefined;
        const fxRef = str(a.effect);
        const fx = fxRef ? refs.get(lower(fxRef)) : undefined;
        let slot: { insertId: InsertId; slotId: SlotId } | undefined =
          fx?.kind === 'effect' ? { insertId: fx.insertId, slotId: fx.slotId } : undefined;
        if (!slot && fxRef)
          for (const id of p.mixer.order)
            if (p.mixer.inserts[id]?.fx.some((f) => f.id === fxRef)) slot = { insertId: id, slotId: fxRef as SlotId };
        after.push({
          kind: 'open',
          window: w,
          ...(channelId ? { channelId } : {}),
          ...(slot ? { insertId: slot.insertId, slotId: slot.slotId } : {}),
        });
      }
    }
  }

  const project = s.doc.getState().project;
  if (selectPattern && project.patterns[selectPattern]) s.view.getState().setCurrentPattern(selectPattern);
  if (selectChannel && project.channels[selectChannel]) s.session.getState().selectChannel(selectChannel);
  const beat = beatPlan ? showBeat(s, beatPlan) : null;
  return { changes, warnings, beat, after, edited: !!edited };
}
