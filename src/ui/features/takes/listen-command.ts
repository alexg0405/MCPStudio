/** "Listen to this take": hear one take on its own, without changing the project. */
import { compTarget, listenToTake, takeClipFor, type CompTarget } from '@app/actions/comp';
import type { Services } from '@app/services';
import type { ClipId } from '@core/model/types';
import { GROUP_ARGS, hasTakeGroup, takeIndexOf, type TakeArgs } from './target';

/** Goes back to the comp. */
function stopListening(s: Services): void {
  listenToTake(s, null, false);
  s.session.getState().setHint('Back to the comp');
}

/**
 * The take clip to listen to: the clip named (or selected) when it is a take clip, else the take's clip under the
 * target's span.
 */
function clipToHear(s: Services, target: CompTarget, takeIndex: number, args?: TakeArgs): ClipId | null {
  const project = s.doc.getState().project;
  const given = typeof args?.clip === 'string' ? project.playlist.clips[args.clip as ClipId] : undefined;
  const isGivenTakeClip = given?.kind === 'audio' && !!given.take && !given.take.comp && typeof args?.take !== 'number';
  return isGivenTakeClip ? given.id : takeClipFor(target.group, takeIndex, target.span);
}

/** Registers `comp.listenTake` (with Alt+L on the playlist). */
export function registerListenCommand(services: Services): void {
  services.commands.register<TakeArgs>({
    id: 'comp.listenTake',
    title: 'Listen to this take (solo)',
    category: 'Takes',
    hint: 'Hear one take on its own: the comp and the other takes go quiet, nothing is unmuted or changed in the project. Run it again to go back to the comp. The speaker on a take track does the same: hold it to listen only while pressed',
    argsHint: `${GROUP_ARGS}; take: 1-based take number to hear (default: the selected take clip's); on: false goes back to the comp`,
    enabled: (s) => hasTakeGroup(s) || s.editor.getState().auditionTake !== null,
    run: (s, args) => {
      if (args?.on === false) return stopListening(s);
      const target = compTarget(s, args);
      if (!target) {
        if (s.editor.getState().auditionTake) return stopListening(s);
        s.session.getState().toast('Select a take (a clip on one of the take tracks) first.');
        return;
      }
      const index = takeIndexOf(s, target, args);
      if (index === null) return;
      const heard = listenToTake(s, clipToHear(s, target, index, args), args?.on);
      if (!heard) {
        s.session.getState().setHint('Back to the comp');
        return;
      }
      const number = target.group.takes.findIndex((take) => take.index === index) + 1;
      s.session
        .getState()
        .setHint(`Listening to take ${number} on its own: the comp and the other takes are quiet. Alt+L again (or the speaker on the track) goes back`);
    },
  });
  services.keymap.add([{ chord: 'Alt+L', command: 'comp.listenTake', when: { focus: ['playlist'] } }]);
}
