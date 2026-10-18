/**
 * What an applied answer asks the app to do besides editing the project: run commands, drive the live DJ
 * decks, wait for new sounds to load and start (or stop) playback. A turn in the Studio chat and an edit
 * from an AI app over MCP both use these.
 */
import type { AppliedBeat } from '../apply';
import type { AfterEdit } from '../../ai/apply';
import { describeDeckAction, runDeckActions } from '../../ai/ops/decks';
import type { Services } from '../../services';
import type { AssistantMessage } from '../state';

/** How long (ms) to wait for new instruments and effects to load before playing anyway. */
const ENGINE_READY_TIMEOUT_MS = 4000;

type CommandAction = Extract<AfterEdit, { kind: 'command' }>;

/** What running the commands of an answer adds to the chat message. */
export interface CommandReport {
  changes: string[];
  warnings: string[];
}

/** The chat message fields for a beat the answer wrote ("Undo" goes back to `cursor`). */
export function beatMessageFields(
  services: Services,
  beat: AppliedBeat | null,
  cursor: number,
): Partial<AssistantMessage> {
  if (!beat) return {};
  const patternName = services.doc.getState().project.patterns[beat.patternId]?.name ?? 'Beat';
  return { beat: { title: patternName, cursor } };
}

/** How the commands of an answer are reported. */
export interface RunCommandsOptions {
  /** The chat line for a command that waits for the musician's click. */
  waitingNote(commandTitle: string): string;
  /** Called for each command that waits for the musician's click (an AI app shows them a button). */
  onGesture?(command: CommandAction): void;
}

/**
 * Runs the commands an answer asked for. File dialogs (`gesture`) need the musician's own click, so they only
 * get a line in the chat (and `onGesture`). The rest run now.
 */
export function runCommands(
  services: Services,
  after: readonly AfterEdit[],
  report: CommandReport,
  { waitingNote, onGesture }: RunCommandsOptions,
): void {
  for (const action of after) {
    if (action.kind !== 'command') continue;
    const title = services.commands.get(action.id)?.title.replace(/…$/, '') ?? action.id;
    if (action.gesture) {
      onGesture?.(action);
      report.changes.push(waitingNote(title));
    } else if (services.commands.run(action.id, action.args)) {
      report.changes.push(`Ran “${title}”`);
    } else {
      report.warnings.push(`command: “${title}” isn't available right now`);
    }
  }
}

/**
 * Starts the live DJ deck actions of an answer (loading a song takes a moment, so problems come up later as
 * toasts) and adds a line for each to `changes`.
 */
export function startDeckActions(services: Services, after: readonly AfterEdit[], changes: string[]): void {
  for (const action of after) {
    if (action.kind !== 'decks') continue;
    changes.push(...action.actions.map(describeDeckAction));
    void runDeckActions(services, action.actions).then((problems) => {
      for (const problem of problems) services.session.getState().toast(problem, 'error');
    });
  }
}

/**
 * New instruments and effects load in the background: waits until they can sound (or a few seconds), so the
 * music that starts next isn't missing them.
 */
export async function waitForNewSounds(services: Services): Promise<void> {
  const loaded = services.engine.ready().catch(() => {});
  const timedOut = new Promise((resolve) => setTimeout(resolve, ENGINE_READY_TIMEOUT_MS));
  await Promise.race([loaded, timedOut]);
}

/**
 * The playback the answer asked for: a mode switch, stop, the metronome, play (from a tick, maybe armed to
 * record). Nothing else starts or stops the music here. `canArmRecording` is false for AI apps over MCP:
 * they can't arm the mic.
 */
export function applyRequestedPlayback(
  services: Services,
  after: readonly AfterEdit[],
  { canArmRecording }: { canArmRecording: boolean },
): void {
  for (const action of after) {
    if (action.kind === 'mode') {
      services.view.getState().setMode(action.mode);
    } else if (action.kind === 'stop') {
      services.engine.stop();
    } else if (action.kind === 'metronome') {
      services.prefs.getState().set({ metronome: action.on });
    } else if (action.kind === 'play') {
      if (action.mode) services.view.getState().setMode(action.mode);
      if (action.record && canArmRecording) services.recording.setArmed(true);
      services.engine.play(action.fromTick ?? 0);
    }
  }
}
