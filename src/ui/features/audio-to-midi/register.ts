import type { Services } from '@app/services';
import { specFromArgs, clipOfArgs, type ConvertArgs } from '@app/transcribe/args';
import { addContextMenuItems } from '../../context-menus';
import { addMenuItems, cmd } from '../../shell/menus';
import { addOverlay } from '../../shell/overlays';
import { ConvertOverlay } from './ConvertDialog';
import { openConvertDialog } from './convert-store';
import { problemText, runConvert } from './run';

/**
 * Convert to MIDI: turn an audio clip (a sung line, a drum loop, chords, a bass) into notes. "Convert to MIDI…" is in an audio
 * clip's right-click and ▾ menu, the Playlist menu and the action search (Mod+K); it opens a dialog with the mode (suggested from
 * the sound), the target, quantize, sensitivity and a way to hear the notes against the audio. The command with a mode in its
 * arguments does it without the dialog (the AI and MCP reach it that way and through the `audio_to_midi` action). The work is in
 * `app/transcribe` and `core/audio/transcribe`.
 */
export function register(services: Services): void {
  registerCommands(services);
  registerMenus();
  addOverlay('audioToMidi', ConvertOverlay);
}

/** The one command, with an `argsHint` so the AI sees it in the command catalog. */
function registerCommands({ commands }: Services): void {
  commands.register<ConvertArgs | undefined>({
    id: 'audioToMidi.convert',
    title: 'Convert to MIDI…',
    category: 'Audio clip',
    hint: 'Turns the selected audio clip (a sung line, a drum loop, chords or a bass) into notes in a new pattern, placed on the playlist under the audio (one undo step)',
    argsHint:
      '{ clip?: audio clip id (default: the selected one), mode?: "auto" | "melody" | "drums" | "chords" | "bass", quantize?: "off" | "1/32" | "1/16t" | "1/16" | "1/8t" | "1/8" | "1/4", strength?: 0-100 (%), swing?: "straighten" | "keep", sensitivity?: 0-100 (%), articulation?: "natural" | "legato" | "staccato", target?: "new" | channel id or name, instrument?: plugin id for a new channel, place?: bool (default true), mute_original?: bool, slice_pads?: bool (drums), fill_chord_track?: bool (chords), chord_resolution?: "beat" | "half" | "bar", chord_rhythm?: "hold" | "beats" | "offbeats" | "eighths", chord_bass?: bool }; without mode a dialog opens',
    enabled: (s) => Object.values(s.doc.getState().project.playlist.clips).some((c) => c.kind === 'audio'),
    run: async (s, args) => {
      const clip = clipOfArgs(s, args);
      if (!clip) {
        s.session.getState().toast('Select the audio clip to convert on the playlist first.');
        return;
      }
      if (!args || args.mode === undefined) {
        openConvertDialog(clip);
        return;
      }
      try {
        await runConvert(s, await specFromArgs(s, args));
      } catch (e) {
        s.session.getState().toast(problemText(e), 'error');
      }
    },
  });
}

/** The audio clip's right-click menu (its ▾ menu is the same list) and the Playlist menu. */
function registerMenus(): void {
  addContextMenuItems('playlist.clip', ({ clip }, s) =>
    clip.kind === 'audio'
      ? [
          {
            label: 'Convert to MIDI…',
            hint: 'Turn this audio into notes: a melody, a drum beat, chords or a bass line, in a new pattern placed under it',
            onSelect: () => void s.commands.run('audioToMidi.convert', { clip: clip.id }),
          },
        ]
      : [],
  );
  addMenuItems('playlist', [cmd('audioToMidi.convert', 37)]);
}
