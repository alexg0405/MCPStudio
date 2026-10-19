/** Reading a harmony request that arrives as loose arguments (a command's, the AI's, MCP's), with the project's channels at hand. */
import { guideNotesOfChannel } from '@core/query/harmony-voices';
import type { Services } from '../services';
import { parseVoiceSpec, type HarmonySpec, type SpecReaders } from './voice-spec';

/** Reads what a request needs from the project: the notes an instrument channel plays, found by id or name. */
export function specReaders(s: Services): SpecReaders {
  return {
    guide: (channel) => {
      const p = s.doc.getState().project;
      const wanted = channel.toLowerCase();
      const found = Object.values(p.channels).find((c) => c.id === channel || c.name.toLowerCase() === wanted);
      return found && found.kind === 'instrument' ? guideNotesOfChannel(p, found.id) : [];
    },
  };
}

/** A request from loose input, or throws `HarmonySpecError` in plain words. */
export function specFromArgs(s: Services, args: { voices?: unknown; humanize?: unknown; seed?: unknown }): HarmonySpec {
  return parseVoiceSpec(args, specReaders(s));
}
