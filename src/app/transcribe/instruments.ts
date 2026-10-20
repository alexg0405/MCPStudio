/** The instrument each mode starts with when "Convert to MIDI" makes a new channel (the musician can pick any other afterwards). */
import type { TranscribeMode } from '@core/audio/transcribe';

/** A suggested instrument: its plugin id, the plain name shown in the dialog and a few words on why. */
export interface SuggestedInstrument {
  pluginId: string;
  label: string;
  why: string;
}

/** Drums play Drum Pads (General MIDI keys), a melody a pluck, chords an FM keyboard, a bass a 3xOsc. */
export const SUGGESTED_INSTRUMENT: Readonly<Record<TranscribeMode, SuggestedInstrument>> = {
  drums: { pluginId: 'agstudio.drum-pads', label: 'Drum Pads', why: 'plays the General MIDI drum keys, and can use the hits cut from your recording' },
  melody: { pluginId: 'agstudio.pluck', label: 'Pluck', why: 'a plucked string that follows a tune clearly' },
  chords: { pluginId: 'agstudio.fm', label: 'FM keys', why: 'a keyboard-like tone for chords' },
  bass: { pluginId: 'agstudio.3xosc', label: '3xOsc', why: 'a plain synth for a bass line' },
};

/** The name a new channel gets: the audio's name and what was read from it ("Vocal · Melody"). */
export function channelNameFor(audioName: string, modeLabel: string): string {
  return `${audioName} · ${modeLabel}`.slice(0, 64);
}
