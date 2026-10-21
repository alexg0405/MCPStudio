/**
 * What a plugin can do and can't, in plain words, worked out from its files: shown before a bundle is installed.
 * Honest about the limits: the safety scan refuses obvious misuse, but a plugin is code that runs inside AGstudio, so the
 * advice is to install plugins from people you trust.
 */
import type { PluginFile } from './rules';
import type { BundleKind } from './manifest';

/** What the install dialog tells the musician about a plugin. */
export interface PluginCapabilities {
  /** What it can do: sentences, each one thing. */
  can: string[];
  /** What the safety checks refused it (it passed them): sentences. */
  cannot: string[];
  /** The caveat that holds for every plugin. */
  caution: string;
}

const KIND_WORDS: Record<BundleKind, string> = {
  instrument: 'plays notes and makes sound as an instrument',
  effect: 'changes the sound of a mixer track as an effect',
  'note-script': 'changes notes in the piano roll as a tool',
};

/** The words for a kind: "an instrument", "an effect" or "a piano-roll tool". */
export function kindName(kind: BundleKind): string {
  return kind === 'note-script' ? 'a piano-roll tool' : kind === 'effect' ? 'an effect' : 'an instrument';
}

/** What the files show about what the plugin can do (the checks have already run, so these are the permitted things). */
export function pluginCapabilities(kind: BundleKind, files: readonly PluginFile[]): PluginCapabilities {
  const can = [`It ${KIND_WORDS[kind]}.`];
  if (files.some((file) => file.path.endsWith('.worklet.ts')))
    can.push('It runs its own sound-processing code on the audio thread.');
  if (files.some((file) => file.path.endsWith('.dsp')))
    can.push('It contains Faust sound code, which is compiled and can only compute audio.');
  const drawsPanel = files.some(
    (file) => file.path.endsWith('.tsx') || /@agstudio\/sdk\/ui|from\s*['"]react['"]/.test(file.content),
  );
  if (drawsPanel) can.push('It draws its own panel with controls (React code that runs in the AGstudio page).');
  if (files.some((file) => /@agstudio\/sdk\/notes/.test(file.content)))
    can.push('It reads and writes notes through the note tools.');
  can.push('It stores its settings in your project, like any plugin.');
  return {
    can,
    cannot: [
      'It does not use the network (no fetch, sockets or beacons).',
      'It does not use browser storage or cookies.',
      'It does not use eval, new Function or dynamic import, and does not open pages or scripts.',
      'It imports nothing but the AGstudio plugin SDK, React and its own files.',
    ],
    caution:
      'A plugin is code that runs inside AGstudio with the same access as the app itself. These checks catch honest mistakes and obvious misuse, but they are not a sandbox: install plugins only from people you trust.',
  };
}
