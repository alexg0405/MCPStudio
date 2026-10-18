/** The mixer as text: one line per track in use (with its effects), and one line for the empty ones. */
import { MASTER, type Insert, type Project } from '@core/model/types';
import { insertLabel } from '@core/query/mixer';
import type { Services } from '../../services';
import type { ContextRender } from './budget';
import { paramSummary, pluginName } from './channel-lines';
import { formatDb, round2 } from './units';

/** A track nobody uses: default name, level and routing, no effects, no channel and nothing sent to it. */
export function isPlainInsert(project: Project, insert: Insert): boolean {
  if (insert.id === MASTER) return false;
  const hasChannel = project.channelOrder.some((channelId) => {
    const channel = project.channels[channelId];
    return channel && channel.kind !== 'automation' && channel.output === insert.id;
  });
  const isSentTo = Object.values(project.mixer.inserts).some((other) =>
    other.routes.some((route) => route.to === insert.id),
  );
  return (
    !hasChannel &&
    insert.fx.length === 0 &&
    insert.volume === 1 &&
    insert.pan === 0 &&
    !insert.muted &&
    insert.routes.length === 1 &&
    insert.routes[0]!.to === MASTER &&
    /^Insert \d+$/.test(insert.name) &&
    !isSentTo
  );
}

/** Where a track sends its sound: nothing for the master, "routed nowhere" or the list of its routes. */
function routesText(project: Project, insert: Insert): string {
  if (insert.id === MASTER) return '';
  if (insert.routes.length === 0) return '; routed nowhere (silent)';
  const routes = insert.routes.map(
    (route) => `${insertLabel(project, route.to)} ${formatDb(route.level)}${route.pre ? ' pre-fader' : ''}`,
  );
  return `; routes → ${routes.join(', ')}`;
}

/** A track's line followed by one line per effect. */
export function insertLines(services: Services, project: Project, insert: Insert, render: ContextRender): string[] {
  const label = insertLabel(project, insert.id);
  const flags = [insert.muted ? 'muted' : '', insert.solo ? 'solo' : ''].filter(Boolean).join(', ');
  const name = insert.id === MASTER ? '' : ` "${insert.name}"`;
  const lines = [
    `- ${label}${name} ${insert.id}: vol ${formatDb(insert.volume)}, pan ${round2(insert.pan)}${flags ? `, ${flags}` : ''}${routesText(project, insert)}`,
  ];
  insert.fx.forEach((slot, index) => {
    const sidechain = slot.sidechain ? `, sidechain from ${insertLabel(project, slot.sidechain)}` : '';
    const plugin = `${pluginName(services, slot.plugin.pluginId)} (${slot.plugin.pluginId}) ${slot.id}`;
    const bypassed = slot.enabled ? '' : ' BYPASSED';
    const settings = paramSummary(services, slot.plugin, render, 'mixer');
    lines.push(
      `   fx ${index + 1}: ${plugin}${bypassed}, mix ${Math.round(slot.mix * 100)}%${sidechain}; settings: ${settings}`,
    );
  });
  return lines;
}

/** The mixer section: the tracks in use in full, the plain ones as one line listing their numbers. */
export function mixerSection(services: Services, project: Project, render: ContextRender): string[] {
  const lines: string[] = [];
  const plainNumbers: number[] = [];
  project.mixer.order.forEach((id, number) => {
    const insert = project.mixer.inserts[id];
    if (!insert) return;
    if (isPlainInsert(project, insert)) plainNumbers.push(number);
    else lines.push(...insertLines(services, project, insert, render));
  });
  if (plainNumbers.length)
    lines.push(`- Inserts ${plainNumbers.join(', ')}: empty (default settings, routed to Master)`);
  return lines;
}
