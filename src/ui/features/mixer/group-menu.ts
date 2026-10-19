/**
 * Right-click entries for mixer groups: on a group's colour band, on a VCA strip (the group's own menu) and on a
 * track's strip (group the picked tracks, take it out of its group, solo-safe). Every entry is one undo step
 * (`app/actions/mix-groups.ts`) and says in the hint bar what it does, or why it cannot.
 */
import {
  editMixGroup,
  groupPickedTracks,
  leaveMixGroup,
  linkPickedTracks,
  pickedInserts,
  pickGroupMembers,
  removeMixGroup,
  setGroupVca,
  setInsertSoloSafe,
} from '@app/actions/mix-groups';
import type { Services } from '@app/services';
import { PALETTE } from '@core/model/defaults';
import type { GroupId, GroupLinks, InsertId } from '@core/model/types';
import { findGroup, groupOfInsert } from '@core/query/mix-groups';
import type { MenuEntry } from '../../controls/ContextMenu';

/** The four linked controls, with the words the menu and its hints use. */
const LINK_CHOICES: readonly { control: keyof GroupLinks; label: string; hint: string }[] = [
  { control: 'volume', label: 'Faders', hint: 'Moving one track’s fader moves the others in the group' },
  { control: 'pan', label: 'Pans', hint: 'Turning one track’s pan knob turns the others in the group' },
  { control: 'mute', label: 'Mutes', hint: 'Muting one track mutes the whole group' },
  { control: 'solo', label: 'Solos', hint: 'Soloing one track solos the whole group' },
];

/** The menu of one group: rename, colour, what is linked and how, the VCA, and removing the group. */
export function groupMenuEntries(services: Services, groupId: GroupId, startRename?: () => void): MenuEntry[] {
  const group = findGroup(services.doc.getState().project.mixer, groupId);
  if (!group) return [];
  const entries: MenuEntry[] = [];
  if (startRename) {
    entries.push({ label: 'Rename…', hint: `Give the group “${group.name}” another name`, onSelect: startRename });
  }
  entries.push(
    {
      kind: 'swatches',
      colors: PALETTE,
      selected: group.color,
      onSelect: (color) => editMixGroup(services, groupId, { color }, `Colour of ${group.name}`),
    },
    {
      label: 'Pick the tracks in this group',
      hint: 'Select every track of the group (then Group, Link or Shift-edits act on all of them)',
      onSelect: () => pickGroupMembers(services, groupId),
    },
    { kind: 'separator' },
    {
      kind: 'submenu',
      label: 'Linked controls',
      hint: 'Which controls move together across the group',
      items: LINK_CHOICES.map(({ control, label, hint }) => ({
        label,
        hint,
        checked: group.links[control],
        onSelect: () =>
          editMixGroup(services, groupId, { links: { [control]: !group.links[control] } }, `Link ${label.toLowerCase()} of ${group.name}`),
      })),
    },
    {
      kind: 'submenu',
      label: 'Faders and pans move',
      hint: 'Whether the others keep their distance from the track you move, or all take its value',
      items: [
        {
          label: 'Relative (keep the balance)',
          hint: 'The others keep their distance: moving one fader up 3 dB moves the rest up 3 dB; pans keep their offsets',
          checked: group.mode === 'relative',
          onSelect: () => editMixGroup(services, groupId, { mode: 'relative' }, `${group.name}: relative moves`),
        },
        {
          label: 'Absolute (all the same)',
          hint: 'Every track in the group takes the value of the one you move',
          checked: group.mode === 'absolute',
          onSelect: () => editMixGroup(services, groupId, { mode: 'absolute' }, `${group.name}: absolute moves`),
        },
      ],
    },
    group.vca === undefined
      ? {
          label: 'Add a VCA fader',
          hint: 'A fader that turns the whole group up or down in dB without moving the tracks’ own faders (it can be automated)',
          onSelect: () => setGroupVca(services, groupId, true),
        }
      : {
          label: 'Remove the VCA fader',
          hint: 'The tracks play at their own faders again',
          onSelect: () => setGroupVca(services, groupId, false),
        },
    { kind: 'separator' },
    {
      label: 'Remove group',
      danger: true,
      hint: 'The tracks stay as they are; they just stop moving together',
      onSelect: () => removeMixGroup(services, groupId),
    },
  );
  return entries;
}

/** What a strip's menu adds for groups: group or link the picked tracks, leave the group, solo-safe. */
export function stripGroupEntries(services: Services, insertId: InsertId): MenuEntry[] {
  const project = services.doc.getState().project;
  const picked = pickedInserts(services);
  const hasTwo = picked.length >= 2;
  const needTwo = 'Pick two or more tracks first: Shift-click or Ctrl-click their strips';
  const group = groupOfInsert(project.mixer, insertId);
  const isPicked = services.session.getState().markedInsertIds.includes(insertId);
  const entries: MenuEntry[] = [
    {
      label: isPicked ? 'Unpick this track' : 'Pick this track too',
      hint: 'Pick several tracks, then group or link them (the same as Shift-clicking the strip)',
      onSelect: () => services.session.getState().toggleMarkedInsert(insertId),
    },
    {
      label: hasTwo ? `Group the ${picked.length} picked tracks` : 'Group the picked tracks',
      disabled: !hasTwo,
      hint: hasTwo ? 'Make a group: faders, pans, mutes and solos move together, with a colour and an optional VCA' : needTwo,
      onSelect: () => void groupPickedTracks(services),
    },
    {
      label: hasTwo ? `Link the ${picked.length} picked tracks` : 'Link selected',
      disabled: !hasTwo,
      hint: hasTwo ? 'Quick link: join the picked tracks into one group (the first one’s group, or a new one)' : needTwo,
      onSelect: () => void linkPickedTracks(services),
    },
  ];
  if (group) {
    entries.push(
      { kind: 'submenu', label: `Group “${group.name}”`, hint: 'Rename, colour, what is linked, VCA', items: () => groupMenuEntries(services, group.id) },
      { label: `Take out of “${group.name}”`, hint: 'This track stops moving with the group', onSelect: () => leaveMixGroup(services, insertId) },
    );
  }
  const insert = project.mixer.inserts[insertId];
  entries.push({
    label: 'Solo-safe',
    checked: !!insert?.soloSafe,
    hint: 'A solo elsewhere does not silence this track (use it on a reverb return, a bus or a click)',
    onSelect: () => setInsertSoloSafe(services, insertId, !insert?.soloSafe),
  });
  return entries;
}
