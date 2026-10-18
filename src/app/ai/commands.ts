/**
 * The app's commands as the AI sees them: everything a menu, button or shortcut can do (save,
 * export, undo, windows, layouts, settings…), so a request like "save it" or "show the mixer"
 * works without an action of its own. Sent with the plugin catalog, when it changes.
 */
import type { Services } from '../services';

/** Commands the AI can run: every registered one except those marked `ai: false`, or that need arguments nobody described. */
export function aiCommands(services: Services) {
  const needsArgs = new Map<string, boolean>();
  for (const b of services.keymap.all()) needsArgs.set(b.command, (needsArgs.get(b.command) ?? true) && b.args !== undefined);
  return services.commands
    .list()
    .filter((def) => def.ai !== false && (def.argsHint !== undefined || !needsArgs.get(def.id)))
    .sort((a, b) => (a.category ?? '').localeCompare(b.category ?? '') || a.id.localeCompare(b.id));
}

/** The catalog text and a key that changes when it does. */
export function commandCatalog(services: Services): { text: string; key: string } {
  const lines = aiCommands(services).map((def) => {
    const notes = [
      def.checked ? 'on/off' : '',
      def.gesture ? 'the musician confirms with one click' : '',
      def.argsHint ? `args: ${def.argsHint}` : '',
    ].filter(Boolean);
    return `- ${def.id} "${def.title}"${def.hint ? `: ${def.hint}` : ''}${notes.length ? ` [${notes.join('; ')}]` : ''}`;
  });
  const text = ['App commands (run with the command action, after the edits):', ...lines].join('\n');
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return { text, key: (h >>> 0).toString(36) };
}
