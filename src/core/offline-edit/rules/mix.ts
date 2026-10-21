/**
 * Mix tweaks in plain words: louder or quieter (by a bit, a lot, or "+3 dB"), more or less reverb and echo, wider or narrower,
 * mute, pan, and "mix it" / "level it". A part is a role bus when the song has one (Kick, Drums, Chords, Lead…), else its channels.
 * A named part gets a volume or send automation over just those bars; the other tweaks are for the whole song.
 */
import type { Role } from '../../arrange/roles';
import { MASTER, type ChannelId, type Insert } from '../../model/types';
import { gainToDb, insertNamed, oneDecimal, slotOf } from '../rule-kit';
import { describeRange } from '../song-facts';
import { BASS_ROLES, CHORD_ROLES, DRUM_ROLES, HAT_ROLES, KICK_ROLES, LEAD_ROLES, SNARE_ROLES, type SongFacts } from '../song-facts';
import { byAmount, decibelsIn } from '../words';
import type { BarRange, OfflineAction, Rule, RuleContext, RuleResult } from '../types';

/** What a part word means: the role buses it is, and the channel roles when the song has no such bus. */
interface PartWord {
  label: string;
  pattern: RegExp;
  buses: readonly string[];
  roles: ReadonlySet<Role>;
}

const PART_WORDS: readonly PartWord[] = [
  { label: 'kick', pattern: /\bkicks?\b/, buses: ['Kick'], roles: KICK_ROLES },
  { label: 'snare', pattern: /\bsnares?\b|\bclaps?\b/, buses: [], roles: SNARE_ROLES },
  { label: 'hats', pattern: /\b(?:hi-?hats?|hats?)\b/, buses: [], roles: HAT_ROLES },
  { label: 'drums', pattern: /\bdrums?\b|\bpercussion\b|\bperc\b/, buses: ['Drums', 'Kick'], roles: DRUM_ROLES },
  { label: 'bass', pattern: /\b808s?\b|\bbass\b|\bsub\b/, buses: ['808', 'Bass'], roles: BASS_ROLES },
  { label: 'chords', pattern: /\bchords?\b|\bpads?\b|\bkeys\b|\bpiano\b/, buses: ['Chords'], roles: CHORD_ROLES },
  { label: 'lead', pattern: /\blead\b|\bmelod(?:y|ies)\b|\bhook\b|\barps?\b/, buses: ['Lead'], roles: LEAD_ROLES },
  { label: 'vocals', pattern: /\bvocals?\b|\bvox\b|\bvoice\b/, buses: ['Vocals'], roles: new Set<Role>(['vox']) },
  { label: 'fx', pattern: /\bfx\b|\brisers?\b|\bsound effects?\b/, buses: ['FX'], roles: new Set<Role>(['fx']) },
];

/** The mixer tracks and channels a part word stands for in this song. */
interface Target {
  label: string;
  inserts: Insert[];
  channels: ChannelId[];
}

/** The part words the text uses (whether or not the song has such a part). */
function partsMentioned(text: string): string[] {
  return PART_WORDS.filter((word) => word.pattern.test(text)).map((word) => word.label);
}

/** The reply for a part the song does not have ("There is no vocals in this song"). */
function noSuchPart(labels: readonly string[]): string {
  return `The song has no ${labels.join(' or ')} to change: nothing plays that way (or it has no mixer track of its own yet: say "set up the mix").`;
}

function targetsIn(text: string, facts: SongFacts): Target[] {
  const found: Target[] = [];
  for (const word of PART_WORDS) {
    if (!word.pattern.test(text)) continue;
    const inserts = word.buses.map((name) => insertNamed(facts.project, name)).filter((insert): insert is Insert => !!insert);
    const channels = inserts.length > 0 ? [] : facts.project.channelOrder.filter((id) => word.roles.has(facts.roles.get(id) ?? 'other') && facts.project.channels[id]?.kind !== 'automation');
    if (inserts.length > 0 || channels.length > 0) found.push({ label: word.label, inserts, channels });
  }
  return found;
}

/** The melodic buses a request about "the reverb" or "wider" with no part named means. */
function melodicBuses(facts: SongFacts): Insert[] {
  return ['Lead', 'Chords', 'Vocals'].map((name) => insertNamed(facts.project, name)).filter((insert): insert is Insert => !!insert);
}

const LOUDER =
  /\b(?:louder|turn (?:[\w'-]+ ){0,3}up|boost|raise|bring (?:it |them )?up|bump|push|pump up|increase (?:the )?(?:volume|level)|more (?:volume|level|presence|punch)|up (?:by )?\d)\b|\bmore (?:kick|bass|808|lead|vocals?|vox|chords?|pads?|snare|claps?)\b/;
const QUIETER =
  /\b(?:quieter|softer|turn (?:[\w'-]+ ){0,3}down|lower|reduce|pull (?:it |them )?back|decrease (?:the )?(?:volume|level)|less (?:volume|level)|too loud|tame|duck)\b|\b(?:cut|drop) (?:the |some )?(?:kick|bass|808|lead|vocals?|vox|chords?|pads?|snare|drums|hats|fx)\b|\bless (?:kick|bass|808|lead|vocals?|vox|chords?|pads?|snare|claps?)\b/;
/** A part and a signed level with no direction word: "lead +3 dB", "drums -2 dB". */
const SIGNED_UP = /\+\s*\d+(?:\.\d+)?\s*(?:db|decibels?)/;
const SIGNED_DOWN = /-\s*\d+(?:\.\d+)?\s*(?:db|decibels?)/;
const MORE_REVERB =
  /\b(?:more (?:reverb|echo|delay|space)|add (?:some |a little )?(?:reverb|echo|delay)|reverb(?:ier|y)|wetter|spacier|more spacious|more ambient|more atmosphere|(?:reverb|echo|delay) on|put (?:some )?(?:reverb|echo|delay))\b/;
const LESS_REVERB =
  /\b(?:less (?:reverb|echo|delay|space)|drier|dryer|dry(?: it)?(?: up)?|too (?:wet|much reverb|much echo|reverb(?:y)?)|remove (?:the )?(?:reverb|echo|delay)|no (?:reverb|echo|delay)|tighten the space)\b/;
const WIDER = /\b(?:wider|widen|more (?:stereo|width)|stereo width|spread (?:it |them )?out|spacious stereo|narrower|narrow|go mono|make it mono|less stereo|mono)\b/;
const MUTE = /\b(?:mute|unmute|silence)\b/;
const PAN = /\bpan\b/;
const MIX_IT = /\b(?:set up the mix|setup the mix|mix (?:it|this|the (?:song|track))|balance (?:it|the (?:mix|song|track))|level (?:it|the (?:mix|song|track|levels))|auto[- ]?level|fix the (?:mix|levels|balance)|make it louder overall|louder overall)\b/;

/** Fader limits (dB): a mixer track goes to +5.6, a channel to +1.9. */
const MAX_INSERT_DB = 5.6;
const MAX_CHANNEL_DB = 1.9;
const MIN_FADER_DB = -60;

/** How far a request moves a level: the dB named, or a bit, a normal step, a lot. */
function levelStep(context: RuleContext): number {
  const named = decibelsIn(context.text);
  return named === null ? byAmount(context.amount, [1.5, 3, 6]) : Math.abs(named);
}

const clampDb = (value: number, max: number): number => Math.max(MIN_FADER_DB, Math.min(max, value));

/** The level change as a signed number of dB: "turn it up" is positive, "turn it down" negative, an explicit sign wins. */
function signedLevel(context: RuleContext, direction: 1 | -1): number {
  const named = decibelsIn(context.text);
  if (named !== null && /[+-]\s*\d/.test(context.text)) return named;
  return direction * levelStep(context);
}

/** How long before the end of a part an automated level starts to go back (bars): short, so the part keeps the change until its last beat. */
const RELEASE_BARS = 0.0625;
/** The level a send sits at when there is none (dB). */
const NO_SEND_DB = -60;

/** An automation clip that holds `changedDb` over the bars and puts the control back to `restoreDb` where they end. */
function automationOver(target: Record<string, unknown>, range: BarRange, changedDb: number, restoreDb: number): OfflineAction {
  const length = range.toBar - range.fromBar + 1;
  return {
    op: 'automate',
    target,
    from_bar: range.fromBar,
    bars: length,
    points: [
      { bar: 0, value: changedDb },
      { bar: length - RELEASE_BARS, value: changedDb },
      { bar: length, value: restoreDb },
    ],
  };
}

function changeLevel(context: RuleContext, direction: 1 | -1): RuleResult {
  const { facts, text, scope } = context;
  const targets = targetsIn(text, facts);
  if (targets.length === 0 && partsMentioned(text).length > 0) return { reply: noSuchPart(partsMentioned(text)) };
  const delta = signedLevel(context, direction);
  if (targets.length === 0 && scope.isNamed) return { reply: `Say which part to turn ${direction === 1 ? 'up' : 'down'} in ${scope.label}, for example "turn the lead ${direction === 1 ? 'up' : 'down'} 3 dB in ${scope.ranges.length === 1 ? describeRange(scope.ranges[0] as BarRange) : 'the chorus'}".` };
  if (targets.length === 0) {
    if (direction === 1) return { message: 'Leveled the mix to the style’s loudness (louder or quieter parts are named: "turn the lead up 3 dB").', actions: [{ op: 'level_mix' }] };
    const master = facts.project.mixer.inserts[MASTER];
    if (!master) return { reply: 'Say which part to turn down ("turn the lead down", "quieter drums").' };
    const next = clampDb(gainToDb(master.volume) + delta, MAX_INSERT_DB);
    return { message: `Turned the whole mix down ${oneDecimal(Math.abs(delta))} dB (master fader ${oneDecimal(next)} dB).`, actions: [{ op: 'edit_insert', insert: MASTER, volume_db: next }] };
  }
  const actions: OfflineAction[] = [];
  const lines: string[] = [];
  const change = (target: Record<string, unknown>, whole: OfflineAction, nowDb: number, nextDb: number) => {
    if (scope.isNamed) for (const range of scope.ranges) actions.push(automationOver(target, range, nextDb, nowDb));
    else actions.push(whole);
  };
  for (const target of targets) {
    for (const insert of target.inserts) {
      const nowDb = gainToDb(insert.volume);
      const next = clampDb(nowDb + delta, MAX_INSERT_DB);
      change({ kind: 'track_volume', insert: insert.id }, { op: 'edit_insert', insert: insert.id, volume_db: next }, nowDb, next);
      lines.push(`${insert.name} ${oneDecimal(next)} dB`);
    }
    for (const id of target.channels) {
      const channel = facts.project.channels[id];
      if (!channel || channel.kind === 'automation') continue;
      const nowDb = gainToDb(channel.volume);
      const next = clampDb(nowDb + delta, MAX_CHANNEL_DB);
      change({ kind: 'channel_volume', channel: id }, { op: 'edit_channel', channel: id, volume_db: next }, nowDb, next);
      lines.push(`${channel.name} ${oneDecimal(next)} dB`);
    }
  }
  const word = delta >= 0 ? 'up' : 'down';
  const where = scope.isNamed ? ` in ${scope.label} (the level goes back after it)` : '';
  return { message: `Turned ${targets.map((target) => target.label).join(' and ')} ${word} ${oneDecimal(Math.abs(delta))} dB${where}: ${lines.join(', ')}.`, actions };
}

/** "More reverb": a send to the Reverb return (or an effect on the track when the song has no return). */
function changeSpace(context: RuleContext, direction: 1 | -1): RuleResult {
  const { facts, text, scope } = context;
  const isDelay = /\b(?:echo|delay)\b/.test(text);
  const returnName = isDelay ? 'Delay' : 'Reverb';
  const named = targetsIn(text, facts);
  const targets = named.flatMap((target) => target.inserts);
  if (named.length === 0 && partsMentioned(text).length > 0) return { reply: noSuchPart(partsMentioned(text)) };
  if (named.length > 0 && targets.length === 0) {
    return { reply: `${named.map((target) => target.label).join(' and ')} ${named.length === 1 ? 'has' : 'have'} no mixer track of ${named.length === 1 ? 'its' : 'their'} own to send to the ${returnName.toLowerCase()}: say "set up the mix" first, and the parts get buses.` };
  }
  const inserts = targets.length > 0 ? targets : melodicBuses(facts);
  if (inserts.length === 0) return { reply: `There is no mixer track to put ${returnName.toLowerCase()} on yet: say "set up the mix" first, or name a part ("more reverb on the lead").` };
  const reverbReturn = insertNamed(facts.project, returnName);
  const actions: OfflineAction[] = [];
  const lines: string[] = [];
  const base = byAmount(context.amount, [-14, -10, -6]);
  const step = byAmount(context.amount, [2, 3, 5]);
  for (const insert of inserts) {
    if (reverbReturn && insert.id !== reverbReturn.id) {
      const route = insert.routes.find((candidate) => candidate.to === reverbReturn.id);
      const current = route ? gainToDb(route.level) : null;
      const next = direction === 1 ? (current === null ? base : Math.min(0, current + step)) : (current === null ? null : current - step * 1.5);
      if (next === null) continue;
      if (scope.isNamed) {
        // A part of the song: the send goes up (or down) over its bars and back after them.
        if (!route) actions.push({ op: 'route', from: insert.id, to: reverbReturn.id, level_db: NO_SEND_DB });
        const target = { kind: 'send', insert: insert.id, to: reverbReturn.id };
        for (const range of scope.ranges) actions.push(automationOver(target, range, next, current ?? NO_SEND_DB));
        lines.push(`${insert.name} → ${returnName} ${oneDecimal(next)} dB`);
      } else if (direction === -1 && (next < -30 || context.amount === 'large')) {
        actions.push({ op: 'unroute', from: insert.id, to: reverbReturn.id });
        lines.push(`${insert.name} no longer sends to ${returnName}`);
      } else {
        actions.push({ op: 'route', from: insert.id, to: reverbReturn.id, level_db: next });
        lines.push(`${insert.name} → ${returnName} ${oneDecimal(next)} dB`);
      }
      continue;
    }
    if (scope.isNamed || direction === -1) continue;
    const plugin = isDelay ? 'agstudio.delay' : 'agstudio.reverb';
    const existing = slotOf(insert, plugin);
    const mix = byAmount(context.amount, [0.12, 0.22, 0.38]);
    if (existing) actions.push({ op: 'edit_effect', effect: existing.id, mix: Math.min(1, existing.mix + mix / 2) });
    else actions.push({ op: 'add_effect', insert: insert.id, plugin, mix });
    lines.push(`${insert.name} ${isDelay ? 'echo' : 'reverb'} ${Math.round(mix * 100)} %`);
  }
  if (actions.length === 0) return { reply: direction === 1 ? `Nothing to add ${returnName.toLowerCase()} to here.` : `There is no ${returnName.toLowerCase()} on those parts to take away.` };
  const word = direction === 1 ? 'More' : 'Less';
  const where = scope.isNamed ? ` in ${scope.label}` : '';
  return { message: `${word} ${isDelay ? 'echo' : 'reverb'}${where}: ${lines.join(', ')}.`, actions };
}

/** Wider or narrower: the Stereo effect's width on the parts named (the lead and chords buses when none is). */
function changeWidth(context: RuleContext): RuleResult {
  const { facts, text, scope } = context;
  if (scope.isNamed) return { reply: 'Stereo width is for the whole song: ask without naming a part.' };
  const narrower = /\bnarrow|\bmono\b|\bless stereo\b/.test(text);
  const parts = targetsIn(text, facts);
  if (parts.length === 0 && partsMentioned(text).length > 0) return { reply: noSuchPart(partsMentioned(text)) };
  const named = parts.flatMap((target) => target.inserts);
  if (parts.length > 0 && named.length === 0) return { reply: 'That part has no mixer track of its own to widen: say "set up the mix" first, and the parts get buses.' };
  const master = /\b(?:master|whole mix|everything|the mix)\b/.test(text) ? [facts.project.mixer.inserts[MASTER]].filter((insert): insert is Insert => !!insert) : [];
  const inserts = named.length > 0 ? named : master.length > 0 ? master : melodicBuses(facts).filter((insert) => insert.name !== 'Vocals');
  if (inserts.length === 0) return { reply: 'There is no mixer track to widen: say "set up the mix" first, or name a part ("wider pads").' };
  const width = /\bmono\b/.test(text) ? 0 : narrower ? byAmount(context.amount, [0.8, 0.6, 0.3]) : byAmount(context.amount, [1.25, 1.5, 1.8]);
  const actions: OfflineAction[] = inserts.map((insert) => {
    const existing = slotOf(insert, 'agstudio.stereo');
    return existing
      ? { op: 'edit_effect', effect: existing.id, params: [{ name: 'width', value: width }] }
      : { op: 'add_effect', insert: insert.id, plugin: 'agstudio.stereo', params: [{ name: 'width', value: width }] };
  });
  return { message: `Set the stereo width of ${inserts.map((insert) => insert.name).join(' and ')} to ${Math.round(width * 100)} %.`, actions };
}

/** The words `vary without` knows for the parts a part word can mean. */
const WITHOUT_NAMES: Readonly<Record<string, string>> = { kick: 'kick', snare: 'snare', hats: 'hats', drums: 'drums', bass: 'bass', chords: 'chords', lead: 'lead' };

function muteParts(context: RuleContext): RuleResult {
  const { facts, text, scope } = context;
  const targets = targetsIn(text, facts);
  if (targets.length === 0) return { reply: 'Say which part to mute ("mute the hats").' };
  const isMuting = !/\bunmute\b/.test(text);
  if (scope.isNamed) {
    // A channel is muted for the whole song, so a part of the song takes the notes out of its bars instead.
    const names = targets.map((target) => WITHOUT_NAMES[target.label]).filter((name): name is string => name !== undefined);
    if (!isMuting || names.length === 0) return { reply: 'In a part of the song I can leave the kick, snare, hats, drums, bass, chords or lead out of its bars. Muting the others, and unmuting, is for the whole song.' };
    const actions: OfflineAction[] = scope.ranges.map((range) => ({ op: 'vary', kind: 'without', from_bar: range.fromBar, to_bar: range.toBar, channels: names }));
    return { message: `Left ${names.join(' and ')} out of ${scope.label}.`, actions };
  }
  const actions: OfflineAction[] = [];
  const names: string[] = [];
  for (const target of targets) {
    const channels = target.channels.length > 0 ? target.channels : [];
    for (const id of channels) {
      actions.push({ op: 'edit_channel', channel: id, mute: isMuting });
      names.push(facts.project.channels[id]?.name ?? '?');
    }
    if (channels.length === 0) {
      for (const insert of target.inserts) {
        actions.push({ op: 'edit_insert', insert: insert.id, mute: isMuting });
        names.push(insert.name);
      }
    }
  }
  return { message: `${isMuting ? 'Muted' : 'Unmuted'} ${names.join(', ')}.`, actions };
}

function panParts(context: RuleContext): RuleResult {
  const { facts, text } = context;
  const targets = targetsIn(text, facts);
  if (targets.length === 0) return { reply: 'Say which part to pan ("pan the pad left").' };
  const amount = byAmount(context.amount, [0.3, 0.5, 1]);
  const pan = /\bcent(?:er|re)\b/.test(text) ? 0 : /\bleft\b/.test(text) ? -amount : /\bright\b/.test(text) ? amount : null;
  if (pan === null) return { reply: 'Say which way: "pan the pad left", "pan the lead right" or "pan the lead to the center".' };
  const actions: OfflineAction[] = [];
  const names: string[] = [];
  for (const target of targets) {
    for (const id of target.channels) {
      actions.push({ op: 'edit_channel', channel: id, pan });
      names.push(facts.project.channels[id]?.name ?? '?');
    }
    for (const insert of target.inserts) {
      actions.push({ op: 'edit_insert', insert: insert.id, pan });
      names.push(insert.name);
    }
  }
  return { message: `Panned ${names.join(', ')} ${pan === 0 ? 'to the center' : `${pan < 0 ? 'left' : 'right'} (${Math.round(Math.abs(pan) * 100)} %)`}.`, actions };
}

function mixIt(): RuleResult {
  return {
    message: 'Set up the mix by role (buses, returns, a limiter on the master) where it is missing, and leveled it to the style’s loudness.',
    actions: [{ op: 'setup_mix', mode: 'fill-gaps' }, { op: 'level_mix' }],
  };
}

/** Mix tweaks, most specific first. */
export const MIX_RULES: readonly Rule[] = [
  { id: 'mix-it', matches: (text) => MIX_IT.test(text), run: mixIt },
  { id: 'less-reverb', matches: (text) => LESS_REVERB.test(text), run: (context) => changeSpace(context, -1) },
  { id: 'more-reverb', matches: (text) => MORE_REVERB.test(text), run: (context) => changeSpace(context, 1) },
  { id: 'wider', matches: (text) => WIDER.test(text), run: changeWidth },
  { id: 'mute', matches: (text) => MUTE.test(text), run: muteParts },
  { id: 'pan', matches: (text) => PAN.test(text), run: panParts },
  { id: 'quieter', matches: (text) => QUIETER.test(text) || SIGNED_DOWN.test(text), run: (context) => changeLevel(context, -1) },
  { id: 'louder', matches: (text) => LOUDER.test(text) || SIGNED_UP.test(text), run: (context) => changeLevel(context, 1) },
];
