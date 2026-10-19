import type { Services } from '@app/services';
import { voicesOfLead } from '@core/query/harmony-voices';
import type { AudioClip, ClipId } from '@core/model/types';
import { addContextMenuItems } from '../../context-menus';
import { addMenuItems, cmd } from '../../shell/menus';
import { addOverlay } from '../../shell/overlays';
import { HarmonyOverlay } from './HarmonyDialog';
import { openHarmonyDialog } from './harmony-store';
import { hasHarmonies, leadClipOf, runMake, runUpdate, specFromArgs, staleCount } from './run';

/** The clip a harmony voice follows, or the clip itself. */
const leadOf = (clip: AudioClip): ClipId => clip.harmony?.source ?? clip.id;

/**
 * Harmonies from a sung lead: "Make harmonies…" (a dialog with the rules, voices, a preview and A/B) in an audio clip's menu and
 * the Playlist menu, "Update harmonies" to make the voices again when the lead, the chords or the key changed, a command for
 * each (the AI and MCP reach them through these and the `make_harmonies` / `update_harmonies` actions). The work is in
 * `app/harmony`; the Harmonizer effect is the real-time cousin (`plugins/builtin/harmonizer`).
 */
export function register(services: Services): void {
  registerCommands(services);
  registerMenus();
  addOverlay('harmonies', HarmonyOverlay);
}

/** Make and update, each with an `argsHint` so the AI sees them in the command catalog. */
function registerCommands({ commands }: Services): void {
  commands.register<{ clip?: string; voices?: unknown; humanize?: unknown; seed?: unknown } | undefined>({
    id: 'harmonies.make',
    title: 'Make harmonies…',
    category: 'Audio clip',
    hint: 'Makes harmony voices from the selected sung audio clip: new tracks under it with a third above, a fifth below or chord tones, each its own clip you can mix (one undo step)',
    argsHint:
      '{ clip?: audio clip id (default: the selected one), voices?: [{ rule: "third_above" | "third_below" | "fifth_above" | "fifth_below" | "sixth_above" | "octave_below" | "diatonic" + interval "3rd above" | "chord_above" | "chord_below" | "fixed" + interval semitones | "guide" + channel, level: dB, pan: -1..1, formant: cents }], humanize?: { timing_ms, drift_cents, vibrato 0..1 } }; without voices a dialog opens',
    enabled: (s) => Object.values(s.doc.getState().project.playlist.clips).some((c) => c.kind === 'audio'),
    run: async (s, args) => {
      const clip = leadClipOf(s, args);
      if (!clip) {
        s.session.getState().toast('Select the sung audio clip on the playlist first.');
        return;
      }
      if (!args?.voices) {
        openHarmonyDialog(clip.id);
        return;
      }
      try {
        await runMake(s, clip.id, specFromArgs(s, args));
      } catch (e) {
        s.session.getState().toast(e instanceof Error ? e.message : String(e), 'error');
      }
    },
  });
  commands.register<{ clip?: string; force?: boolean } | undefined>({
    id: 'harmonies.update',
    title: 'Update harmonies',
    category: 'Audio clip',
    hint: 'Makes harmony voices again from their lead as it is now (after changing the sung line, the chords or the song key); only the voices that are out of date, one undo step',
    argsHint: '{ clip?: a lead or harmony clip id (default: every harmony in the song), force?: true to remake voices that are up to date too }',
    enabled: hasHarmonies,
    run: async (s, args) => {
      await runUpdate(s, { ...(args?.clip ? { clip: args.clip as ClipId } : {}), ...(args?.force ? { force: true } : {}) });
    },
  });
}

/** The audio clip's right-click menu and the Playlist menu. */
function registerMenus(): void {
  addContextMenuItems('playlist.clip', ({ clip }, s) => {
    if (clip.kind !== 'audio') return [];
    const project = s.doc.getState().project;
    const mine = voicesOfLead(project, leadOf(clip));
    const stale = staleCount(s);
    const entries = [
      {
        label: 'Make harmonies…',
        hint: 'Harmony voices from this sung clip: a third above, a fifth below, chord tones or your own notes, each on its own track',
        onSelect: () => void s.commands.run('harmonies.make', { clip: clip.id }),
      },
    ];
    if (mine.length > 0 || clip.harmony) {
      entries.push({
        label: stale > 0 ? `Update harmonies (${stale} out of date)` : 'Update harmonies',
        hint: 'Makes this clip’s harmony voices again from the lead as it is now (after changes to the notes, the chords or the key)',
        onSelect: () => void s.commands.run('harmonies.update', { clip: clip.id }),
      });
    }
    return entries;
  });
  addMenuItems('playlist', [cmd('harmonies.make', 35), cmd('harmonies.update', 36)]);
}
