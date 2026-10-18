// Drawable wavetables: the frames a user shapes (drawing, harmonics, imports), their compact storage in a plugin's
// state and the band-limited bank built from them. Pure TypeScript with no DOM; it runs on the main thread (editors,
// the AI's table ops) and in Node tests. Building a bank allocates, so do it off the audio thread and hand
// `bank.data` to the kernel (see the Wavetable's `onState`).
//
// The code lives in four files by job: wavetable-frame.ts (the Frame and its views), wavetable-frame-edit.ts (editing),
// wavetable-import.ts (audio and WAV files in and out) and wavetable-state.ts (storage in a plugin's state, the bank).
// This file re-exports all of them, so every import path stays the same.
export * from './wavetable-frame';
export * from './wavetable-frame-edit';
export * from './wavetable-import';
export * from './wavetable-state';
