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
import { dj } from './dj';
import { filters } from './filters';
import type { OpHandler, OpModule } from './context';
import { FOCUS_PROMPT } from './focus-guard';
import { mix } from './mix';
import { mixer } from './mixer';
import { notes } from './notes';
import { patterns } from './patterns';
import { playlist } from './playlist';
import { song } from './song';
import { ui } from './ui';

export const MODULES: readonly OpModule[] = [
  song,
  channels,
  mixer,
  patterns,
  notes,
  automation,
  playlist,
  clips,
  arrange,
  beat,
  mix,
  dj,
  filters,
  ui,
];

/** Handlers of the actions that edit the project (the UI ones run after the edit). */
export const DOC_OPS: Readonly<Record<string, OpHandler>> = Object.assign({}, ...MODULES.map((m) => m.handlers));

/** Actions the UI runs after the edit (playback, windows, commands…). */
export const UI_OP_NAMES: ReadonlySet<string> = new Set(ui.schemas.map((o) => o.properties.op.const));

export const OP_SCHEMAS: readonly OpSchema[] = MODULES.flatMap((m) => m.schemas);

export const OP_PROMPTS: readonly PromptSection[] = [
  ...MODULES.flatMap((m) => (m.prompt ? [m.prompt] : [])),
  FOCUS_PROMPT,
];
