/**
 * Hercules DJControl Inpulse 200 and 300.
 *
 * MIDI values read from the Mixxx project's public controller mappings (GPL; author DJ Phatso for
 * Hercules Technical Support): res/controllers/Hercules_DJControl_Inpulse_200.midi.xml and
 * Hercules_DJControl_Inpulse_300.midi.xml with their -script.js files
 * (https://github.com/mixxxdj/mixxx). Only addresses and encodings are taken; the code is our own.
 *
 * Layout: deck A = MIDI channel 2, deck B = channel 3 (0-based 1 and 2) for buttons and knobs; with
 * Shift held the deck's jog wheel sends on channels 5 and 6 (0-based 4 and 5); the pads send on
 * channels 7 and 8 (0-based 6 and 7), the shifted pads (clear) on the notes 8 higher. The jog wheel and
 * the browse knob send 1 (right) or 127 (left). The pitch fader is a 14-bit pair on CC 8 and CC 40
 * and sends higher values the slower the song should play.
 */
import type { Binding, LedBinding } from '../types';
import { bind, cc, cc14, ledNote, mappingOf, note, rel, type ControllerPreset } from './build';

const DECKS = {
  A: { ch: 1, shift: 4, pad: 6 },
  B: { ch: 2, shift: 5, pad: 7 },
} as const;

function inpulse(name: string, preset: string, opts: { pads: number; threeBandEq: boolean; jogPlatterOnly: boolean }) {
  const bindings: Binding[] = [];
  const leds: LedBinding[] = [];
  for (const d of ['A', 'B'] as const) {
    const { ch, shift, pad } = DECKS[d];
    const t = (fn: string) => `${d}.${fn}`;
    bindings.push(
      bind(note(ch, 0x07), t('play')),
      bind(note(ch, 0x06), t('cue')),
      bind(note(ch, 0x05), t('sync')),
      bind(note(ch, 0x0c), t('pfl')),
      bind(note(ch, 0x0d), t('load')),
      bind(note(ch, 0x08), t('jogTouch')),
      // Loop buttons: "loop in" makes a 4-beat loop, "loop out" leaves it; Shift halves and doubles it.
      bind(note(ch, 0x09), t('autoLoop:4')),
      bind(note(ch, 0x0a), t('loopExit')),
      bind(note(shift, 0x09), t('loopHalve')),
      bind(note(shift, 0x0a), t('loopDouble')),
      bind(cc(ch, 0x00), t('volume')),
      bind(cc(ch, 0x02), t('eq.low')),
      bind(cc(ch, 0x04), t('eq.high')),
      bind(cc(ch, 0x05), t('trim')),
      bind(cc(ch, 0x01), t('filter')),
      bind(cc14(ch, 0x08), t('pitch'), { invert: true }),
      // Jog: the top of the platter scratches while touched; Shift + jog searches.
      bind(rel(ch, 0x0a, 'twos'), t('jog')),
      bind(rel(ch, 0x09, 'twos'), opts.jogPlatterOnly ? t('jogNudge') : t('jog')),
      bind(rel(shift, 0x0a, 'twos'), t('search')),
    );
    if (opts.threeBandEq) bindings.push(bind(cc(ch, 0x03), t('eq.mid')));
    for (let i = 0; i < opts.pads; i++) {
      bindings.push(bind(note(pad, i), t(`hotcue:${i + 1}`)), bind(note(pad, 8 + i), t(`hotcueClear:${i + 1}`)));
      leds.push(ledNote(t(`hotcue:${i + 1}`), pad, i, 0x7e));
    }
    leds.push(
      ledNote(t('play'), ch, 0x07),
      ledNote(t('cue'), ch, 0x06),
      ledNote(t('sync'), ch, 0x05),
      ledNote(t('pfl'), ch, 0x0c),
      ledNote(t('autoLoop:4'), ch, 0x09),
    );
  }
  bindings.push(bind(cc(0, 0x00), 'crossfader'), bind(rel(0, 0x01, 'twos'), 'browse'));
  return mappingOf(name, preset, bindings, leds);
}

export const INPULSE_300: ControllerPreset = {
  id: 'hercules-inpulse-300',
  name: 'Hercules DJControl Inpulse 300',
  match: ['inpulse300', 'djci300'],
  source: 'Mixxx: Hercules_DJControl_Inpulse_300.midi.xml and Hercules-DJControl-Inpulse-300-script.js (GPL; author DJ Phatso)',
  notes: 'Not mapped: the FX section, the other pad modes (rolls, slicer, sampler, tone play, beat jump), slip, quantize, vinyl button.',
  mapping: () => inpulse('Hercules DJControl Inpulse 300', 'hercules-inpulse-300', { pads: 8, threeBandEq: true, jogPlatterOnly: false }),
};

export const INPULSE_200: ControllerPreset = {
  id: 'hercules-inpulse-200',
  name: 'Hercules DJControl Inpulse 200',
  match: ['inpulse200', 'djci200'],
  source: 'Mixxx: Hercules_DJControl_Inpulse_200.midi.xml and Hercules-DJControl-Inpulse-200-script.js (GPL; author DJ Phatso)',
  notes: 'Not mapped: the FX section, sampler and roll pads, vinyl button. This model has 4 hot cue pads and a two-band EQ.',
  mapping: () => inpulse('Hercules DJControl Inpulse 200', 'hercules-inpulse-200', { pads: 4, threeBandEq: false, jogPlatterOnly: true }),
};

export const HERCULES_PRESETS: readonly ControllerPreset[] = [INPULSE_300, INPULSE_200];
