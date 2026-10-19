/** Types for scripts/lib/launcher.mjs (plain JavaScript: it runs before anything is installed). */
export const DEV_PORT: number;
export const APP_PORT: number;
export type LaunchMode = 'dev' | 'app';
export function parseArguments(argv: readonly string[]): { mode: LaunchMode | 'help' } | { error: string };
export function portFor(mode: LaunchMode, env: Record<string, string | undefined>): string;
export function openCommand(platform: string, target: string): { command: string; args: string[] };
export function isSafeForCmd(target: string): boolean;
export function installedAppPath(options: {
  platform: string;
  env: Record<string, string | undefined>;
  homeDir: string;
  exists: (path: string) => boolean;
}): string | null;
export function isBuildStale(repo: string): boolean;
export function npmCliPath(options: {
  platform: string;
  execPath: string;
  env: Record<string, string | undefined>;
  exists: (path: string) => boolean;
}): string | null;
export function pathWithNode(execPath: string, env: Record<string, string | undefined>): string;
