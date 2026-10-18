/** Where the session actions report: lines for the chat's "what the app did" list, and warnings. */
export interface SessionOutput {
  ui: string[];
  warn(message: string): void;
}
