import type { WindowHelp } from '../../workspace/window-help';

/** The "?" how-to of each built-in window. `mod` is ⌘ on a Mac, Ctrl elsewhere; `alt` is ⌥ or Alt. */
export function windowHelpTexts(mod: string, alt: string): Record<string, WindowHelp> {
  return {
    'channel-rack': {
      intro: 'Your sounds, one row each, and the steps of the current pattern. The pattern loops while it plays.',
      moves: [
        ['Click or drag over squares', 'Turn steps on (a beat)'],
        ['Right-click or right-drag', 'Turn steps off'],
        ['Green light', 'Mute the sound (right-click: solo it)'],
        ['Knobs', 'Pan and volume (double-click resets)'],
        ['Number box', 'Which mixer track the sound plays through'],
        ['Double-click a name', 'Open its instrument'],
        ['Right-click a name', 'Piano roll, rename, color, clone, delete'],
        ['Steps ▾', 'Fill every 2/4/8, rotate, shift, randomize, clear'],
        ['+ at the bottom', 'Add a sound or an instrument'],
      ],
    },
    'piano-roll': {
      intro: 'Melodies and chords for the sound selected in the channel rack, in the current pattern.',
      moves: [
        ['Click empty space (Draw)', 'Add a note'],
        ['Drag a note', 'Move it (Shift+drag copies it)'],
        ['Drag a note’s right edge', 'Make it longer or shorter'],
        ['Right-click a note', 'Delete it (with Select: its menu)'],
        [`${mod}+drag`, 'Select notes; then drag them or use Tools ▾'],
        [`Notes menu → Ask Studio (${alt}+Shift+A)`, 'Tell Studio what to change in the selected notes; only they change'],
        [`Hold ${alt} while dragging`, 'Ignore the grid'],
        ['Tools ▾', 'Quantize, humanize, strum, arpeggiate, chords…'],
        ['Key ▾', 'The song key: highlight and snap to its scale'],
        ['Lanes below', 'Velocity, pan, release, fine pitch per note'],
        [`Scroll / ${mod}+scroll`, 'Scroll / zoom'],
      ],
    },
    playlist: {
      intro: 'Your song: patterns, audio and automation clips over time. Switch the transport to SONG to hear it.',
      moves: [
        ['Click an empty spot (Draw)', 'A menu: place a pattern, paste, ask Studio, a fill, a marker…'],
        ['Drag on an empty spot (Draw)', 'Place the current pattern there'],
        ['Drag a clip', 'Move it (Shift+drag copies it)'],
        ['Drag a clip’s edge', 'Make it longer or shorter'],
        ['Right-click a clip', 'Delete it'],
        [`${mod}+drag`, 'Select several clips'],
        ['Drag in the ruler', 'Set a loop region; click to set the song position'],
        [`${alt}+T`, 'Add a marker at the song position (click one to jump there, drag to move it)'],
        [`Ask Studio over a selection or loop (${alt}+A)`, 'Tell Studio what to change there; only that part changes (one undo)'],
        ['The mark on a marker flag', 'Loop that section and ask Studio about it'],
        ['Double-click a pattern clip', 'Open that pattern'],
        ['Squares along an audio clip’s top', 'Drag the outer ones to fade in or out, the middle one for volume'],
        ['Clip ▾ on an audio clip', 'Reverse, pitch, follow the tempo, normalize, slice at hits…'],
        ['Automation clips', 'Double-click the curve for a point; drag points; right-click for shapes'],
        [`Hold ${alt} while dragging`, 'Ignore the grid'],
        [`${mod}+scroll / ${alt}+scroll`, 'Zoom in time / make tracks taller'],
      ],
    },
    mixer: {
      intro: 'Every sound plays through a mixer track and ends up in the Master. Tracks have levels, effects and sends.',
      moves: [
        ['Click a track', 'Select it: its effects show on the right'],
        ['Drag or scroll a fader', `Its level (double-click: 0 dB; Shift: fine)`],
        ['Send knobs under other tracks', 'Send the selected track to them (e.g. a reverb bus)'],
        ['Right-click a track', 'Send to, route only to, sidechain, remove sends'],
        ['Click an empty slot', 'Add an effect'],
        ['Right-click an effect', 'Open, replace, move, sidechain from…, remove'],
        ['Green light', 'Mute the track (right-click: solo)'],
      ],
    },
    plugin: {
      intro: 'An instrument’s or effect’s settings. Every knob can be automated or linked to a MIDI controller.',
      moves: [
        ['Drag a knob up or down', 'Change it (Shift: fine)'],
        ['Double-click a knob', 'Back to its default'],
        ['Scroll over a knob', 'Nudge it'],
        ['Right-click a knob', 'Automation clip, link to a MIDI controller'],
        ['Presets', 'Ready-made settings to start from'],
      ],
    },
    assistant: {
      intro: 'Ask Studio for anything in your own words. Every answer is one change you can undo.',
      moves: [
        ['Type and press Enter', 'Beats, mixing, effects, arrangement, saving, new plugins…'],
        ['Record', 'Beatbox drums or hum a line; then say what it should become'],
        ['Undo under an answer', 'Take back everything that answer did'],
        ['“About …” above the box', 'Studio changes only that part of the song; ▶ plays it, × asks about the whole song'],
        ['New chat', 'Start over (Studio forgets the conversation)'],
        [`${mod}+K`, 'Search any action, or hand the words to Studio'],
      ],
    },
    history: {
      intro: 'Every change you made, newest at the bottom.',
      moves: [
        ['Click a change', 'Go back to just after it'],
        ['Click a dimmed change', 'Redo up to it'],
        [`${mod}+Z / ${mod}+Shift+Z`, 'Undo / redo one step'],
      ],
    },
    'piano-keyboard': {
      intro: 'Play the selected sound with the mouse, your computer keyboard or a MIDI keyboard.',
      moves: [
        ['Click or drag over keys', 'Play notes'],
        ['Octave buttons', 'Move the keyboard up or down'],
        ['Record (R), then play', 'Write what you play into the pattern'],
      ],
    },
  };
}
