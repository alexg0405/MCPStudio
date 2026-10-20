/**
 * Every AI action, by module. The order here is the order of the actions in the schema and of their
 * prompt sections; add a module by appending it.
 */
import type { PromptSection } from '../prompt-section';
import type { OpSchema } from '../schema/parts';
import { arrange } from './arrange';
import { automation } from './automation';
import { beat } from './beat';
import { channels } from './channels';
import { clips } from './clips';
import { decks } from './decks';
import { dj } from './dj';
import { filters } from './filters';
import { harmony } from './harmony';
import { launcher } from './launcher';
import { lyrics } from './lyrics';
import type { OpHandler, OpModule } from './context';
import { FOCUS_PROMPT } from './focus-guard';
import { meters } from './meters';
import { mix } from './mix';
import { mixer } from './mixer';
import { mixerState } from './mixer-state';
import { notes } from './notes';
import { patterns } from './patterns';
import { pitch } from './pitch';
import { playlist } from './playlist';
import { query } from './query';
import { recording, RECORD_OP_NAMES } from './recording';
import { reference } from './reference';
import { samples } from './samples';
import { session } from './session';
import { song } from './song';
import { ui } from './ui';
import { wavetable } from './wavetable';

export const MODULES: readonly OpModule[] = [
  song,
  channels,
  mixer,
  mixerState,
  patterns,
  notes,
  harmony,
  lyrics,
  automation,
  playlist,
  clips,
  recording,
  pitch,
  arrange,
  beat,
  mix,
  reference,
  meters,
  dj,
  decks,
  launcher,
  filters,
  samples,
  wavetable,
  ui,
  session,
  query,
];

/** Handlers of the actions that edit the project (the UI ones run after the edit). */
export const DOC_OPS: Readonly<Record<string, OpHandler>> = Object.assign({}, ...MODULES.map((m) => m.handlers));

/** Actions the UI runs after the edit (playback, windows, commands…). */
export const UI_OP_NAMES: ReadonlySet<string> = new Set(
  [...ui.schemas, ...session.schemas, ...query.schemas, ...decks.schemas, ...launcher.schemas.filter((o) => o.properties.op.const === 'launcher_play')]
    .map((o) => o.properties.op.const)
    .concat(RECORD_OP_NAMES),
);

export const OP_SCHEMAS: readonly OpSchema[] = MODULES.flatMap((m) => m.schemas);

export const OP_PROMPTS: readonly PromptSection[] = [
  ...MODULES.flatMap((m) => (m.prompt ? [m.prompt] : [])),
  FOCUS_PROMPT,
];
