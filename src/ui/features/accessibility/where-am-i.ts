import { songPosition } from '@app/actions/markers';
import type { Services } from '@app/services';
import { formatBST } from '@core/time/ppq';
import { getWindowType } from '../../workspace/registry';

/**
 * One spoken sentence or two for "Where am I?": the part of the screen the keyboard is in, the window that is in front,
 * the selected sound and pattern, and the transport (playing or stopped, where, how fast).
 */
export function describeWhereAmI(services: Services, paneLabel: string | null): string {
  const view = services.view.getState();
  const project = services.doc.getState().project;
  const front = view.focusedId ? view.windows[view.focusedId] : undefined;
  const frontTitle = front ? getWindowType(front.type)?.title(front.props, services) : undefined;
  const parts: string[] = [];
  parts.push(paneLabel ? `In ${paneLabel}` : frontTitle ? `Front window: ${frontTitle}` : 'No window is in front');
  const channelId = services.session.getState().selectedChannelId;
  const channel = channelId ? project.channels[channelId] : undefined;
  if (channel) parts.push(`selected sound ${channel.name}`);
  const pattern = view.currentPatternId ? project.patterns[view.currentPatternId] : undefined;
  if (pattern) parts.push(`pattern ${pattern.name}`);
  const where = formatBST(songPosition(services), project.transport.timeSig);
  const mode = view.mode === 'song' ? 'song mode' : 'pattern mode';
  parts.push(`${services.engine.playing ? 'playing' : 'stopped'} in ${mode}, position ${where}, ${Math.round(project.transport.bpm)} beats per minute`);
  return `${parts.join('. ')}.`;
}
