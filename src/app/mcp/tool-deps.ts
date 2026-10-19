import type { AudioDeps } from './audio-tools';

/** What the MCP tools need from the page besides the services; tests replace both. */
export interface ToolDeps {
  /** How the audio tools render and upload sound (default: the real engine and the dev server). */
  audio?: AudioDeps;
  /** A command needs the musician's click: show them a button ("Claude Code wants to export…"). */
  gesture?(client: string, commandId: string, args: unknown): void;
}
