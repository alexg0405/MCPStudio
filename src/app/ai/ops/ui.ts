/** Actions the UI runs after the edit: playback, auditions, mix analysis, the plugin builder, commands, windows. */
import type { ChannelId, InsertId, SlotId } from '@core/model/types';
import { ticksPerBar } from '@core/time/ppq';
import type { Services } from '../../services';
import type { AiAnswer } from '../schema';
import * as S from '../schema/parts';
import type { AnswerState, OpModule } from './context';
import { lower, num, str } from './values';
import { applyWindowAction, isOpenWindow, OPEN_WINDOWS, WINDOW_ACTIONS } from './windows';

export const ui: OpModule = {
  schemas: [
    S.op('transport', 'Playback and recording, applied after the edits.', {
      action: {
        type: 'string',
        enum: ['play', 'stop', 'record'],
        description: 'record = arm recording and play (live MIDI/typing-keyboard notes go into the current pattern).',
      },
      mode: { type: 'string', enum: ['pattern', 'song'], description: 'Switch pattern/song mode first.' },
      from_bar: S.int('1-based bar to play from (song mode).'),
      metronome: S.bool('Turn the metronome on or off.'),
    }),
    S.op(
      'audition',
      'Plays a short phrase on a channel right after the edits, without writing notes, so the musician hears a sound you made or changed: chord (pads, keys), riff (leads, plucks), bass (808s, basses, low notes) or hits (drums: a short pattern on the key it plays). Skip it while the song is playing.',
      {
        channel: S.CHANNEL,
        phrase: { type: 'string', enum: ['chord', 'riff', 'bass', 'hits'] },
      },
      ['channel'],
    ),
    S.op(
      'analyze_mix',
      'Listens to the mix before you change it: renders the mix and every mixer track and sends you their loudness (LUFS), peaks, true peak, crest, tone per band, stereo width and findings; then you get the request again with the analysis. Use it alone (with a short message such as "Listening to your mix…") when asked to mix, master, balance, fix or judge how the song sounds and you have no analysis of the current mix yet.',
      {},
    ),
    S.op(
      'build_plugin',
      'Writes a brand-new instrument or effect plugin from a description (the plugin builder): it is coded, checked and test-rendered for you, then the musician installs it with one click. Use it when they ask for a new plugin, or for a sound or effect no plugin in the catalog can make.',
      {
        name: S.str('The plugin’s name, e.g. "Tape Stop".'),
        kind: { type: 'string', enum: ['instrument', 'effect'] },
        description: S.str(
          'Everything it should do, specifically: the sound or processing, the controls it needs (with ranges and units), presets, how it reacts to notes or audio.',
        ),
      },
      ['name', 'kind', 'description'],
    ),
    S.op(
      'command',
      'Runs any app command from the <commands> list, after the edits: save, save as, open, export, undo or redo, show windows, layouts, metronome, the tour… Commands that open a file dialog ask the musician to confirm with one click.',
      {
        id: S.str('Command id from <commands>, e.g. "file.save".'),
        args: S.VALUE('Only for commands that list args.'),
      },
      ['id'],
    ),
    S.op(
      'open',
      'Shows, hides, focuses or maximizes a window (or the browser panel), applied after the edits. A plugin window needs its channel or effect.',
      {
        window: { type: 'string', enum: [...OPEN_WINDOWS] },
        action: { type: 'string', enum: [...WINDOW_ACTIONS], description: 'Default open.' },
        channel: S.CHANNEL,
        effect: S.EFFECT,
      },
    ),
  ],
  handlers: {},
};

/** Turns the answer's UI actions into after-edit requests (after its edits are committed). */
export function uiAfter(services: Services, answer: AiAnswer, state: AnswerState): void {
  const { refs, warnings, after } = state;
  for (const action of answer.actions) {
    if (action.op === 'transport') {
      const mode = action.mode === 'pattern' || action.mode === 'song' ? action.mode : undefined;
      if (typeof action.metronome === 'boolean') after.push({ kind: 'metronome', on: action.metronome });
      if (action.action === 'stop') after.push({ kind: 'stop' });
      else if (action.action === 'play' || action.action === 'record') {
        const fromBar = num(action.from_bar);
        const tick =
          fromBar !== undefined
            ? Math.max(0, (fromBar - 1) * ticksPerBar(services.doc.getState().project.transport.timeSig))
            : undefined;
        after.push({
          kind: 'play',
          ...(tick !== undefined ? { fromTick: tick } : {}),
          ...(mode ? { mode } : {}),
          ...(action.action === 'record' ? { record: true } : {}),
        });
      } else if (mode) after.push({ kind: 'mode', mode });
    } else if (action.op === 'audition') {
      const project = services.doc.getState().project;
      const chRef = str(action.channel) ?? '';
      const r = refs.get(lower(chRef.startsWith('@') ? chRef : `@${chRef}`));
      const channelId =
        r?.kind === 'channel'
          ? r.id
          : Object.values(project.channels).find((c) => c.id === chRef || lower(c.name) === lower(chRef))?.id;
      const phrase = action.phrase === 'riff' || action.phrase === 'bass' || action.phrase === 'hits' ? action.phrase : 'chord';
      if (!channelId || project.channels[channelId]?.kind === 'automation') warnings.push(`audition: there is no channel "${chRef}"`);
      else if (!after.some((x) => x.kind === 'audition')) after.push({ kind: 'audition', channelId, phrase });
    } else if (action.op === 'analyze_mix') {
      if (!after.some((x) => x.kind === 'analyze_mix')) after.push({ kind: 'analyze_mix' });
    } else if (action.op === 'build_plugin') {
      const name = str(action.name);
      const kind = action.kind === 'instrument' || action.kind === 'effect' ? action.kind : null;
      if (!name || !kind) warnings.push('build plugin: it needs a name and a kind (instrument or effect)');
      else after.push({ kind: 'build_plugin', spec: { name, kind, description: str(action.description) ?? name } });
    } else if (action.op === 'command') {
      const id = str(action.id) ?? '';
      const def = services.commands.get(id);
      if (!def || def.ai === false) warnings.push(`command: there is no command "${id}"`);
      else
        after.push({
          kind: 'command',
          id,
          ...(action.args !== undefined && action.args !== null ? { args: action.args } : {}),
          gesture: !!def.gesture,
        });
    } else if (action.op === 'open') {
      const w = action.window;
      const subAction = WINDOW_ACTIONS.find((x) => x === action.action) ?? 'open';
      if (!isOpenWindow(w)) {
        warnings.push(`open: there is no window "${String(w)}" (windows: ${OPEN_WINDOWS.join(', ')})`);
        continue;
      }
      const project = services.doc.getState().project;
      const chRef = str(action.channel);
      const channelId = chRef
        ? (Object.values(project.channels).find((c) => c.id === chRef || lower(c.name) === lower(chRef))?.id ??
          (refs.get(lower(chRef))?.kind === 'channel' ? (refs.get(lower(chRef)) as { id: ChannelId }).id : undefined))
        : undefined;
      const fxRef = str(action.effect);
      const fx = fxRef ? refs.get(lower(fxRef)) : undefined;
      let slot: { insertId: InsertId; slotId: SlotId } | undefined =
        fx?.kind === 'effect' ? { insertId: fx.insertId, slotId: fx.slotId } : undefined;
      if (!slot && fxRef)
        for (const id of project.mixer.order)
          if (project.mixer.inserts[id]?.fx.some((f) => f.id === fxRef)) slot = { insertId: id, slotId: fxRef as SlotId };
      if (w === 'plugin' && !channelId && !slot) {
        warnings.push('open: a plugin window needs its channel or effect');
        continue;
      }
      if (w === 'browser' || subAction !== 'open') {
        const done = applyWindowAction(services, subAction === 'open' ? 'focus' : subAction, w, {
          ...(channelId ? { channelId } : {}),
          ...(slot ? { slotId: slot.slotId } : {}),
        });
        if (done) state.ui.push(done);
        else warnings.push(`open: the ${w} window isn't open`);
      } else
        after.push({
          kind: 'open',
          window: w,
          ...(channelId ? { channelId } : {}),
          ...(slot ? { insertId: slot.insertId, slotId: slot.slotId } : {}),
        });
    }
  }
}
