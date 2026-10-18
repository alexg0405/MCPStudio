/**
 * The clip launcher (Performance mode) for the Studio and MCP: setting up the grid (`launcher_slot`, `launcher_layout`,
 * edits of the project) and playing it (`launcher_play`: launch a slot or scene, stop, record the performance: live,
 * not part of the project, so it runs after the edit like the DJ decks).
 */
import {
  contentFromAudioChannel,
  contentFromAudioClip,
  clearSlot,
  ensureCapacity,
  ensureLauncher,
  patchSlot,
  patternContent,
  renameLaunchTrack,
  renameScene,
  setLauncherQuantize,
  setSlotContent,
  setTrackLane,
} from '@core/ops/launcher';
import { filledSlots, isLaunchMode, isLaunchQuantize, MAX_SCENES, MAX_TRACKS, QUANTIZE_LABELS, slotLabel, slotLoops, slotMode } from '@core/launcher/grid';
import { FOLLOW_KINDS, LAUNCH_MODES, LAUNCH_QUANTIZES, type FollowAction, type LaunchContent, type Project } from '@core/model/types';
import type { Services } from '../../services';
import type { AiAnswer } from '../schema';
import * as S from '../schema/parts';
import { fail, type AnswerState, type OpModule } from './context';
import { bool, isObj, lower, num, str } from './values';

const MODES = { type: 'string', enum: [...LAUNCH_MODES], description: 'trigger: a press starts it; toggle: the next press stops it; gate: plays while held; retrigger: every press restarts it.' };
const QUANTIZES = { type: 'string', enum: [...LAUNCH_QUANTIZES], description: 'When it starts and stops after a press: none (at once), beat, bar, 2bars or 4bars.' };

/** A 1-based position that is in the grid's limits. */
function position(raw: unknown, what: string, max: number): number {
  const n = num(raw);
  if (n === undefined || !Number.isInteger(n) || n < 1) return fail(`${what} must be a whole number from 1`);
  if (n > max) return fail(`${what} ${n} is out of range (at most ${max})`);
  return n;
}

export const launcher: OpModule = {
  schemas: [
    S.op(
      'launcher_slot',
      'Sets up one slot of the clip launcher (Performance mode: a grid of slots, tracks across and scenes down, that the musician launches live in time with the song). Put a pattern, an audio clip channel or a playlist clip in it, and/or set how it behaves: name, colour, launch mode, loop, quantize, follow action. The grid is made (8 tracks × 8 scenes) the first time. Slots point at patterns and audio: nothing is copied.',
      {
        track: S.int('1-based launcher track (column).'),
        scene: S.int('1-based scene (row).'),
        pattern: S.PATTERN,
        audio: S.str('An audio clip channel (id or exact name): its sample plays from the start and loops.'),
        clip: S.str('A playlist clip id (clip_…): its pattern or audio becomes the slot.'),
        clip_track: S.int('Instead of clip: the 1-based playlist track of a clip…'),
        clip_bar: S.num('…and a bar where it plays.'),
        clear: S.bool('Empty the slot.'),
        name: S.str('The slot’s name (empty string: back to the pattern’s name).'),
        color: S.str('Hex colour.'),
        mode: MODES,
        loop: S.bool('true (default): repeats until stopped; false: plays once.'),
        quantize: { ...QUANTIZES, description: `${QUANTIZES.description} Leave out to follow the grid’s.` },
        follow: {
          type: 'object',
          additionalProperties: false,
          description: 'What happens after it has played for some bars; kind "none" removes it.',
          properties: { kind: { type: 'string', enum: [...FOLLOW_KINDS, 'none'] }, bars: S.int('1–64 bars after it started.') },
          required: ['kind'],
        },
      },
      ['track', 'scene'],
    ),
    S.op(
      'launcher_layout',
      'Shapes the clip launcher grid: its default quantize, how many tracks and scenes it has, names for scenes and tracks, and which playlist track a launcher track takes over while it plays (like FL’s Performance mode).',
      {
        quantize: QUANTIZES,
        tracks: S.int(`Make the grid at least this many tracks wide (up to ${MAX_TRACKS}).`),
        scenes: S.int(`Make the grid at least this many scenes tall (up to ${MAX_SCENES}).`),
        scene_names: { type: 'array', items: { type: 'string' }, description: 'Names for scene 1, 2, 3… in order ("Intro", "Verse"…); an empty string leaves one as it is.' },
        track_names: { type: 'array', items: { type: 'string' }, description: 'Names for launcher track 1, 2, 3… in order; an empty string leaves one as it is.' },
        playlist_tracks: {
          type: 'array',
          description: 'Which playlist track a launcher track takes over while it plays: 0 for none.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: { track: S.int('1-based launcher track.'), playlist_track: S.int('1-based playlist track, 0 = none.') },
            required: ['track', 'playlist_track'],
          },
        },
      },
    ),
    S.op(
      'launcher_play',
      'Plays the clip launcher live (it runs after the edits; nothing is saved): launch a slot (its mode decides what the press does) or a whole scene, stop a track or everything, or record the performance: from the next bar everything launched is kept, and stop_recording puts it on the playlist as clips (one undo step) at the next bar. Launches start on the next quantize boundary and need the transport to run or start it (the clip launcher starts it on its own). The musician is listening: say what you started.',
      {
        action: { type: 'string', enum: ['launch', 'launch_scene', 'stop_track', 'stop_all', 'stop_now', 'record', 'stop_recording'] },
        track: S.int('launch, stop_track: 1-based launcher track.'),
        scene: S.int('launch, launch_scene: 1-based scene.'),
      },
      ['action'],
    ),
  ],
  prompt: {
    id: 'launcher',
    order: 24,
    text: `Clip launcher (launcher_slot, launcher_layout, launcher_play): FL’s Performance mode / Ableton’s session view. A grid of slots, tracks across and scenes down; a slot points at a pattern or an audio clip channel. One slot plays per track; launching another replaces it on the next boundary (the grid’s quantize, default 1 bar); a scene launches its whole row. Use it when asked to "set up a jam", "perform", "launch clips", "make scenes", "record a performance to the playlist".
- launcher_slot fills and tunes slots (pattern, audio, clip), launcher_layout names scenes and tracks and links a launcher track to a playlist track, launcher_play launches, stops and records (it acts live, after the edits).
- Modes: trigger (default), toggle, gate (while held), retrigger. Follow actions: after N bars play the next slot of the track, a random one, or stop.
- A recorded performance becomes pattern and audio clips on new playlist tracks at the bars they played (undo removes them). <launcher> in the context shows what is in the grid and what plays.`,
  },
  handlers: {
    launcher_slot: (action, context) => {
      const { draft } = context;
      const t = position(action.track, 'track', MAX_TRACKS);
      const sc = position(action.scene, 'scene', MAX_SCENES);
      const l = ensureCapacity(draft, t, sc);
      const trackId = l.trackOrder[t - 1]!;
      const sceneId = l.sceneOrder[sc - 1]!;
      const where = `track ${t}, scene ${sc}`;
      if (bool(action.clear)) {
        clearSlot(draft, trackId, sceneId);
        return `Cleared launcher ${where}`;
      }
      let content: LaunchContent | null = null;
      if (action.pattern !== undefined) content = patternContent(context.pattern(action.pattern));
      else if (action.audio !== undefined) {
        const id = context.channel(action.audio);
        content = contentFromAudioChannel(context.project, id) ?? fail(`"${String(action.audio)}" is not an audio clip with a known length`);
      } else if (action.clip !== undefined || action.clip_track !== undefined) {
        const clip = context.clip({ op: 'launcher_slot', clip: action.clip, track: action.clip_track, bar: action.clip_bar });
        if (clip.kind === 'pattern') content = patternContent(clip.patternId);
        else if (clip.kind === 'audio') content = contentFromAudioClip(clip);
        else fail('automation clips can’t be launched');
      }
      const changes: string[] = [];
      if (content) {
        setSlotContent(draft, trackId, sceneId, content);
        changes.push(content.kind === 'pattern' ? `“${draft.patterns[content.patternId]?.name ?? 'pattern'}”` : `“${draft.channels[content.channelId]?.name ?? 'audio'}”`);
      }
      const slot = l.tracks[trackId]!.slots[sceneId];
      if (!slot) return fail(`launcher ${where} is empty: give it a pattern, audio or clip`);
      if (typeof action.name === 'string') {
        patchSlot(draft, trackId, sceneId, { name: action.name.trim() ? action.name : null });
        changes.push(action.name.trim() ? `named “${action.name.trim()}”` : 'its own name');
      }
      const color = str(action.color);
      if (color) {
        if (/^#[0-9a-f]{6}$/i.test(color)) patchSlot(draft, trackId, sceneId, { color });
        else context.warn(`launcher slot: “${color}” is not a hex colour like #c9a24a`);
      }
      const mode = str(action.mode);
      if (mode) {
        if (isLaunchMode(lower(mode))) {
          patchSlot(draft, trackId, sceneId, { mode: lower(mode) as never });
          changes.push(`${lower(mode)} mode`);
        } else context.warn(`launcher slot: unknown mode “${mode}” (${LAUNCH_MODES.join(', ')})`);
      }
      const loop = bool(action.loop);
      if (loop !== undefined) {
        patchSlot(draft, trackId, sceneId, { loop });
        changes.push(loop ? 'loops' : 'plays once');
      }
      const q = str(action.quantize);
      if (q) {
        if (isLaunchQuantize(lower(q))) {
          patchSlot(draft, trackId, sceneId, { quantize: lower(q) as never });
          changes.push(`quantize ${QUANTIZE_LABELS[lower(q) as keyof typeof QUANTIZE_LABELS].toLowerCase()}`);
        } else context.warn(`launcher slot: unknown quantize “${q}” (${LAUNCH_QUANTIZES.join(', ')})`);
      }
      if (isObj(action.follow)) {
        const kind = str(action.follow.kind);
        if (kind === 'none') {
          patchSlot(draft, trackId, sceneId, { follow: null });
          changes.push('no follow action');
        } else if (kind && (FOLLOW_KINDS as readonly string[]).includes(kind)) {
          const bars = Math.max(1, Math.min(64, Math.round(num(action.follow.bars) ?? 4)));
          patchSlot(draft, trackId, sceneId, { follow: { kind, bars } as FollowAction });
          changes.push(`${kind} after ${bars} bar${bars === 1 ? '' : 's'}`);
        } else context.warn(`launcher slot: unknown follow action “${String(action.follow.kind)}”`);
      }
      return `Launcher ${where}: ${changes.length ? changes.join(', ') : 'nothing changed'}`;
    },
    launcher_layout: (action, context) => {
      const { draft } = context;
      const notes: string[] = [];
      const q = str(action.quantize);
      if (q) {
        if (isLaunchQuantize(lower(q))) {
          setLauncherQuantize(draft, lower(q) as never);
          notes.push(`launches on ${QUANTIZE_LABELS[lower(q) as keyof typeof QUANTIZE_LABELS].toLowerCase()}`);
        } else context.warn(`launcher layout: unknown quantize “${q}” (${LAUNCH_QUANTIZES.join(', ')})`);
      }
      const tracks = num(action.tracks);
      const scenes = num(action.scenes);
      const sceneNames = Array.isArray(action.scene_names) ? action.scene_names : [];
      const trackNames = Array.isArray(action.track_names) ? action.track_names : [];
      const links = Array.isArray(action.playlist_tracks) ? action.playlist_tracks : [];
      if (tracks !== undefined || scenes !== undefined || sceneNames.length || trackNames.length || links.length) {
        ensureLauncher(draft);
        const l = ensureCapacity(
          draft,
          Math.max(tracks === undefined ? 0 : Math.round(tracks), trackNames.length, ...links.map((x) => (isObj(x) ? (num(x.track) ?? 0) : 0))),
          Math.max(scenes === undefined ? 0 : Math.round(scenes), sceneNames.length),
        );
        if (tracks !== undefined || scenes !== undefined) notes.push(`${l.trackOrder.length} tracks × ${l.sceneOrder.length} scenes`);
        sceneNames.forEach((n, i) => {
          const id = l.sceneOrder[i];
          if (id && typeof n === 'string' && n.trim()) renameScene(draft, id, n);
        });
        if (sceneNames.some((n) => typeof n === 'string' && n.trim())) notes.push('scene names');
        trackNames.forEach((n, i) => {
          const id = l.trackOrder[i];
          if (id && typeof n === 'string' && n.trim()) renameLaunchTrack(draft, id, n);
        });
        if (trackNames.some((n) => typeof n === 'string' && n.trim())) notes.push('track names');
        for (const x of links) {
          if (!isObj(x)) continue;
          const id = l.trackOrder[(num(x.track) ?? 0) - 1];
          if (!id) {
            context.warn(`launcher layout: there is no launcher track ${String(x.track)}`);
            continue;
          }
          const lane = num(x.playlist_track);
          setTrackLane(draft, id, lane && lane > 0 ? context.lane(lane) : null);
          notes.push(lane && lane > 0 ? `track ${String(x.track)} takes over playlist track ${lane}` : `track ${String(x.track)} no longer takes over a playlist track`);
        }
      }
      return notes.length ? `Launcher: ${notes.join(', ')}` : null;
    },
  },
};

/** The action that plays the launcher live (it is not an edit of the project). */
export const LAUNCHER_PLAY_OPS: readonly string[] = ['launcher_play'];

/** Runs the answer's `launcher_play` actions, in order, after its edits are committed. */
export function launcherAfter(services: Services, answer: AiAnswer, state: AnswerState): void {
  for (const action of answer.actions) {
    if (action.op !== 'launcher_play') continue;
    const warn = (m: string) => state.warnings.push(`launcher play: ${m}`);
    const project = services.doc.getState().project;
    const l = project.launcher;
    const subAction = str(action.action);
    const t = num(action.track);
    const sc = num(action.scene);
    const L = services.launcher;
    switch (subAction) {
      case 'launch': {
        if (!l) {
          warn('the clip launcher is empty: set up slots with launcher_slot first');
          break;
        }
        if (t === undefined || sc === undefined) {
          warn('launch needs track and scene');
          break;
        }
        const slot = filledSlots(l).find((f) => f.track === Math.round(t) - 1 && f.scene === Math.round(sc) - 1);
        if (!slot) {
          warn(`launcher track ${t}, scene ${sc} is empty`);
          break;
        }
        L.pressAt(slot.track, slot.scene);
        state.ui.push(`Launched “${slotLabel(project, slot.slot)}” (track ${slot.track + 1}, scene ${slot.scene + 1}): it starts on the next ${QUANTIZE_LABELS[slot.slot.quantize ?? l.quantize].toLowerCase()} boundary`);
        break;
      }
      case 'launch_scene': {
        if (!l || sc === undefined || !l.sceneOrder[Math.round(sc) - 1]) {
          warn(`there is no scene ${String(action.scene)}`);
          break;
        }
        L.launchSceneAt(Math.round(sc) - 1);
        state.ui.push(`Launched scene ${Math.round(sc)} “${l.scenes[l.sceneOrder[Math.round(sc) - 1]!]!.name}”`);
        break;
      }
      case 'stop_track': {
        if (!l || t === undefined || !l.trackOrder[Math.round(t) - 1]) {
          warn(`there is no launcher track ${String(action.track)}`);
          break;
        }
        L.stopTrackAt(Math.round(t) - 1);
        state.ui.push(`Stopping launcher track ${Math.round(t)}`);
        break;
      }
      case 'stop_all':
      case 'stop_now':
        L.stopAll(subAction === 'stop_now');
        state.ui.push(subAction === 'stop_now' ? 'Stopped the clip launcher' : 'Stopping the clip launcher at the next boundary');
        break;
      case 'record':
        L.startRecording();
        state.ui.push('Recording the launcher performance (it goes on the playlist when you stop it)');
        break;
      case 'stop_recording':
        L.stopRecording();
        state.ui.push('Ending the performance record at the next bar: the clips go on the playlist then');
        break;
      default:
        warn(`unknown action “${String(action.action)}”`);
    }
  }
}

/** What the clip launcher holds and does, for the Studio's context. Empty when there is no grid. */
export function launcherLines(services: Services): string[] {
  const project: Project = services.doc.getState().project;
  const l = project.launcher;
  const filled = filledSlots(l);
  if (!l || filled.length === 0) return [];
  const lines = [`<launcher> (clip launcher: tracks across, scenes down; launches on ${QUANTIZE_LABELS[l.quantize].toLowerCase()}):`];
  const heard = services.launcher.runs.length ? services.launcher.clock().heardU : 0;
  l.sceneOrder.forEach((sceneId, si) => {
    const row = filled.filter((f) => f.scene === si);
    if (!row.length) return;
    const parts = row.map((f) => {
      const st = services.launcher.stateOf(f.trackId, f.sceneId, heard).state;
      const bits = [
        slotMode(f.slot) === 'trigger' ? '' : slotMode(f.slot),
        slotLoops(f.slot) ? '' : 'once',
        f.slot.follow ? `${f.slot.follow.kind} after ${f.slot.follow.bars} bars` : '',
        st === 'playing' || st === 'queued' || st === 'stopping' ? st : '',
      ].filter(Boolean);
      return `track ${f.track + 1} “${slotLabel(project, f.slot)}”${bits.length ? ` (${bits.join(', ')})` : ''}`;
    });
    lines.push(`- Scene ${si + 1} “${l.scenes[sceneId]!.name}”: ${parts.join('; ')}`);
  });
  if (services.launcher.store.getState().recording) lines.push('- Recording the performance.');
  lines.push('</launcher>');
  return lines;
}
