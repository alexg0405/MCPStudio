/** What the take commands share: their arguments, finding the take group they act on, and which take is meant. */
import { compTarget, type CompTarget } from '@app/actions/comp';
import type { Services } from '@app/services';

/** The arguments the take commands accept (all optional; the AI and the action search pass them). */
export type TakeArgs = {
  clip?: string;
  group?: string;
  take?: number;
  from_bar?: number;
  to_bar?: number;
  merge?: boolean;
  ms?: number;
  open?: boolean;
  on?: boolean;
};

/** The hint shared by every command that says which recording it works on. */
export const GROUP_ARGS =
  'optional { clip: id of a take or comp clip, or group: take group id } (default: the selected clip, the clip under the pointer, or the song’s only take group)';

/** A command is available when there is a take group to act on. */
export const hasTakeGroup = (s: Services): boolean => compTarget(s) !== null;

/** The take group a command acts on, or null with a toast that says how to choose one. */
export function takeTarget(s: Services, args?: TakeArgs): CompTarget | null {
  const target = compTarget(s, args);
  if (!target) s.session.getState().toast('Select a clip of a recording’s takes (or its comp track) first.');
  return target;
}

/** "Use this take": a take number (1-based) from the args, else the take of the clip. */
export function takeIndexOf(s: Services, target: CompTarget, args?: TakeArgs): number | null {
  if (typeof args?.take === 'number') {
    const found = target.group.takes[Math.round(args.take) - 1];
    if (!found) {
      s.session.getState().toast(`This recording has ${target.group.takes.length} takes: there is no take ${args.take}.`, 'error');
    }
    return found?.index ?? null;
  }
  if (target.take !== null) return target.take;
  s.session.getState().toast('Select the take you want to use first (a clip on one of the take tracks).');
  return null;
}
