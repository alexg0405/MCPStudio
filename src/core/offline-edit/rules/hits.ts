/**
 * "Hit harder": the kick and snare play louder (their velocities), the snare gets a clap layered on it, and in the mix the kick
 * gets saturation and the drums a sharper attack. The mix part is for the whole song; a named part only gets the notes.
 */
import { MASTER, type ChannelId, type InsertId } from '../../model/types';
import { channelsPlaying, patternParts, insertNamed, skippedLine, notesAsSteps, slotOf, oneDecimal, type PatternPart } from '../rule-kit';
import { byAmount } from '../words';
import { KICK_ROLES, SNARE_ROLES } from '../song-facts';
import type { OfflineAction, Rule, RuleContext, RuleResult } from '../types';

const HIT_HARDER =
  /\b(?:hits? (?:a lot |much |way )?harder|hit(?:s|ting)? hard|punch(?:ier|y)|more punch|(?:kick|snare|drums|beat|hits) (?:harder|punchier|bigger|heavier|more aggressive)|(?:harder|bigger|heavier|fatter|beefier|tighter|punchier) (?:kick|snare|drums|hits|beat)|more (?:impact|slam|bite|weight)|slamming|snappier|knock(?:ing)? harder)\b/;

const SATURATOR = 'agstudio.saturator';
const TRANSIENT_SHAPER = 'agstudio.transient';
const CLAP_LAYER_NAME = 'Snare layer';
/** The layer plays softer than the snare it sits on (it adds body, it does not replace the snare). */
const LAYER_VELOCITY_SHARE = 0.8;
/** The layer's fader, dB: under the snare. */
const LAYER_VOLUME_DB = -6;
/** Most drive the saturator is pushed to by repeated asks (dB). */
const MAX_DRIVE_DB = 18;

function numberParam(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

/** Saturation on the kick's track: more drive when it has a saturator already, a new saturator when not. */
function kickSaturation(context: RuleContext, kickOutput: InsertId | undefined): { action: OfflineAction; line: string } | null {
  const { project } = context.facts;
  const insert = insertNamed(project, 'Kick') ?? (kickOutput && kickOutput !== MASTER ? project.mixer.inserts[kickOutput] : undefined);
  if (!insert) return null;
  const existing = slotOf(insert, SATURATOR);
  const steps = byAmount(context.amount, [2, 4, 7]);
  if (existing) {
    const drive = Math.min(MAX_DRIVE_DB, numberParam(existing.plugin.params.drive, 6) + steps);
    return {
      action: { op: 'edit_effect', effect: existing.id, params: [{ name: 'drive', value: drive }] },
      line: `saturation on “${insert.name}” up to ${oneDecimal(drive)} dB drive`,
    };
  }
  return {
    action: { op: 'add_effect', insert: insert.id, plugin: SATURATOR, params: [{ name: 'drive', value: steps + 3 }, { name: 'mix', value: 0.6 }] },
    line: `saturation on “${insert.name}”`,
  };
}

/** A sharper attack on the Drums bus. */
function drumAttack(context: RuleContext): { action: OfflineAction; line: string } | null {
  const insert = insertNamed(context.facts.project, 'Drums');
  if (!insert) return null;
  const existing = slotOf(insert, TRANSIENT_SHAPER);
  const step = byAmount(context.amount, [0.15, 0.25, 0.4]);
  if (existing) {
    const attack = Math.min(1, numberParam(existing.plugin.params.attack, 0) + step);
    return {
      action: { op: 'edit_effect', effect: existing.id, params: [{ name: 'attack', value: attack }] },
      line: `a sharper attack on “${insert.name}”`,
    };
  }
  return {
    action: { op: 'add_effect', insert: insert.id, plugin: TRANSIENT_SHAPER, params: [{ name: 'attack', value: step + 0.1 }] },
    line: `a sharper attack on “${insert.name}”`,
  };
}

/** A clap layered under the snare, in every pattern the snare plays in (a snare with a clap already has its layer). */
function snareLayer(context: RuleContext, parts: readonly PatternPart[], snares: readonly ChannelId[]): OfflineAction[] {
  const { facts } = context;
  // A clap that plays with the snare is its layer already.
  const hasClap = parts.some((part) => facts.roles.get(part.channel) === 'clap');
  const snareParts = parts.filter((part) => snares.includes(part.channel) && facts.roles.get(part.channel) === 'snare');
  if (hasClap || snareParts.length === 0) return [];
  const drums = insertNamed(facts.project, 'Drums');
  const actions: OfflineAction[] = [
    {
      op: 'add_channel',
      ref: '@snarelayer',
      plugin: 'agstudio.sampler',
      name: CLAP_LAYER_NAME,
      sample: 'clap',
      volume_db: LAYER_VOLUME_DB,
      ...(drums ? { insert: drums.id } : {}),
    },
  ];
  for (const part of snareParts) {
    const notes = notesAsSteps(facts.project, part.pattern, part.channel).map((note) => ({
      step: note.step,
      len: note.len,
      vel: Math.round(note.vel * LAYER_VELOCITY_SHARE * 1000) / 1000,
    }));
    actions.push({ op: 'write_notes', pattern: part.pattern, channel: '@snarelayer', replace: false, notes });
  }
  return actions;
}

function hitHarder(context: RuleContext): RuleResult {
  const { facts, scope, amount } = context;
  // "Make the kick hit harder" is about the kick only; "hit harder" alone is about the kick and the snare.
  const asksKick = /\bkicks?\b/.test(context.clause);
  const asksSnare = /\bsnares?\b|\bclaps?\b/.test(context.clause);
  const kicks = asksSnare && !asksKick ? [] : channelsPlaying(facts, KICK_ROLES);
  const snares = asksKick && !asksSnare ? [] : channelsPlaying(facts, SNARE_ROLES);
  const channels = [...new Set([...kicks, ...snares])];
  const { parts, skipped } = patternParts(context, channels);
  if (parts.length === 0) {
    return { reply: `There is no kick or snare playing in ${scope.isNamed ? scope.label : 'this song'}, so there is nothing to hit harder.${skippedLine(skipped)}` };
  }
  const factor = byAmount(amount, [1.1, 1.22, 1.4]);
  const actions: OfflineAction[] = parts.map((part) => ({
    op: 'note_tool',
    tool: 'agstudio.notes.velocity-scale',
    pattern: part.pattern,
    channel: part.channel,
    params: [{ name: 'factor', value: factor }],
  }));
  const named = kicks.length > 0 && snares.length > 0 ? 'kick and snare' : kicks.length > 0 ? 'kick' : 'snare';
  const said = [`${named} velocities up ${Math.round((factor - 1) * 100)} %`];
  const layer = snareLayer(context, parts, snares);
  if (layer.length > 0) {
    actions.push(...layer);
    said.push('a clap layered on the snare');
  }
  if (!scope.isNamed) {
    const kickChannel = kicks[0] ? facts.project.channels[kicks[0]] : undefined;
    const kickOutput = kickChannel && kickChannel.kind !== 'automation' ? kickChannel.output : undefined;
    for (const extra of [kicks.length > 0 ? kickSaturation(context, kickOutput) : null, drumAttack(context)]) {
      if (!extra) continue;
      actions.push(extra.action);
      said.push(extra.line);
    }
  }
  const mixNote = scope.isNamed ? ' The effects on the mixer tracks are for the whole song: ask without a part for those.' : '';
  return { message: `Made the ${named} hit harder in ${scope.label}: ${said.join(', ')}.${mixNote}${skippedLine(skipped)}`, actions };
}

/** "Hit harder", "punchier kick", "bigger snare". */
export const HIT_RULES: readonly Rule[] = [{ id: 'hit-harder', matches: (text) => HIT_HARDER.test(text), run: hitHarder }];
