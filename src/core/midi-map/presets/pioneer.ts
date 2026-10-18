/**
 * Pioneer DDJ-400, DDJ-FLX4 and DDJ-200.
 *
 * The MIDI values below were read from the Mixxx project's public controller mappings (GPL, by Warker,
 * nschloe, dj3730, jusko, tiesjan for the DDJ-400; Robert904 for the DDJ-FLX4; Dan Giddins and
 * Frank Breitling for the DDJ-200): res/controllers/Pioneer-DDJ-400.midi.xml and -script.js,
 * Pioneer-DDJ-FLX4.midi.xml, "Pioneer DDJ-200.midi.xml" and Pioneer-DDJ-200-scripts.js
 * (https://github.com/mixxxdj/mixxx). Only the addresses and encodings are taken; the code is our own.
 *
 * Layout: deck 1 = MIDI channel 1, deck 2 = channel 2 (0-based 0 and 1); the performance pads of the
 * decks send on channels 8 and 10 (0-based 7 and 9) and, with Shift held, on 9 and 11; the browse
 * encoder, load buttons, crossfader and filter knobs use channel 7 (0-based 6). Faders and most knobs
 * are 14-bit pairs (coarse CC n, fine CC n + 32); the jog wheel is centred on 64; the browse encoder is
 * two's complement.
 */
import { AUTO_LOOP_BEATS } from '../targets';
import type { Binding, ControllerMapping, LedBinding } from '../types';
import { bind, cc, cc14, ledNote, mappingOf, note, rel, type ControllerPreset } from './build';

const DECK_CH: Record<'A' | 'B', { ch: number; pad: number; padShift: number; load: number; filter: number }> = {
  A: { ch: 0, pad: 7, padShift: 8, load: 0x46, filter: 0x17 },
  B: { ch: 1, pad: 9, padShift: 10, load: 0x47, filter: 0x18 },
};
const MIXER_CH = 6;

/** The DDJ-400 and DDJ-FLX4 share one layout (the FLX4 map is the DDJ-400's with more modes). */
function ddj4xx(name: string, preset: string): ControllerMapping {
  const bindings: Binding[] = [];
  const leds: LedBinding[] = [];
  for (const d of ['A', 'B'] as const) {
    const { ch, pad, padShift, load, filter } = DECK_CH[d];
    const t = (fn: string) => `${d}.${fn}`;
    bindings.push(
      bind(note(ch, 0x0b), t('play')),
      bind(note(ch, 0x0c), t('cue')),
      bind(note(ch, 0x58), t('sync')),
      bind(note(ch, 0x54), t('pfl')),
      bind(note(ch, 0x10), t('loopIn')),
      bind(note(ch, 0x11), t('loopOut')),
      bind(note(ch, 0x4d), t('loopExit')),
      bind(note(ch, 0x51), t('loopHalve')),
      bind(note(ch, 0x53), t('loopDouble')),
      bind(note(ch, 0x36), t('jogTouch')),
      bind(note(MIXER_CH, load), t('load')),
      // Jog: the side of the wheel and "vinyl off" nudge; the platter with vinyl mode on scratches while touched; Shift + jog searches.
      bind(rel(ch, 0x21, 'offset64'), t('jogNudge')),
      bind(rel(ch, 0x22, 'offset64'), t('jog')),
      bind(rel(ch, 0x23, 'offset64'), t('jogNudge')),
      bind(rel(ch, 0x29, 'offset64'), t('search')),
      bind(cc14(ch, 0x00), t('pitch')),
      bind(cc14(ch, 0x13), t('volume')),
      bind(cc14(ch, 0x04), t('trim')),
      bind(cc14(ch, 0x07), t('eq.high')),
      bind(cc14(ch, 0x0b), t('eq.mid')),
      bind(cc14(ch, 0x0f), t('eq.low')),
      bind(cc14(MIXER_CH, filter), t('filter')),
    );
    for (let i = 0; i < 8; i++) {
      bindings.push(bind(note(pad, i), t(`hotcue:${i + 1}`)), bind(note(padShift, i), t(`hotcueClear:${i + 1}`)));
      leds.push(ledNote(t(`hotcue:${i + 1}`), pad, i));
    }
    // Beat-loop pad mode: 1, 2, 4, 8, 16 and 32 beats (the 1/4 and 1/2 beat pads have no target).
    AUTO_LOOP_BEATS.forEach((beats, i) => {
      bindings.push(bind(note(pad, 0x62 + i), t(`autoLoop:${beats}`)));
      leds.push(ledNote(t(`autoLoop:${beats}`), pad, 0x62 + i));
    });
    leds.push(ledNote(t('play'), ch, 0x0b), ledNote(t('cue'), ch, 0x0c), ledNote(t('sync'), ch, 0x58), ledNote(t('pfl'), ch, 0x54));
  }
  bindings.push(bind(cc14(MIXER_CH, 0x1f), 'crossfader'), bind(rel(MIXER_CH, 0x40, 'twos'), 'browse'));
  return mappingOf(name, preset, bindings, leds);
}

/** The map for the Pioneer DDJ-400. */
export const DDJ_400: ControllerPreset = {
  id: 'pioneer-ddj-400',
  name: 'Pioneer DDJ-400',
  match: ['ddj400'],
  source: 'Mixxx: res/controllers/Pioneer-DDJ-400.midi.xml and Pioneer-DDJ-400-script.js (GPL; authors Warker, nschloe, dj3730, jusko, tiesjan)',
  notes: 'Not mapped: headphone mix and level, the Beat FX section, sampler pads, the 1/4 and 1/2 beat loop pads, key lock, Shift pad modes.',
  mapping: () => ddj4xx('Pioneer DDJ-400', 'pioneer-ddj-400'),
};

/** The map for the Pioneer DDJ-FLX4. */
export const DDJ_FLX4: ControllerPreset = {
  id: 'pioneer-ddj-flx4',
  name: 'Pioneer DDJ-FLX4',
  match: ['ddjflx4'],
  source: 'Mixxx: res/controllers/Pioneer-DDJ-FLX4.midi.xml (GPL; author Robert904)',
  notes: 'Not mapped: headphone mix, the Beat FX section, stem and sampler pads, the 1/4 and 1/2 beat loop pads, key lock.',
  mapping: () => ddj4xx('Pioneer DDJ-FLX4', 'pioneer-ddj-flx4'),
};

/** The DDJ-200: no trim knob, loops or load buttons; EQ and filter send 7-bit CCs. It has no LEDs we can drive. */
export const DDJ_200: ControllerPreset = {
  id: 'pioneer-ddj-200',
  name: 'Pioneer DDJ-200',
  match: ['ddj200'],
  source: 'Mixxx: "res/controllers/Pioneer DDJ-200.midi.xml" and Pioneer-DDJ-200-scripts.js (GPL; authors Dan Giddins, Frank Breitling)',
  notes: 'Not mapped: headphone mix, BPM tap, four-deck mode. Mixxx sends no LED messages for this controller, so neither do we.',
  mapping: () => {
    const bindings: Binding[] = [];
    for (const d of ['A', 'B'] as const) {
      const { ch, pad, padShift, filter } = DECK_CH[d];
      const t = (fn: string) => `${d}.${fn}`;
      bindings.push(
        bind(note(ch, 0x0b), t('play')),
        bind(note(ch, 0x0c), t('cue')),
        bind(note(ch, 0x58), t('sync')),
        bind(note(ch, 0x54), t('pfl')),
        bind(note(ch, 0x36), t('jogTouch')),
        bind(rel(ch, 0x21, 'offset64'), t('jogNudge')),
        bind(rel(ch, 0x22, 'offset64'), t('jog')),
        bind(rel(ch, 0x29, 'offset64'), t('search')),
        bind(cc14(ch, 0x00), t('pitch')),
        bind(cc14(ch, 0x13), t('volume')),
        bind(cc(ch, 0x07), t('eq.high')),
        bind(cc(ch, 0x0b), t('eq.mid')),
        bind(cc(ch, 0x0f), t('eq.low')),
        bind(cc(MIXER_CH, filter), t('filter')),
      );
      for (let i = 0; i < 8; i++) bindings.push(bind(note(pad, i), t(`hotcue:${i + 1}`)), bind(note(padShift, i), t(`hotcueClear:${i + 1}`)));
    }
    bindings.push(bind(cc14(MIXER_CH, 0x1f), 'crossfader'));
    return mappingOf('Pioneer DDJ-200', 'pioneer-ddj-200', bindings, []);
  },
};

/** The Pioneer maps. */
export const PIONEER_PRESETS: readonly ControllerPreset[] = [DDJ_FLX4, DDJ_400, DDJ_200];
