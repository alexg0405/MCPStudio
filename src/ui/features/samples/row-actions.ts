/** What you can do with a sound in the sample browser: put it in the project, make a kit, and the right-click menu. */
import type { Services } from '@app/services';
import type { BrowserRow } from '@app/samples/browser';
import { addRowAsClip, addRowsAsChannels, makeKitFromRows, previewRow } from '@app/samples/actions';
import type { MenuEntry } from '../../controls/ContextMenu';

/** Double-click and the A key: a loop goes on the playlist as a clip, anything else becomes a sampler channel. */
export function addRowToProject(services: Services, row: BrowserRow): void {
  if (row.analysis?.kind === 'loop') void addRowAsClip(services, row);
  else void addRowsAsChannels(services, [row]);
}

/** Makes a Drum Pads kit from the one-shots and says in a toast how it went. */
export async function makeKitWithToast(services: Services, rows: readonly BrowserRow[]): Promise<void> {
  const result = await makeKitFromRows(services, rows);
  const session = services.session.getState();
  if (!result.channelId) {
    session.toast('No pad got a sound: pick one-shots that have been analyzed.', 'error');
    return;
  }
  const padCount = result.placed.length;
  const leftOutCount = result.plan.skipped.length;
  const padsText = `${padCount} pad${padCount === 1 ? '' : 's'}`;
  const leftOutText = leftOutCount > 0 ? `, ${leftOutCount} left out` : '';
  session.toast(`Made a kit: ${padsText}${leftOutText}`, 'info');
}

/** What the right-click menu of one sound needs to know. */
export interface RowMenuContext {
  services: Services;
  browser: SampleBrowserLike;
  /** The sound that was right-clicked. */
  row: BrowserRow;
  /** The sounds the menu acts on: the whole selection when the clicked sound is in it, else just the clicked one. */
  group: readonly BrowserRow[];
  /** The id of the sound being auditioned, if any. */
  playingId: string | null;
  onFindSimilar(): void;
  onFocusTagBox(): void;
}

/** The part of the sample browser model the menu uses. */
type SampleBrowserLike = Pick<Services['sampleBrowser'], 'toggleFavorite' | 'removeTag'>;

/** The entries of the right-click menu for a sound (or for the selected sounds, when it is one of them). */
export function rowMenuEntries(context: RowMenuContext): MenuEntry[] {
  const { services, browser, row, group, playingId } = context;
  const oneShots = group.filter((r) => r.analysis?.kind === 'one-shot');
  const entries: MenuEntry[] = [
    {
      label: playingId === row.id ? 'Stop' : 'Play',
      onSelect: () => void previewRow(services, row, { toggle: true }),
      hint: 'Hear this sound through the preview (loops play at the project tempo)',
    },
    { kind: 'separator' },
    {
      label: group.length > 1 ? `Add ${group.length} as sampler channels` : 'Add as a sampler channel',
      onSelect: () => void addRowsAsChannels(services, group),
      hint: 'One channel per sound on the channel rack, after the selected channel',
    },
    {
      label: 'Add to the playlist',
      onSelect: () => void addRowAsClip(services, row),
      hint: 'An audio clip at the song position marker, on the first track with room (a loop follows the song tempo)',
    },
    {
      label: oneShots.length > 1 ? `Make a drum kit from ${oneShots.length} one-shots` : 'Make a drum kit from the selected one-shots',
      disabled: oneShots.length < 1,
      onSelect: () => void makeKitWithToast(services, oneShots),
      hint: 'A Drum Pads channel: kick on pad 1, snare on 3, clap on 4, hats on 7 and 9, toms and cymbals on the others',
    },
    { kind: 'separator' },
    {
      label: 'Find similar sounds',
      onSelect: context.onFindSimilar,
      disabled: !row.analysis || row.analysis.kind === 'long',
      hint: 'The sounds that are closest to this one in brightness, length, pitch and tone',
    },
    {
      label: row.favorite ? 'Remove from favorites' : 'Add to favorites',
      onSelect: () => group.forEach((r) => browser.toggleFavorite(r.id, !row.favorite)),
    },
    {
      label: 'Add a tag…',
      onSelect: context.onFocusTagBox,
      hint: 'Type your own word in the tag box below (Enter adds it to the selected sounds)',
    },
  ];
  for (const tag of row.userTags) {
    entries.push({ label: `Remove tag “${tag}”`, onSelect: () => group.forEach((r) => browser.removeTag(r.id, tag)) });
  }
  return entries;
}
