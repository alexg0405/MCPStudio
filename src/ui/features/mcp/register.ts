import type { Services } from '@app/services';
import { claudeCodeCommand } from '@app/mcp/setup';
import { showDialog } from '../../controls/Dialog';
import { addMenuItems, cmd } from '../../shell/menus';
import { openWindow } from '../../workspace/registry';

/**
 * AI apps (Claude Code, Claude Desktop…) control AGstudio over MCP (src/app/mcp, tools/mcp). The setup
 * lives in Settings (McpSettings); this registers the commands, the menu entries, and the button an AI
 * app's request for a file dialog turns into: the browser opens pickers only after a click.
 */

/** "Claude Code wants to run Export…": the musician's click is the gesture the file dialog needs. */
async function confirm(s: Services, client: string, id: string, args: unknown): Promise<void> {
  const def = s.commands.get(id);
  if (!def) return;
  const title = def.title.replace(/…$/, '');
  const choice = await showDialog({
    title: `${client} wants to ${title.charAt(0).toLowerCase()}${title.slice(1)}`,
    message: def.hint ?? `${client} asked AGstudio to run “${title}”.`,
    detail: 'Your browser opens file dialogs only after a click, so this one is yours.',
    buttons: [
      { id: 'cancel', label: 'Not now' },
      { id: 'run', label: `${title}…`, primary: true },
    ],
    cancelId: 'cancel',
  });
  if (choice === 'run') s.commands.run(id, args);
}

export function register(services: Services): void {
  const { commands } = services;
  commands.register({
    id: 'options.mcp',
    title: 'Let other apps control AGstudio (MCP)',
    category: 'Options',
    hint: 'Allow apps on this computer that speak MCP (Claude Code, Claude Desktop…) to read and change the project, play it and export it. They need the access token from Settings',
    checked: (s) => s.prefs.getState().mcpEnabled,
    run: (s) => s.prefs.getState().set({ mcpEnabled: !s.prefs.getState().mcpEnabled }),
  });
  commands.register({
    id: 'options.connectAi',
    title: 'Connect Claude Code or other apps (MCP)…',
    category: 'Options',
    hint: 'Settings for connecting Claude Code, Claude Desktop or another app that speaks MCP: the access token and the lines to paste into it',
    run: (s) => void openWindow(s, 'settings'),
  });
  commands.register({
    id: 'options.copyClaudeCodeSetup',
    title: 'Copy the Claude Code setup command',
    category: 'Options',
    hint: 'Copies the one-line command that connects Claude Code to AGstudio (it contains the access token)',
    // The token stays out of chat messages and AI apps.
    ai: false,
    run: async (s) => {
      await s.mcp.refresh();
      const token = s.mcp.store.getState().token;
      const toast = s.session.getState().toast;
      if (!token) return toast('Other apps can only connect while AGstudio runs from its dev server (the agstudio command).', 'error');
      try {
        await navigator.clipboard.writeText(claudeCodeCommand(window.location.origin, token));
        toast('Copied. Paste it into a terminal to connect Claude Code.');
      } catch {
        toast('The browser did not allow copying. Open Options → Connect Claude Code or other apps and copy it there.', 'error');
      }
    },
  });
  addMenuItems('options', [cmd('options.connectAi', 0.1), cmd('options.mcp', 91)]);

  // Requests for file dialogs from AI apps wait here for a click.
  const seen = new Set<number>();
  services.mcp.store.subscribe((st) => {
    for (const g of st.gestures) {
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      void confirm(services, g.client, g.commandId, g.args).finally(() => services.mcp.resolveGesture(g.id));
    }
  });
}
