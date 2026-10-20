/**
 * Read-only tools: what the AI (and the MCP server) can look at. Each returns compact JSON with ids and
 * names, in the units the actions take (dB, 1-based bars, 1/16 steps, MIDI keys), so what it reads is what
 * it can write back. `readTools` is the list (name, description, JSON schema of the arguments, `run`);
 * `runReadTool` runs one by name and turns a bad argument into `{ error }` instead of a throw.
 *
 * The tools live in one module per group: `project-tools` (overview, transport, selection, settings, windows),
 * `music-tools` (notes, chords), `sound-tools` (mixer, channels, plugins, chains), `arrangement-tools`
 * (clips, automation, takes, launcher), `mix-state-tools` (mixer snapshots and groups) and `measurement-tools` (reference, loudness, pitch, vocal cleanup, samples).
 */
import type { Services } from '../../services';
import { isObj } from '../ops/values';
import { getAutomation, getClips, getLauncher, getTakes } from './arrangement-tools';
import { getLyrics } from './lyrics-tools';
import { getAlignment, getCleanup, listSampleSounds, getLoudness, getPitch, getReference } from './measurement-tools';
import { getMixGroups, getMixSnapshots } from './mix-state-tools';
import { getChords, getPatternNotes } from './music-tools';
import { getProject, getSelection, getSettings, getTransport, getWindows } from './project-tools';
import { getChains, getChannel, getMixer, getPlugins } from './sound-tools';
import type { ReadTool, ToolArgs } from './tool';

export type { ReadTool } from './tool';

/** Every read tool, in the order they are listed to the model. */
export const readTools: readonly ReadTool[] = [
  getProject,
  getTransport,
  getChords,
  getLyrics,
  getSelection,
  getPatternNotes,
  getChannel,
  getMixer,
  getMixSnapshots,
  getMixGroups,
  getClips,
  getTakes,
  getAutomation,
  getSettings,
  getWindows,
  getPlugins,
  getChains,
  getReference,
  getLoudness,
  getPitch,
  getCleanup,
  getAlignment,
  getLauncher,
  listSampleSounds,
];

/** Runs a read tool by name; an unknown name or a bad argument comes back as `{ error }`. */
export function runReadTool(services: Services, name: string, args: unknown = {}): unknown {
  const readTool = readTools.find((candidate) => candidate.name === name);
  if (!readTool) {
    return {
      error: `there is no read tool "${name}" (tools: ${readTools.map((candidate) => candidate.name).join(', ')})`,
    };
  }
  return readTool.run(services, isObj(args) ? args : {});
}

/** How many characters of one look-up result go back to the AI before it is cut. */
const MAX_LOOKUP_CHARS = 14000;

/** What a `query` answer brings back, as text for the next turn (each result cut at `max` characters). */
export function formatLookups(
  queries: readonly { tool: string; args: ToolArgs; result: unknown }[],
  max = MAX_LOOKUP_CHARS,
): string {
  return queries
    .map((query) => {
      const json = JSON.stringify(query.result);
      const body =
        json.length > max
          ? `${json.slice(0, max)}…(cut: ask again for less, e.g. one channel or a range of bars)`
          : json;
      return `${query.tool} ${JSON.stringify(query.args)}\n${body}`;
    })
    .join('\n\n');
}
