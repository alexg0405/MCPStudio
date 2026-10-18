/**
 * Some features live in AGstudio's local server (tools/): the AI studio's backends (`/api/ai`), the plugin builder
 * (`/api/plugins`), MCP for AI apps (`/mcp`) and the editor shortcut. The installed app, started with no server
 * behind it (it opens offline from its cache), has none of them. These are the plain words every such feature says
 * when its server is missing, so the messages agree and say what to do.
 *
 * Which server answers what:
 *   `agstudio`        the dev server (everything, plus hot reload of code and your plugins)
 *   `agstudio --app`  the production build served locally (the installed app's home): AI studio only
 */

/** The AI studio's backends are not reachable. */
export const AI_SERVER_MISSING =
  "The AI studio needs AGstudio's local server: run `agstudio --app` (or `agstudio`) in a terminal, then try again.";

/** The shorter form for a status line. */
export const AI_SERVER_MISSING_SHORT = "The AGstudio server can't be reached: run `agstudio --app` (or `agstudio`) in a terminal.";

/** A feature that only the dev server (`agstudio`) provides: the plugin builder, new plugins, MCP, open in editor. */
export function devServerMissing(what: string): string {
  return `${what} needs AGstudio's dev server: run \`agstudio\` (that is \`npm run dev\`) in a terminal and use the browser tab it opens; the installed app can't do this.`;
}
