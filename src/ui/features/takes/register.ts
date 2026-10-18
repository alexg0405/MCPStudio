/**
 * Takes and comping: the commands, menu entries and key bindings that work on a recording's take group (a
 * comp track with its takes folded under it). The playlist's Comp tool (drag across a take) lives in the
 * playlist controller; everything it can do is here too, for menus, the action search and the AI.
 */
import {
  compRange,
  compTarget,
  flatten,
  setCrossfade,
  setTakesOpen,
  stepTakeFor,
  chooseTake,
  listenToTake,
  takeClipFor,
  type CompTarget,
} from '@app/actions/comp';
import type { Services } from '@app/services';
import { DEFAULT_CROSSFADE_MS, MAX_CROSSFADE_MS } from '@core/audio/comp';
import type { Clip, LaneId } from '@core/model/types';
import { groupOfLane } from '@core/query/takes';
import type { MenuEntry } from '../../controls/ContextMenu';
import { showFormDialog } from '../../controls/FormDialog';
import { addContextMenuItems } from '../../context-menus';
import { addMenuItems, cmd, sep } from '../../shell/menus';

type Args = { clip?: string; group?: string; take?: number; from_bar?: number; to_bar?: number; merge?: boolean; ms?: number; open?: boolean; on?: boolean };

const GROUP_ARGS =
  'optional { clip: id of a take or comp clip, or group: take group id } (default: the selected clip, the clip under the pointer, or the song’s only take group)';

function target(s: Services, args?: Args): CompTarget | null {
  const t = compTarget(s, args);
  if (!t) s.session.getState().toast('Select a clip of a recording’s takes (or its comp track) first.');
  return t;
}

/** "Use this take": a take number (1-based) from the args, else the take of the clip. */
function takeIndexOf(s: Services, t: CompTarget, args?: Args): number | null {
  if (typeof args?.take === 'number') {
    const found = t.group.takes[Math.round(args.take) - 1];
    if (!found) s.session.getState().toast(`This recording has ${t.group.takes.length} takes: there is no take ${args.take}.`, 'error');
    return found?.index ?? null;
  }
  if (t.take !== null) return t.take;
  s.session.getState().toast('Select the take you want to use first (a clip on one of the take tracks).');
  return null;
}

async function crossfadeDialog(s: Services, groupId: string, current: number): Promise<void> {
  const values = await showFormDialog({
    title: 'Comp crossfade',
    message: 'Where two takes meet, they fade across each other (equal power, centred on the cut) instead of clicking. Shorter keeps the attack of a word; longer hides a cut in a sustained note.',
    fields: [{ kind: 'number', key: 'ms', label: 'Crossfade', min: 0, max: MAX_CROSSFADE_MS, step: 1, unit: 'ms' }],
    values: { ms: current },
    okLabel: 'Apply',
  });
  if (values) setCrossfade(s, groupId, Number(values.ms));
}

/** The take entries of a clip's menu. */
export function takeClipMenu(s: Services, clip: Clip): MenuEntry[] {
  if (clip.kind !== 'audio' || !clip.take) return [];
  const t = compTarget(s, { clip: clip.id });
  if (!t) return [];
  const isTake = !clip.take.comp;
  const open = s.editor.getState().openTakes.includes(t.group.id);
  const heard = s.editor.getState().auditionTake === clip.id;
  return [
    {
      label: heard ? 'Stop listening to this take' : isTake ? 'Listen to this take' : 'Listen to the take this plays',
      shortcut: 'Alt+L',
      hint: 'Hear this one take on its own, without unmuting it (the comp and the other takes go quiet); the project is not changed. Choose it again to go back to the comp',
      onSelect: () => void s.commands.run('comp.listenTake', { clip: clip.id }),
    },
    ...(isTake
      ? [
          {
            label: 'Use this take',
            hint: 'The comp track plays this whole take (replaces what it plays now); drag across a take with the Comp tool to use only a part',
            onSelect: () => void s.commands.run('comp.useTake', { clip: clip.id }),
          },
        ]
      : []),
    {
      label: 'Next take here',
      shortcut: ']',
      hint: 'Swap this part of the comp for the next take (it goes round)',
      onSelect: () => void s.commands.run('comp.nextTake', { clip: clip.id }),
    },
    {
      label: 'Previous take here',
      shortcut: '[',
      hint: 'Swap this part of the comp for the previous take',
      onSelect: () => void s.commands.run('comp.previousTake', { clip: clip.id }),
    },
    {
      label: open ? 'Fold the takes' : 'Open the takes',
      hint: 'Show or hide the take tracks under the comp track',
      onSelect: () => void s.commands.run('comp.toggleTakes', { clip: clip.id }),
    },
    {
      label: 'Flatten comp',
      hint: 'Keep what the comp plays as ordinary clips and delete the take tracks (undo brings them back)',
      onSelect: () => void s.commands.run('comp.flatten', { clip: clip.id }),
    },
    {
      label: 'Flatten and merge into one clip',
      hint: 'Render the comp into one new clip (crossfades included) and delete the take tracks',
      onSelect: () => void s.commands.run('comp.flatten', { clip: clip.id, merge: true }),
    },
  ];
}

/** The take entries of a track's menu. */
export function takeLaneMenu(s: Services, laneId: LaneId): MenuEntry[] {
  const p = s.doc.getState().project;
  const g = groupOfLane(p, laneId);
  if (!g) return [];
  const open = s.editor.getState().openTakes.includes(g.id);
  return [
    {
      label: open ? 'Fold the takes' : 'Open the takes',
      hint: 'Show or hide the take tracks under the comp track',
      onSelect: () => void s.commands.run('comp.toggleTakes', { group: g.id }),
    },
    {
      label: `Comp crossfade… (${g.crossfadeMs} ms)`,
      hint: 'How long two takes fade across each other where the comp changes take',
      onSelect: () => void crossfadeDialog(s, g.id, g.crossfadeMs),
    },
    {
      label: 'Flatten comp',
      hint: 'Keep what the comp plays as ordinary clips and delete the take tracks (undo brings them back)',
      onSelect: () => void s.commands.run('comp.flatten', { group: g.id }),
    },
    {
      label: 'Flatten and merge into one clip',
      hint: 'Render the comp into one new clip (crossfades included) and delete the take tracks',
      onSelect: () => void s.commands.run('comp.flatten', { group: g.id, merge: true }),
    },
  ];
}

export function register(services: Services): void {
  const { commands, keymap } = services;
  const hasGroup = (s: Services) => compTarget(s) !== null;

  commands.register<Args>({
    id: 'comp.useTake',
    title: 'Use this take',
    category: 'Takes',
    hint: 'The comp track plays the selected take (all of it), or only from_bar–to_bar of it. Drag across a take with the Comp tool to pick a part by hand',
    argsHint: `{ take: 1-based take number (default: the selected take clip's), from_bar and to_bar to use only those bars (default: the whole take), clip or group to say which recording }`,
    enabled: hasGroup,
    run: (s, args) => {
      const t = target(s, args);
      if (!t) return;
      const take = takeIndexOf(s, t, args);
      if (take === null) return;
      const range = typeof args?.from_bar === 'number' ? compRange(s, t, args) : undefined;
      if (!chooseTake(s, t.group.id, take, range)) s.session.getState().toast('Nothing changed: that take has no audio there, or already plays there.');
    },
  });
  for (const [id, title, dir, chord, hint] of [
    ['comp.nextTake', 'Next take', 1, ']', 'Swap the selected part of the comp (or the clip under the pointer) for the next take; it goes round'],
    ['comp.previousTake', 'Previous take', -1, '[', 'Swap the selected part of the comp (or the clip under the pointer) for the previous take'],
  ] as const) {
    commands.register<Args>({
      id,
      title,
      category: 'Takes',
      hint,
      argsHint: `${GROUP_ARGS}; from_bar and to_bar to say which bars (default: the clip's own span)`,
      enabled: hasGroup,
      run: (s, args) => {
        const t = target(s, args);
        if (!t) return;
        const now = stepTakeFor(s, t.group.id, compRange(s, t, args), dir);
        if (now === null) s.session.getState().toast('No other take has audio there.');
        else s.session.getState().setHint(`The comp plays take ${t.group.takes.findIndex((x) => x.index === now) + 1} here`);
      },
    });
    keymap.add([{ chord, command: id, when: { focus: ['playlist'] } }]);
  }
  commands.register<Args>({
    id: 'comp.listenTake',
    title: 'Listen to this take (solo)',
    category: 'Takes',
    hint: 'Hear one take on its own: the comp and the other takes go quiet, nothing is unmuted or changed in the project. Run it again to go back to the comp. The speaker on a take track does the same: hold it to listen only while pressed',
    argsHint: `${GROUP_ARGS}; take: 1-based take number to hear (default: the selected take clip's); on: false goes back to the comp`,
    enabled: (s) => hasGroup(s) || s.editor.getState().auditionTake !== null,
    run: (s, args) => {
      const ed = s.editor.getState();
      const stop = () => {
        listenToTake(s, null, false);
        s.session.getState().setHint('Back to the comp');
      };
      if (args?.on === false) return stop();
      const t = compTarget(s, args);
      if (!t) {
        if (ed.auditionTake) return stop();
        s.session.getState().toast('Select a take (a clip on one of the take tracks) first.');
        return;
      }
      const index = takeIndexOf(s, t, args);
      if (index === null) return;
      const project = s.doc.getState().project;
      const given = typeof args?.clip === 'string' ? project.playlist.clips[args.clip as never] : undefined;
      // The clip named (or selected) when it is a take clip, else the take's clip under the target's span.
      const clip = given?.kind === 'audio' && given.take && !given.take.comp && typeof args?.take !== 'number' ? given.id : takeClipFor(t.group, index, t.span);
      const now = listenToTake(s, clip, args?.on);
      if (now) {
        const n = t.group.takes.findIndex((x) => x.index === index) + 1;
        s.session.getState().setHint(`Listening to take ${n} on its own: the comp and the other takes are quiet. Alt+L again (or the speaker on the track) goes back`);
      } else s.session.getState().setHint('Back to the comp');
    },
  });
  keymap.add([{ chord: 'Alt+L', command: 'comp.listenTake', when: { focus: ['playlist'] } }]);
  commands.register<Args>({
    id: 'comp.flatten',
    title: 'Flatten comp',
    category: 'Takes',
    hint: 'Keep what the comp plays as ordinary clips and delete the take tracks; with merge, render it into one new clip (undo brings the takes back)',
    argsHint: `${GROUP_ARGS}; merge: true renders the comp into one clip`,
    enabled: hasGroup,
    run: async (s, args) => {
      const t = target(s, args);
      if (!t) return;
      try {
        if (await flatten(s, t.group.id, args?.merge === true))
          s.session.getState().toast(args?.merge === true ? 'Flattened and merged the comp into one clip.' : 'Flattened the comp: the takes are gone, the comp stays as ordinary clips.');
      } catch (e) {
        s.session.getState().toast(e instanceof Error ? e.message : String(e), 'error');
      }
    },
  });
  commands.register<Args>({
    id: 'comp.crossfade',
    title: 'Comp crossfade…',
    category: 'Takes',
    hint: `How long two takes fade across each other where the comp changes take (default ${DEFAULT_CROSSFADE_MS} ms); the comp is rebuilt with it`,
    argsHint: `{ ms: 0–${MAX_CROSSFADE_MS} } with optional clip or group; without ms: a dialog`,
    enabled: hasGroup,
    run: async (s, args) => {
      const t = target(s, args);
      if (!t) return;
      if (typeof args?.ms === 'number') setCrossfade(s, t.group.id, args.ms);
      else await crossfadeDialog(s, t.group.id, t.group.crossfadeMs);
    },
  });
  commands.register<Args>({
    id: 'comp.toggleTakes',
    title: 'Open or fold the takes',
    category: 'Takes',
    hint: 'Show or hide the take tracks under a recording’s comp track (the ▸ on the comp track does the same)',
    argsHint: `${GROUP_ARGS}; open: true or false to set it (default: switch)`,
    enabled: hasGroup,
    run: (s, args) => {
      const t = target(s, args);
      if (t) setTakesOpen(s, t.group.id, typeof args?.open === 'boolean' ? args.open : undefined);
    },
  });

  addContextMenuItems('playlist.clip', ({ clip }, s) => takeClipMenu(s, clip));
  addContextMenuItems('playlist.lane', ({ laneId }, s) => takeLaneMenu(s, laneId));
  addMenuItems('playlist', [
    cmd('comp.useTake', 60),
    cmd('comp.nextTake', 61),
    cmd('comp.previousTake', 62),
    cmd('comp.listenTake', 66),
    cmd('comp.toggleTakes', 63),
    cmd('comp.crossfade', 64),
    cmd('comp.flatten', 65),
    sep(69),
  ]);
}
