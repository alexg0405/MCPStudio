/**
 * Faust DSP descriptions → AGstudio params. Pure and allocation-free after setup, so both threads use
 * it: the main thread to declare the plugin's params, the audio thread to map them to the DSP.
 *
 * Every slider, number entry, checkbox and button of the Faust UI becomes a param (id from its short
 * name, label, range, step, [unit:…], [scale:log], [tooltip:…], group from the enclosing boxes).
 * For instruments, the voice controls `freq`, `gain` and `gate` (also `key` and `vel`) are played
 * by notes instead of shown as knobs, as in Faust's polyphony convention.
 */
import { p, type ParamSpec, type ParamSpecs, type Unit } from '../params';

/** One item of a Faust JSON `ui` tree. */
export interface FaustUiItem {
  type: string;
  label: string;
  shortname?: string;
  address?: string;
  index?: number;
  init?: number;
  min?: number;
  max?: number;
  step?: number;
  meta?: Record<string, string>[];
  items?: FaustUiItem[];
}

/** The parts of Faust's JSON description AGstudio uses. */
export interface FaustMeta {
  name: string;
  /** Bytes of the DSP struct at the start of memory (audio buffers go after it). */
  size: number;
  inputs: number;
  outputs: number;
  ui: FaustUiItem[];
}

export interface FaustControl {
  /** The AGstudio param id. */
  id: string;
  /** Memory offset Faust's setParamValue takes. */
  index: number;
}

/** The DSP's voice controls (memory offsets), when it is an instrument. */
export interface FaustVoiceControls {
  freq: number;
  gain: number;
  gate: number;
  key: number;
  vel: number;
}

const VOICE = new Set(['freq', 'gain', 'gate', 'key', 'vel', 'velocity', 'frequency']);
const UNITS: Record<string, Unit> = { hz: 'Hz', db: 'dB', ms: 'ms', s: 's', sec: 's', st: 'st', ct: 'ct', cents: 'ct' };

const metaOf = (item: FaustUiItem, key: string): string | undefined => {
  for (const m of item.meta ?? []) if (m[key] !== undefined) return m[key];
  return undefined;
};

/** A param id from a short name, camelCase: "Filter Q" → "filterQ", "cutoff" → "cutoff". */
function idFor(name: string, taken: Set<string>): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  let id =
    words.map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1))).join('') ||
    'param';
  if (!/^[A-Za-z]/.test(id)) id = `p${id}`;
  if (id === '__pitch') id = 'pitch_';
  let unique = id;
  for (let n = 2; taken.has(unique); n++) unique = `${id}${n}`;
  taken.add(unique);
  return unique;
}

function specFor(item: FaustUiItem, group: string | undefined): ParamSpec | null {
  const label = item.label;
  const hint = metaOf(item, 'tooltip');
  const common = { label, ...(hint ? { hint } : {}), ...(group ? { group } : {}) };
  if (item.type === 'checkbox' || item.type === 'button') return p.bool((item.init ?? 0) > 0, common);
  if (item.type !== 'hslider' && item.type !== 'vslider' && item.type !== 'nentry') return null;
  const min = item.min ?? 0;
  const max = item.max ?? 1;
  if (!(max > min)) return null;
  const init = Math.min(max, Math.max(min, item.init ?? min));
  const step = item.step ?? 0;
  const unitText = metaOf(item, 'unit')?.trim().toLowerCase() ?? '';
  const unit = UNITS[unitText];
  const log = metaOf(item, 'scale') === 'log' && min > 0;
  // Whole numbers for counts and choices (a number entry, or a short slider range); a 40–18000 Hz
  // slider with step 1 stays a smooth (and log-scaled) knob.
  const integral =
    step >= 1 &&
    Number.isInteger(step) &&
    [min, max, init].every(Number.isInteger) &&
    !log &&
    (item.type === 'nentry' || max - min <= 128);
  if (integral) return p.int(min, max, init, { ...common, ...(unit ? { unit } : {}) });
  return p.float(min, max, init, { ...common, ...(unit ? { unit } : {}), ...(log ? { scale: 'log' as const } : {}) });
}

/** The params and their DSP offsets; `kind` 'instrument' sets the voice controls apart. */
export function faustControls(
  meta: FaustMeta,
  kind: 'effect' | 'instrument',
): { params: ParamSpecs; controls: FaustControl[]; voice: FaustVoiceControls } {
  const params: Record<string, ParamSpec> = {};
  const controls: FaustControl[] = [];
  const voice: FaustVoiceControls = { freq: -1, gain: -1, gate: -1, key: -1, vel: -1 };
  const taken = new Set<string>();
  const walk = (items: readonly FaustUiItem[], groups: string[]) => {
    for (const item of items) {
      if (item.items) {
        // The outermost box is the DSP's own name: not worth a group.
        walk(item.items, groups.length === 0 && items === meta.ui ? ['(top)'] : [...groups, item.label]);
        continue;
      }
      if (item.index === undefined) continue;
      const short = (item.shortname ?? item.label).trim();
      const lower = short.toLowerCase();
      if (kind === 'instrument' && VOICE.has(lower)) {
        const slot = lower === 'frequency' ? 'freq' : lower === 'velocity' ? 'vel' : (lower as keyof FaustVoiceControls);
        if (voice[slot] < 0) voice[slot] = item.index;
        continue;
      }
      const group = groups.filter((g) => g !== '(top)').join(' · ') || undefined;
      const spec = specFor(item, group);
      if (!spec) continue;
      const id = idFor(short, taken);
      params[id] = spec;
      controls.push({ id, index: item.index });
    }
  };
  walk(meta.ui, []);
  return { params, controls, voice };
}
