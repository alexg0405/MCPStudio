/**
 * Raw MIDI messages: parsing what a controller sends and building what we send back (LEDs).
 * Pure bytes in, plain objects out; no Web MIDI types, so it runs in Node tests.
 */

export type MidiMessage =
  | { kind: 'noteOn'; channel: number; note: number; velocity: number }
  | { kind: 'noteOff'; channel: number; note: number; velocity: number }
  | { kind: 'cc'; channel: number; cc: number; value: number }
  | { kind: 'bend'; channel: number; value: number };

/** Parses one channel-voice message (a note-on with velocity 0 is a note-off). Anything else (clock, sysex, program change…) is null. */
export function parseMidi(data: ArrayLike<number>): MidiMessage | null {
  const status = data[0] ?? 0;
  if (status < 0x80 || status >= 0xf0) return null;
  const channel = status & 0x0f;
  const d1 = (data[1] ?? 0) & 0x7f;
  const d2 = (data[2] ?? 0) & 0x7f;
  switch (status & 0xf0) {
    case 0x90:
      return d2 > 0 ? { kind: 'noteOn', channel, note: d1, velocity: d2 } : { kind: 'noteOff', channel, note: d1, velocity: 0 };
    case 0x80:
      return { kind: 'noteOff', channel, note: d1, velocity: d2 };
    case 0xb0:
      return { kind: 'cc', channel, cc: d1, value: d2 };
    case 0xe0:
      return { kind: 'bend', channel, value: (d2 << 7) | d1 };
    default:
      return null;
  }
}

/** "Ch 2  CC 7 = 64", for the controller test view. */
export function describeMidi(data: ArrayLike<number>): string {
  const m = parseMidi(data);
  if (!m) return Array.from(data as ArrayLike<number>, (b) => b.toString(16).padStart(2, '0')).join(' ');
  const ch = `Ch ${m.channel + 1}`;
  switch (m.kind) {
    case 'noteOn':
      return `${ch}  note ${m.note} on (${m.velocity})`;
    case 'noteOff':
      return `${ch}  note ${m.note} off`;
    case 'cc':
      return `${ch}  CC ${m.cc} = ${m.value}`;
    case 'bend':
      return `${ch}  pitch bend ${m.value}`;
  }
}

/** The bytes of a MIDI note-on message. */
export const noteOnBytes = (channel: number, note: number, velocity: number): number[] => [0x90 | (channel & 15), note & 127, velocity & 127];
/** The bytes of a MIDI note-off message. */
export const noteOffBytes = (channel: number, note: number): number[] => [0x80 | (channel & 15), note & 127, 0];
/** The bytes of a MIDI control change message. */
export const ccBytes = (channel: number, cc: number, value: number): number[] => [0xb0 | (channel & 15), cc & 127, value & 127];
