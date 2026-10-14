/**
 * Setting up a song's mix by role: buses for kick, drums, 808/bass, chords, lead and FX, reverb and
 * delay returns, levels by role, the 808 ducking under the kick, and a master chain ending in a
 * Limiter. (The setup itself isn't written yet: for now it only reports the layout already there.)
 */
import type { Draft } from 'immer';
import type { Role } from '@core/arrange/roles';
import type { Style } from '@core/beat/style';
import type { ChannelId, InsertId, Project } from '@core/model/types';
import type { Services } from '../services';
import { findMixLayout, type MixLayout } from './layout';

export interface SetupMixOptions {
  style: Style;
  roles: ReadonlyMap<ChannelId, Role>;
  /** rebuild: a song made in this answer (route everything); fill-gaps: only channels still on the master. */
  mode: 'fill-gaps' | 'rebuild';
  /** Mixer tracks whose faders the AI set itself (left alone). */
  pinned?: ReadonlySet<InsertId>;
}

export interface SetupMixResult {
  layout: MixLayout;
  /** Change lines for the chat. */
  changes: string[];
}

export function setupMix(d: Draft<Project>, _s: Services, _opts: SetupMixOptions): SetupMixResult {
  return { layout: findMixLayout(d as unknown as Project), changes: [] };
}
