import { createElement } from 'react';
import type { Services } from '@app/services';
import { exportMidi, importMidiFile, pickMidiFile, saveMidiFile, type MidiImportOptions } from '@app/actions/midi';
import { p } from '@agstudio/sdk';
import { showFormDialog } from '../../controls/FormDialog';
import { addContextMenuItems } from '../../context-menus';
import { addParamMenuItems } from '../../param-menu';
import { addMenuItems, cmd, sep } from '../../shell/menus';
import { registerWindowType } from '../../workspace/registry';
import { registerWindowToggle } from '../../workspace/window-commands';
import { PianoKeyboard } from './PianoKeyboard';

const IMPORT_FIELDS = [
  { kind: 'param', key: 'split', spec: p.bool(true, { label: 'One pattern per track' }) },
  { kind: 'param', key: 'tempo', spec: p.bool(true, { label: 'Use the file’s tempo' }) },
  { kind: 'param', key: 'place', spec: p.bool(true, { label: 'Put it on the playlist' }) },
] as const;

/** Asks for the import options and imports the file. */
async function importWithOptions(s: Services, file: File): Promise<void> {
  const values = await showFormDialog({
    title: `Import ${file.name}`,
    message: 'Drums go to the kit channels; other parts get an instrument for their kind (piano, bass, pad…).',
    fields: IMPORT_FIELDS,
    values: { split: true, tempo: true, place: true },
    okLabel: 'Import',
  });
  if (!values) return;
  try {
    const res = await importMidiFile(s, file, values as unknown as MidiImportOptions);
    s.session
      .getState()
      .toast(
        `Imported ${res.notes} notes into ${res.patterns.length} pattern${res.patterns.length === 1 ? '' : 's'}${
          res.skipped ? ` (${res.skipped} drum notes had no kit sound)` : ''
        }.`,
      );
  } catch (e) {
    s.session.getState().toast(e instanceof Error ? e.message : String(e), 'error');
  }
}

/** MIDI files (import, export, drops), MIDI learn, hum to notes and the on-screen piano. */
export function register(services: Services): void {
  registerMidiFiles(services);
  registerHumToNotes(services);
  registerMidiLearn();
  registerOnScreenPiano(services);
  installMidiFileDrop(services);
}

/** Import and export of MIDI files, and their File menu entries. */
function registerMidiFiles({ commands }: Services): void {
  commands.register({
    id: 'file.importMidi',
    gesture: true,
    title: 'Import MIDI…',
    category: 'File',
    hint: 'Bring a .mid file in as patterns and channels',
    run: async (s) => {
      const file = await pickMidiFile();
      if (file) await importWithOptions(s, file);
    },
  });
  commands.register<'song' | 'pattern'>({
    id: 'file.exportMidi',
    gesture: true,
    argsHint: "'song' (default) or 'pattern' (the current pattern)",
    title: 'Export MIDI',
    category: 'File',
    hint: 'Save the song or the current pattern as a .mid file',
    run: async (s, scope) => {
      try {
        const { bytes, name } = exportMidi(s, scope === 'pattern' ? 'pattern' : 'song');
        await saveMidiFile(bytes, name);
      } catch (e) {
        s.session.getState().toast(e instanceof Error ? e.message : String(e), 'error');
      }
    },
  });
  addMenuItems('file', [
    sep(64),
    cmd('file.importMidi', 65),
    { kind: 'command', command: 'file.exportMidi', args: 'song', label: 'Export song as MIDI…', order: 66 },
    { kind: 'command', command: 'file.exportMidi', args: 'pattern', label: 'Export pattern as MIDI…', order: 67 },
  ]);
}

/** Hum (or sing) a melody into the piano roll: the command and its menu entries. */
function registerHumToNotes({ commands }: Services): void {
  commands.register({
    id: 'pianoRoll.humToNotes',
    title: 'Hum to notes…',
    category: 'Piano roll',
    hint: 'Hum or sing a melody after the count-in; it becomes notes on the selected channel',
    enabled: (s) => !!s.session.getState().selectedChannelId && !!s.view.getState().currentPatternId,
    run: async (s) => {
      // The voice analysis code loads when this first runs (humming is only in progress once it has).
      const { humToNotes, isHumming, stopHumming } = await import('@app/actions/hum');
      if (isHumming()) {
        stopHumming();
        return;
      }
      const channelId = s.session.getState().selectedChannelId;
      const patternId = s.view.getState().currentPatternId;
      if (!channelId || !patternId) return;
      const values = await showFormDialog({
        title: 'Hum to notes',
        message: 'After a one-bar count-in, hum or sing the melody. It is written as notes on the selected channel.',
        fields: [
          { kind: 'param', key: 'bars', spec: p.int(1, 8, 2, { label: 'Bars' }) },
          { kind: 'param', key: 'playAlong', spec: p.bool(true, { label: 'Play the pattern while I hum' }) },
        ],
        values: { bars: 2, playAlong: true },
        okLabel: 'Record',
      });
      if (!values) return;
      s.session.getState().toast('Count-in… then hum. Use “Hum to notes” again to stop early.');
      const res = await humToNotes(s, {
        channelId,
        patternId,
        bars: Number(values.bars),
        playAlong: Boolean(values.playAlong),
      });
      if ('error' in res) s.session.getState().toast(res.error, 'error');
      else s.session.getState().toast(`Wrote ${res.notes} note${res.notes === 1 ? '' : 's'} from your humming.`);
    },
  });
  addMenuItems('edit', [sep(175), cmd('pianoRoll.humToNotes', 176)]);
  addContextMenuItems('pianoRoll.empty', (_ctx, s) => [
    { label: 'Hum to notes…', onSelect: () => void s.commands.run('pianoRoll.humToNotes') },
  ]);

}

/** MIDI learn on every control with a param menu. */
function registerMidiLearn(): void {
  addParamMenuItems((info, s) => {
    const links = s.controllers.linksFor(info.target);
    const learn = () => {
      if (!s.midi.enabled) void s.commands.run('options.midiInput');
      s.session.getState().toast(`Move a knob, fader or wheel on your MIDI device to control ${info.label}…`);
      void s.controllers.learn(info.target).then((link) => {
        if (link) s.session.getState().toast(`${info.label} follows controller ${link.cc}.`);
      });
    };
    return [
      { label: links.length ? `Relink controller (now CC ${links[0]!.cc})…` : 'Link to controller…', onSelect: learn },
      ...(links.length ? [{ label: 'Unlink controller', onSelect: () => s.controllers.unlink(info.target) }] : []),
    ];
  });
}

/** The on-screen piano window and the command that toggles it. */
function registerOnScreenPiano(services: Services): void {
  registerWindowType({
    type: 'piano-keyboard',
    title: () => 'Keyboard',
    component: () => createElement(PianoKeyboard),
    defaultRect: (ws) => ({ x: Math.max(0, ws.w / 2 - 330), y: Math.max(0, ws.h - 190), w: 660, h: 170 }),
    minSize: { w: 360, h: 140 },
  });
  registerWindowToggle(services, {
    command: 'view.keyboard',
    title: 'On-screen keyboard',
    type: 'piano-keyboard',
    hint: 'Play the selected channel with the mouse (and see what your MIDI keyboard plays)',
    chords: ['Alt+7'],
    menuOrder: 46,
  });
}

/** A .mid file dropped anywhere imports it (before other drop handlers see it); only in a browser. */
function installMidiFileDrop(services: Services): void {
  if (typeof window === 'undefined') return;
  // A .mid file dropped anywhere imports it (before other drop handlers see it).
  window.addEventListener(
    'drop',
    (e) => {
      const file = [...(e.dataTransfer?.files ?? [])].find((f) => /\.(mid|midi)$/i.test(f.name));
      if (!file) return;
      e.preventDefault();
      e.stopPropagation();
      void importWithOptions(services, file);
    },
    true,
  );
}
