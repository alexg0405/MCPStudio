/**
 * Mixer snapshots and groups for Studio and MCP: `mixer_snapshot` (save, recall, compare, update, rename, delete, diff)
 * and `mixer_group` (create, edit, remove a group, its VCA and its level). They edit the project like any other
 * action, in the answer's one undo step. Compare also sets A and B for the musician's A/B switch after the edit.
 */
import { current } from 'immer';
import { dbToGain } from '@agstudio/sdk';
import type { GroupLinks, InsertId, MixSnapshot, Project, SnapshotId } from '@core/model/types';
import { MAX_INSERT_VOLUME } from '@core/model/fader';
import { addVca, createGroup, editGroup, joinGroup, leaveGroup, removeGroup, removeVca, setVcaLevel } from '@core/ops/groups';
import { addSnapshot, deleteSnapshot, freeSnapshotName, MAX_SNAPSHOTS, renameSnapshot, replaceSnapshotState } from '@core/ops/snapshots';
import { findGroup } from '@core/query/mix-groups';
import { captureSnapshot } from '@core/snapshots/capture';
import { diffAgainstCurrent, diffBetween, type MixDifference } from '@core/snapshots/diff';
import { recallSnapshot } from '@core/snapshots/recall';
import type { Services } from '../../services';
import type { AiAnswer } from '../schema';
import * as S from '../schema/parts';
import { fail, type AnswerState, type OpContext, type OpModule } from './context';
import { bool, isObj, lower, num, r2, str } from './values';

const SNAPSHOT_ACTIONS = ['save', 'recall', 'compare', 'update', 'rename', 'delete', 'diff'] as const;
const GROUP_ACTIONS = ['create', 'edit', 'remove', 'vca_level'] as const;

/** The most difference lines one reply lists before it says how many more there are. */
const MAX_DIFFERENCE_LINES = 30;

/** The A/B pair a compare action leaves for the musician's switch (set after the edit). */
const COMPARE_KEY = 'mixer_compare';
interface PendingCompare {
  a: string;
  b: string;
  side: 'a' | 'b';
}

const TRACK_LIST = {
  type: 'array',
  items: S.INSERT,
  description: 'Mixer tracks (numbers, names or ids).',
};

/** A VCA level in dB as a linear gain: −100 or below is silence, the top is the fader's +5.6 dB. */
function vcaGain(db: number): number {
  return db <= -100 ? 0 : Math.min(MAX_INSERT_VOLUME, dbToGain(db));
}

/** The plain (unproxied) project the draft holds now: snapshots read values, so they must not hold the draft's proxies. */
const plainProject = (context: OpContext): Project => current(context.draft) as unknown as Project;

function snapshotNamed(context: OpContext, raw: unknown): MixSnapshot {
  const id = context.snapshot(raw);
  return plainProject(context).mixSnapshots!.find((snapshot) => snapshot.id === id)!;
}

/** Difference lines as one sentence-per-line change note, cut at a sensible length. */
function describeDifferences(title: string, same: string, lines: readonly MixDifference[]): string {
  if (lines.length === 0) return same;
  const shown = lines.slice(0, MAX_DIFFERENCE_LINES).map((line) => line.text);
  const more = lines.length > shown.length ? `; …and ${lines.length - shown.length} more` : '';
  return `${title} (${lines.length}): ${shown.join('; ')}${more}`;
}

function linksFrom(raw: unknown): Partial<GroupLinks> | undefined {
  if (!isObj(raw)) return undefined;
  const out: Partial<GroupLinks> = {};
  for (const control of ['volume', 'pan', 'mute', 'solo'] as const) {
    const value = bool(raw[control]);
    if (value !== undefined) out[control] = value;
  }
  return out;
}

function tracksFrom(context: OpContext, raw: unknown): InsertId[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((track) => context.insert(track));
}

const snapshotHandlers: OpModule['handlers'] = {
  mixer_snapshot: (action, context) => {
    const { draft, services } = context;
    const kind = lower(str(action.action) ?? '');
    switch (kind) {
      case 'save': {
        if ((draft.mixSnapshots?.length ?? 0) >= MAX_SNAPSHOTS) fail(`a project keeps at most ${MAX_SNAPSHOTS} snapshots: delete one first`);
        const name = str(action.name) ?? freeSnapshotName(draft.mixSnapshots as MixSnapshot[] | undefined);
        const snapshot = captureSnapshot(plainProject(context), name, Date.now(), { routing: bool(action.routing) === true });
        addSnapshot(draft, snapshot);
        return `Saved the mixer as snapshot “${name}”${snapshot.routing ? ' (with routing)' : ''}`;
      }
      case 'recall': {
        const snapshot = snapshotNamed(context, action.snapshot);
        const routing = bool(action.routing);
        const report = recallSnapshot(draft, snapshot, routing === undefined ? {} : { routing });
        for (const skipped of report.skipped) context.warn(`${snapshot.name}: ${skipped}`);
        return `Recalled snapshot “${snapshot.name}”`;
      }
      case 'update': {
        const old = snapshotNamed(context, action.snapshot);
        const fresh = captureSnapshot(plainProject(context), old.name, Date.now(), { routing: !!old.routing });
        replaceSnapshotState(draft, old.id, fresh);
        return `Updated snapshot “${old.name}” with the mixer as it is now`;
      }
      case 'rename': {
        const old = snapshotNamed(context, action.snapshot);
        const name = str(action.name) ?? fail('what should the snapshot be called?');
        renameSnapshot(draft, old.id, name);
        return `Renamed snapshot “${old.name}” to “${name}”`;
      }
      case 'delete': {
        const old = snapshotNamed(context, action.snapshot);
        deleteSnapshot(draft, old.id);
        return `Deleted snapshot “${old.name}”`;
      }
      case 'diff': {
        const snapshot = snapshotNamed(context, action.snapshot);
        const project = plainProject(context);
        if (action.other !== undefined) {
          const other = snapshotNamed(context, action.other);
          const lines = diffBetween(project, snapshot, other, services.automation.pluginInfo);
          return describeDifferences(`Going from “${snapshot.name}” to “${other.name}” changes`, `“${snapshot.name}” and “${other.name}” hold the same mix`, lines);
        }
        const lines = diffAgainstCurrent(project, snapshot, services.automation.pluginInfo);
        return describeDifferences(`Recalling “${snapshot.name}” would change`, `The mix already matches “${snapshot.name}”`, lines);
      }
      case 'compare': {
        const a = snapshotNamed(context, action.snapshot);
        const b = snapshotNamed(context, action.other ?? fail('compare needs the second snapshot as "other"'));
        const side = lower(str(action.show) ?? 'a') === 'b' ? 'b' : 'a';
        const shown = side === 'a' ? a : b;
        const lines = diffBetween(plainProject(context), a, b, services.automation.pluginInfo);
        recallSnapshot(draft, shown);
        context.state.bag.set(COMPARE_KEY, { a: a.id, b: b.id, side } satisfies PendingCompare);
        const summary = describeDifferences('they differ in', 'they hold the same mix', lines);
        return `A/B compare: A is “${a.name}”, B is “${b.name}”; playing ${side.toUpperCase()} (the musician can switch with the A/B button). ${summary}`;
      }
      default:
        return fail(`mixer_snapshot action must be one of ${SNAPSHOT_ACTIONS.join(', ')}`);
    }
  },
};

const groupHandlers: OpModule['handlers'] = {
  mixer_group: (action, context) => {
    const { draft } = context;
    const kind = lower(str(action.action) ?? '');
    const vcaDb = num(action.vca_db);
    switch (kind) {
      case 'create': {
        const tracks = tracksFrom(context, action.tracks);
        if (tracks.length < 1) fail('a group needs mixer tracks');
        const id = createGroup(draft, tracks, { ...(str(action.name) ? { name: str(action.name)! } : {}), ...(str(action.color) ? { color: str(action.color)! } : {}) });
        if (!id) return fail('no group was made (the master cannot be in a group)');
        editGroup(draft, id, { links: linksFrom(action.linked) ?? {}, ...(lower(str(action.mode) ?? '') === 'absolute' ? { mode: 'absolute' as const } : {}) });
        if (bool(action.vca) === true || vcaDb !== undefined) addVca(draft, id, vcaDb === undefined ? 1 : vcaGain(vcaDb));
        context.remember(action.ref, { kind: 'group', id });
        const made = findGroup(draft.mixer, id)!;
        return `Made the group “${made.name}” of ${made.members.length} track${made.members.length === 1 ? '' : 's'}${made.vca === undefined ? '' : ` with a VCA at ${r2(vcaDb ?? 0)} dB`}`;
      }
      case 'edit': {
        const id = context.group(action.group);
        const notes: string[] = [];
        const links = linksFrom(action.linked);
        const mode = lower(str(action.mode) ?? '');
        editGroup(draft, id, {
          ...(str(action.name) ? { name: str(action.name)! } : {}),
          ...(str(action.color) ? { color: str(action.color)! } : {}),
          ...(links ? { links } : {}),
          ...(mode === 'relative' || mode === 'absolute' ? { mode } : {}),
        });
        const add = tracksFrom(context, action.add_tracks);
        if (add.length) notes.push(`${joinGroup(draft, id, add)} track(s) added`);
        for (const track of tracksFrom(context, action.remove_tracks)) leaveGroup(draft, track);
        if (bool(action.vca) === true) addVca(draft, id, vcaDb === undefined ? 1 : vcaGain(vcaDb));
        else if (bool(action.vca) === false) removeVca(draft, id);
        else if (vcaDb !== undefined) setVcaLevel(draft, id, vcaGain(vcaDb));
        const group = findGroup(draft.mixer, id);
        return group ? `Changed the group “${group.name}”${notes.length ? ` (${notes.join(', ')})` : ''}` : 'The group is gone (its last track left)';
      }
      case 'vca_level': {
        const id = context.group(action.group);
        const group = findGroup(draft.mixer, id)!;
        const db = vcaDb ?? fail('what level? give vca_db');
        if (group.vca === undefined) addVca(draft, id, vcaGain(db!));
        else setVcaLevel(draft, id, vcaGain(db!));
        return `VCA of “${group.name}” at ${r2(db!)} dB (the members’ faders did not move)`;
      }
      case 'remove': {
        const id = context.group(action.group);
        const name = findGroup(draft.mixer, id)!.name;
        removeGroup(draft, id);
        return `Removed the group “${name}” (its tracks stay as they are)`;
      }
      default:
        return fail(`mixer_group action must be one of ${GROUP_ACTIONS.join(', ')}`);
    }
  },
};

export const mixerState: OpModule = {
  schemas: [
    S.op(
      'mixer_snapshot',
      'Mixer snapshots: the values of the mixer (faders, pans, mutes, solos, sends, effect settings and bypass, VCA levels, and the routing if asked) saved by name in the project. save keeps the mixer as it is; recall puts a snapshot back (one undo step; notes and the arrangement are never touched); update re-saves one with the mixer as it is; rename, delete; diff lists what recalling it would change (or, with "other", what going to the other snapshot changes); compare sets snapshot (A) and other (B) for the musician’s A/B switch and plays "show" (a or b, default a).',
      {
        action: { type: 'string', enum: [...SNAPSHOT_ACTIONS] },
        snapshot: S.str('The snapshot: its name or id (snap_…). Not needed for save.'),
        other: S.str('compare, diff: the second snapshot (B).'),
        name: S.str('save: its name (default “Snapshot N”); rename: the new name.'),
        routing: S.bool('save: also keep who sends to whom and the sidechain sources. recall: false leaves the routing as it is.'),
        show: { type: 'string', enum: ['a', 'b'], description: 'compare: which one to play now (default a).' },
      },
      ['action'],
    ),
    S.op(
      'mixer_group',
      'Mixer groups and VCAs: tracks whose faders, pans, mutes and solos move together (the UI’s Group and Link selected), with an optional VCA fader that scales the members in dB without moving their faders. create makes a group of "tracks" (tracks already in a group move to it); edit changes name, colour, what is linked, relative or absolute moves, adds or removes tracks, and adds or removes the VCA; vca_level sets the VCA in dB (it is an automation target: kind vca); remove deletes the group (the tracks stay).',
      {
        action: { type: 'string', enum: [...GROUP_ACTIONS] },
        ref: S.REF,
        group: S.str('The group: its name or id (grp_…) or @ref. Not needed for create.'),
        name: S.str('The group’s name.'),
        color: S.str('Hex colour of the band on its strips.'),
        tracks: TRACK_LIST,
        add_tracks: { ...TRACK_LIST, description: 'edit: tracks to add to the group.' },
        remove_tracks: { ...TRACK_LIST, description: 'edit: tracks to take out of their group.' },
        linked: {
          type: 'object',
          additionalProperties: false,
          description: 'Which controls move together (all on by default).',
          properties: { volume: S.bool('Faders.'), pan: S.bool('Pans.'), mute: S.bool('Mutes.'), solo: S.bool('Solos.') },
        },
        mode: { type: 'string', enum: ['relative', 'absolute'], description: 'relative (default): the others keep their distance from the track moved; absolute: they all take its value.' },
        vca: S.bool('true: give the group a VCA fader; false: take it away.'),
        vca_db: S.num('The VCA level in dB (−100 = silence … +5.6; 0 = no change to the members).'),
      },
      ['action'],
    ),
  ],
  prompt: {
    id: 'mixer-state',
    order: 27,
    text: `Mixer snapshots and groups (mixer_snapshot, mixer_group):
- Before a risky change to the mix, or when asked to "save this mix", "try another version" or "go back to how it was", save a snapshot (mixer_snapshot save) and recall it later; compare two versions with compare (the musician then switches A and B with the A/B button while the song plays). A snapshot holds only mixer values, so recalling it never changes notes or the arrangement.
- To move several tracks together ("link the drums", "one fader for all the drums"), make a group (mixer_group create, with tracks); add a VCA (vca: true) when they should be turned up or down as one without moving their own faders, and set it with vca_level in dB. It can be automated like a fader (automation target kind vca).
- A reverb or delay return that a solo should not silence is solo-safe: edit_insert with solo_safe true.`,
  },
  handlers: { ...snapshotHandlers, ...groupHandlers },
};

/** Sets A and B (and which one plays) for the musician's A/B switch after a compare action, once the edit is committed. */
export function mixerStateAfter(services: Services, _answer: AiAnswer, state: AnswerState): void {
  const pending = state.bag.get(COMPARE_KEY) as PendingCompare | undefined;
  if (!pending) return;
  services.session.getState().setSnapshotCompare({ a: pending.a as SnapshotId, b: pending.b as SnapshotId, side: pending.side });
  state.ui.push(`A/B compare is set: switch with the A/B button in the mixer (now playing ${pending.side.toUpperCase()})`);
}
