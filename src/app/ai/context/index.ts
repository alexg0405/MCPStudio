/**
 * The project as the AI sees it each turn: the song, every channel with its plugin settings, the
 * mixer (levels, routes, effects with their settings, sidechains), patterns, the playlist and what is
 * selected. Ids are included so actions can refer to things exactly; only settings that differ from
 * the plugin defaults are listed.
 *
 * The text is built from one module per part: `channel-lines`, `mixer-lines`, `pattern-lines`,
 * `playlist-lines`, and `budget` (shortening a very large project to fit).
 */
import { chordTrackLines } from '@core/query/chords';
import { lyricTrackLines } from '@core/query/lyrics';
import type { Project } from '@core/model/types';
import { insertLabel } from '@core/query/mixer';
import { arrangementLines } from '../../arrange/summary';
import { musicLibraryLines } from '../../dj/library';
import { djLines } from '../../dj/mix';
import { recentFiles } from '../../persistence/recent-files';
import { referenceLines } from '../../reference/summary';
import type { Services } from '../../services';
import { aiCommands } from '../commands';
import type { ResolvedFocus } from '../focus';
import { noteLines } from '../note-lines';
import { deckLines } from '../ops/decks';
import { launcherLines } from '../ops/launcher';
import { CONTEXT_BUDGET, cutNote, SHORTENING_STEPS, type ContextRender } from './budget';
import { channelKind, channelLine, channelsThatPlay, fullChannels } from './channel-lines';
import { mixerSection } from './mixer-lines';
import { fullPatterns, patternLines } from './pattern-lines';
import { playlistLines, songCheckLines } from './playlist-lines';

export { noteLines };
export { CONTEXT_BUDGET, patternLines, playlistLines, songCheckLines };

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
/** Recent projects named in the app line. */
const RECENT_PROJECTS_SHOWN = 8;

/** The app around the project: the file, what is switched on, what Undo would revert. */
function appLine(services: Services): string {
  const file = services.files.store.getState();
  const history = services.history.status();
  const switchedOn = aiCommands(services)
    .filter((command) => command.checked && services.commands.isChecked(command.id))
    .map((command) => command.title);
  const recent = recentFiles()
    .slice(0, RECENT_PROJECTS_SHOWN)
    .map((recentFile) => `"${recentFile.name.replace(/\.agproj$/i, '')}"`);
  const parts = [
    `file "${file.name}"${history.dirty ? ' (unsaved changes)' : ' (saved)'}`,
    recent.length ? `recent projects: ${recent.join(', ')}` : '',
    switchedOn.length ? `on right now: ${switchedOn.join(', ')}` : 'no toggles on',
    history.undoLabel ? `undo would revert “${history.undoLabel}”` : 'nothing to undo',
  ];
  return `App: ${parts.filter(Boolean).join('; ')}.`;
}

/** The first line: tempo, time signature, swing, key, mode and the current pattern. */
function songLine(services: Services, project: Project): string {
  const view = services.view.getState();
  const { transport } = project;
  const key = transport.key ? `${NOTE_NAMES[transport.key.root]} ${transport.key.scale}` : 'not set';
  const current = view.currentPatternId ? project.patterns[view.currentPatternId] : undefined;
  const currentText = current ? `"${current.name}" ${current.id}` : 'none';
  return `Song: ${transport.bpm} BPM, ${transport.timeSig.num}/${transport.timeSig.den}, swing ${Math.round(transport.swing * 100)}%, key ${key}. Mode: ${view.mode}. Current pattern: ${currentText}.`;
}

/** The channel rack: every channel in full, or (when shortened) the unimportant ones compactly. */
function channelSection(
  services: Services,
  project: Project,
  render: ContextRender,
  fullPatternIds: ReturnType<typeof fullPatterns> | null,
): string[] {
  const selected = services.session.getState().selectedChannelId;
  const keep =
    render.shorten.channelsCompact && fullPatternIds ? fullChannels(project, fullPatternIds, selected) : null;
  const plays = render.shorten.silentChannels ? channelsThatPlay(project) : null;
  const channels: string[] = [];
  const silent: string[] = [];
  project.channelOrder.forEach((id, index) => {
    const channel = project.channels[id];
    if (!channel) return;
    if (plays && !plays.has(id) && id !== selected) {
      silent.push(`#${index + 1} "${channel.name}" ${id}`);
    } else if (keep && !keep.has(id)) {
      render.cut.add('channels');
      channels.push(`${index + 1} · ${id} · "${channel.name}" · ${channelKind(services, channel)}`);
    } else {
      channels.push(channelLine(services, project, channel, index + 1, render));
    }
  });
  if (silent.length) {
    render.cut.add('channels');
    channels.push(`Play nowhere (no notes in the song, no clips): ${silent.join(', ')}`);
  }
  if (project.channelOrder.length === 0) channels.push('(none)');
  return channels;
}

/** Parts that only appear when the project has something for them (chords, arrangement, DJ, reference, library, decks, launcher). */
function optionalSections(services: Services, project: Project): string[] {
  const lines: string[] = [];
  const chordLines = chordTrackLines(project);
  if (chordLines.length) {
    lines.push(
      '',
      'Chord track (chord per bar; · two chords in a bar, – none):',
      ...chordLines.map((line) => `  ${line}`),
    );
  }
  const lyricLines = lyricTrackLines(project);
  if (lyricLines.length) lines.push('', 'Lyrics (first bar of each line):', ...lyricLines.map((line) => `  ${line}`));
  const arrangement = arrangementLines(project);
  if (arrangement.length) lines.push(...arrangement);
  const sections = [
    djLines(project),
    referenceLines(project),
    musicLibraryLines(services),
    deckLines(services),
    launcherLines(services),
  ];
  for (const section of sections) if (section.length) lines.push('', ...section);
  const check = songCheckLines(project);
  if (check.length) lines.push('', 'Song check (problems in the arrangement right now):', ...check);
  return lines;
}

/** One render of the project text with the given shortening. */
function renderContext(services: Services, render: ContextRender): string {
  const project = services.doc.getState().project;
  const view = services.view.getState();
  const session = services.session.getState();
  const current = view.currentPatternId ? project.patterns[view.currentPatternId] : undefined;
  const lines: string[] = [songLine(services, project), appLine(services)];

  const fullPatternIds = render.shorten.patternsCompact
    ? fullPatterns(project, current?.id ?? null, render.focus)
    : null;
  const channels = channelSection(services, project, render, fullPatternIds);
  lines.push('', 'Channels (channel rack order):', ...cutNote(render, 'channels'), ...channels);

  const mixer = mixerSection(services, project, render);
  lines.push(
    '',
    'Mixer tracks (number = position; channels feed the track shown after →):',
    ...cutNote(render, 'mixer'),
    ...mixer,
  );

  const patterns = patternLines(project, render, current?.id ?? null, fullPatternIds);
  lines.push('', 'Patterns:', ...cutNote(render, 'patterns'), ...patterns);
  if (current) {
    lines.push(
      `  Notes of the current pattern (steps are 1/16 notes from 0; pitched notes as step:note/length; @ = velocity 0–1 when not 0.8):`,
    );
    lines.push(...noteLines(project, current));
  }

  lines.push('', ...playlistLines(project, render));
  lines.push(...optionalSections(services, project));

  const selectedChannel = session.selectedChannelId ? project.channels[session.selectedChannelId] : undefined;
  const selectedInsert = session.selectedInsertId ? project.mixer.inserts[session.selectedInsertId] : undefined;
  lines.push(
    '',
    `Selected: channel ${selectedChannel ? `"${selectedChannel.name}"` : 'none'}, mixer track ${selectedInsert ? insertLabel(project, selectedInsert.id) : 'none'}.`,
  );
  return lines.join('\n');
}

/**
 * The project text, within `CONTEXT_BUDGET` characters where it can be. Each step in `SHORTENING_STEPS` shortens
 * one more part; the first step that fits is the answer, so a project under the budget is rendered in full.
 */
export function projectContext(services: Services, focus: ResolvedFocus | null = null): string {
  let text = '';
  for (const shorten of SHORTENING_STEPS) {
    text = renderContext(services, { shorten, cut: new Set(), focus });
    if (text.length <= CONTEXT_BUDGET) break;
  }
  return text;
}
