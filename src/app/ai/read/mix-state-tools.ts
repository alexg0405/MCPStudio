/** Read tools for the mixer's saved states and groups: the snapshots (and what recalling one would change), the groups and VCAs. */
import { MASTER } from '@core/model/types';
import { diffAgainstCurrent } from '@core/snapshots/diff';
import { gainDb, mixerNumber, mixerTrackName, projectOf, tool } from './tool';
import * as S from '../schema/parts';

/** The most difference lines one reply lists. */
const MAX_DIFFERENCES = 60;

export const getMixSnapshots = tool(
  'get_mix_snapshots',
  'The saved mixer snapshots (name, id, whether it holds routing, how many tracks and effects it covers, when it was saved) and the A/B pair the musician compares. Give "snapshot" (name or id) with diff true to list what recalling it would change in the mix as it is now.',
  {
    snapshot: S.str('Only this snapshot (its name or id snap_…).'),
    diff: S.bool('With "snapshot": list what recalling it would change (plain sentences with units).'),
  },
  (services, args, lookup) => {
    const project = projectOf(services);
    const compare = services.session.getState().snapshotCompare;
    const nameOf = (id: string | null) => project.mixSnapshots?.find((snapshot) => snapshot.id === id)?.name ?? null;
    const wanted = args.snapshot !== undefined ? lookup.snapshot(args.snapshot) : null;
    const list = (project.mixSnapshots ?? []).filter((snapshot) => !wanted || snapshot.id === wanted);
    const snapshots = list.map((snapshot) => {
      const tracks = Object.values(snapshot.inserts);
      return {
        id: snapshot.id,
        name: snapshot.name,
        saved: new Date(snapshot.savedAt).toISOString(),
        routing: !!snapshot.routing,
        tracks: tracks.length,
        effects: tracks.reduce((sum, track) => sum + Object.keys(track.fx).length, 0),
        ...(args.diff === true && wanted
          ? { differences: diffAgainstCurrent(project, snapshot, services.automation.pluginInfo).slice(0, MAX_DIFFERENCES).map((line) => line.text) }
          : {}),
      };
    });
    return {
      snapshots,
      compare: { a: nameOf(compare.a), b: nameOf(compare.b), playing: compare.side },
      ...(snapshots.length === 0 ? { note: 'No snapshots yet: mixer_snapshot save keeps the mixer as it is.' } : {}),
    };
  },
);

export const getMixGroups = tool(
  'get_mix_groups',
  'The mixer groups (tracks that move together) with their members, what is linked, relative or absolute moves, and the VCA level in dB when they have one, plus the tracks marked solo-safe.',
  {},
  (services) => {
    const project = projectOf(services);
    const groups = (project.mixer.groups ?? []).map((group) => ({
      id: group.id,
      name: group.name,
      color: group.color,
      tracks: group.members.map((id) => ({ n: mixerNumber(project, id), name: mixerTrackName(project, id) })),
      linked: group.links,
      mode: group.mode,
      ...(group.vca !== undefined ? { vca_db: gainDb(group.vca) } : {}),
    }));
    const soloSafe = project.mixer.order
      .filter((id) => id !== MASTER && project.mixer.inserts[id]?.soloSafe)
      .map((id) => ({ n: mixerNumber(project, id), name: mixerTrackName(project, id) }));
    return {
      groups,
      ...(soloSafe.length ? { solo_safe: soloSafe } : {}),
      ...(groups.length === 0 ? { note: 'No groups yet: mixer_group create makes one from mixer tracks.' } : {}),
    };
  },
);
