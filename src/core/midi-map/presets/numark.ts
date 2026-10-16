/**
 * Numark Mixtrack Pro FX.
 *
 * MIDI values read from the Mixxx project's public controller mapping (GPL; authors h67ma, bad1dea5,
 * photoenix): "res/controllers/Numark Mixtrack Pro FX.midi.xml" and Numark-Mixtrack-Pro-FX-scripts.js
 * (https://github.com/mixxxdj/mixxx). Only addresses and encodings are taken; the code is our own.
 *
 * Layout: deck 1 = MIDI channel 1, deck 2 = channel 2 (0-based 0 and 1); the crossfader, browse knob
 * and load buttons use channel 16 (0-based 15). The jog wheel and browse knob are two's complement; the
 * pitch fader is a 14-bit pair (CC 9 and CC 41) that sends higher values the faster the song should
 * play; the LEDs light with 127 and go dark with 1.
 */
import type { Binding, LedBinding } from '../types';
import { bind, cc, cc14, ledNote, mappingOf, note, rel, type ControllerPreset } from './build';

const LED_OFF = 0x01;

export const MIXTRACK_PRO_FX: ControllerPreset = {
  id: 'numark-mixtrack-pro-fx',
  name: 'Numark Mixtrack Pro FX',
  match: ['mixtrackprofx'],
  source: 'Mixxx: "Numark Mixtrack Pro FX.midi.xml" and Numark-Mixtrack-Pro-FX-scripts.js (GPL; authors h67ma, bad1dea5, photoenix)',
  notes:
    'Not mapped: the performance pads and their modes, the loop buttons, FX section, pitch bend buttons, Shift layer. Mixxx also sends a SysEx start-up message that the demo light show needs to stop; AGstudio does not use SysEx.',
  mapping: () => {
    const bindings: Binding[] = [];
    const leds: LedBinding[] = [];
    for (const d of ['A', 'B'] as const) {
      const ch = d === 'A' ? 0 : 1;
      const t = (fn: string) => `${d}.${fn}`;
      bindings.push(
        bind(note(ch, 0x00), t('play')),
        bind(note(ch, 0x01), t('cue')),
        bind(note(ch, 0x02), t('sync')),
        bind(note(ch, 0x1b), t('pfl')),
        bind(note(ch, 0x06), t('jogTouch')),
        bind(note(15, d === 'A' ? 0x02 : 0x03), t('load')),
        bind(rel(ch, 0x06, 'twos'), t('jog')),
        bind(cc(ch, 0x16), t('trim')),
        bind(cc(ch, 0x17), t('eq.high')),
        bind(cc(ch, 0x18), t('eq.mid')),
        bind(cc(ch, 0x19), t('eq.low')),
        bind(cc(ch, 0x1a), t('filter')),
        bind(cc(ch, 0x1c), t('volume')),
        bind(cc14(ch, 0x09), t('pitch')),
      );
      leds.push(
        ledNote(t('play'), ch, 0x00, 0x7f, LED_OFF),
        ledNote(t('cue'), ch, 0x01, 0x7f, LED_OFF),
        ledNote(t('sync'), ch, 0x02, 0x7f, LED_OFF),
        ledNote(t('pfl'), ch, 0x1b, 0x7f, LED_OFF),
      );
    }
    bindings.push(bind(cc(15, 0x08), 'crossfader'), bind(rel(15, 0x00, 'twos'), 'browse'), bind(cc(14, 0x23), 'masterVolume'));
    return mappingOf('Numark Mixtrack Pro FX', 'numark-mixtrack-pro-fx', bindings, leds);
  },
};

export const NUMARK_PRESETS: readonly ControllerPreset[] = [MIXTRACK_PRO_FX];
