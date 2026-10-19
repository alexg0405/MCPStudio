/** Types for scripts/lib/tools.mjs. */
export const repoRoot: string;
export function binPath(packageName: string, binName?: string, root?: string): string;
export function nodeArgumentsForScript(script: string, root?: string): string[];
export function packageScripts(root?: string): Record<string, string>;
