/**
 * The rules every plugin's source files must follow, in one place so the plugin builder, the dev server and the
 * `.agplugin` bundle reader all apply the same ones: flat file names, size limits, what a file may import, and the
 * browser features plugins may not use. Pure text checks (no DOM, no Node), so the browser can run them too.
 *
 * These checks are a guard against honest mistakes and obvious misuse, not a sandbox: a plugin still runs as code
 * inside AGstudio. The install dialog says so.
 */

/** Limits on a plugin: files, bytes per file, bytes in all. */
export const MAX_PLUGIN_FILES = 8;
export const MAX_PLUGIN_FILE_BYTES = 64 * 1024;
export const MAX_PLUGIN_TOTAL_BYTES = 256 * 1024;

/** One source file of a plugin: a flat file name and its text. */
export interface PluginFile {
  path: string;
  content: string;
}

/** The user plugin id rule: `user.` and a lowercase name of letters, digits and dashes. */
export const USER_PLUGIN_ID = /^user\.[a-z][a-z0-9-]{1,40}$/;

/** "user.tape-stop" → "tape-stop" (the folder under plugins/), or null when the id does not follow the rule. */
export function folderForId(id: unknown): string | null {
  return typeof id === 'string' && USER_PLUGIN_ID.test(id) ? id.slice('user.'.length) : null;
}

const FILE_NAME = /^[a-z0-9][a-z0-9_-]{0,48}(\.(worklet|kernel))?\.(ts|tsx|md|dsp)$/i;

/** The size of a text in UTF-8 bytes (core has no TextEncoder in its lib). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0) as number;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** Every problem with a list of files (names, sizes, an index file), in plain words. Empty when it is fine. */
export function fileListProblems(files: unknown): string[] {
  if (!Array.isArray(files) || files.length === 0) return ['The plugin has no files.'];
  const problems: string[] = [];
  if (files.length > MAX_PLUGIN_FILES) problems.push(`A plugin may have at most ${MAX_PLUGIN_FILES} files.`);
  let total = 0;
  const seen = new Set<string>();
  for (const file of files) {
    const path = (file as PluginFile | null)?.path;
    const content = (file as PluginFile | null)?.content;
    if (typeof path !== 'string' || typeof content !== 'string') {
      problems.push('Every file needs a path and text.');
      continue;
    }
    if (!FILE_NAME.test(path) || /^tsconfig/i.test(path)) {
      problems.push(`"${path}" is not an allowed file name (flat names ending in .ts, .tsx, .dsp or .md).`);
      continue;
    }
    if (seen.has(path.toLowerCase())) problems.push(`"${path}" appears twice.`);
    seen.add(path.toLowerCase());
    const bytes = utf8Length(content);
    if (bytes > MAX_PLUGIN_FILE_BYTES) problems.push(`"${path}" is too large (${Math.round(bytes / 1024)} KB).`);
    total += bytes;
  }
  if (total > MAX_PLUGIN_TOTAL_BYTES) problems.push('The plugin is too large.');
  if (!seen.has('index.ts') && !seen.has('index.tsx')) problems.push('A plugin needs an index.ts (or index.tsx).');
  return problems;
}

const MAIN_IMPORTS = /^(@agstudio\/sdk(\/(params|ui|notes|worklet|dsp|faust))?|react|react\/jsx-runtime)$/;
const WORKLET_IMPORTS = /^@agstudio\/sdk\/(worklet|params)$/;
const LOCAL_IMPORT = /^\.\/[A-Za-z0-9_.-]+?(\.(ts|tsx|dsp))?(\?worker&url)?$/;

const FORBIDDEN: readonly [RegExp, string][] = [
  [/\bfetch\s*\(/, 'network access (fetch)'],
  [/\b(XMLHttpRequest|WebSocket|EventSource|RTCPeerConnection)\b/, 'network access'],
  [/\bnavigator\s*\.\s*sendBeacon\b/, 'network access (sendBeacon)'],
  [/\beval\s*\(|\bnew\s+Function\s*\(/, 'eval / new Function'],
  [/\bimport\s*\(/, 'dynamic import()'],
  [/\b(localStorage|sessionStorage|indexedDB)\b|document\s*\.\s*cookie/, 'browser storage'],
  [/\bwindow\s*\.\s*open\s*\(|\bimportScripts\s*\(/, 'opening pages or scripts'],
];

/** Problems with what a file imports or uses (plugins are sound code: no network, storage or eval). */
export function scanSource(file: PluginFile): string[] {
  // Faust code can only compute audio; Markdown is text.
  if (file.path.endsWith('.md') || file.path.endsWith('.dsp')) return [];
  const problems: string[] = [];
  const isWorklet = /\.worklet\.ts$/.test(file.path);
  const specifiers = [
    ...file.content.matchAll(/\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g),
    ...file.content.matchAll(/\bimport\s*['"]([^'"]+)['"]/g),
  ].map((match) => match[1] as string);
  for (const specifier of specifiers) {
    if (LOCAL_IMPORT.test(specifier)) continue;
    if (isWorklet ? WORKLET_IMPORTS.test(specifier) : MAIN_IMPORTS.test(specifier)) continue;
    problems.push(
      `${file.path}: may not import "${specifier}" (allowed: ${
        isWorklet ? '@agstudio/sdk/worklet, @agstudio/sdk/params' : '@agstudio/sdk, its sub-modules, react'
      } and the plugin's own files like './params')`,
    );
  }
  // Strings and comments can mention these words; code can't use them.
  const code = file.content.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""');
  for (const [pattern, what] of FORBIDDEN) if (pattern.test(code)) problems.push(`${file.path}: plugins may not use ${what}`);
  return problems;
}

/** Every problem with a plugin's files: the list rules first, then each file's imports and forbidden APIs. */
export function pluginFileProblems(files: readonly PluginFile[]): string[] {
  const listProblems = fileListProblems(files);
  if (listProblems.length > 0) return listProblems;
  return files.flatMap(scanSource);
}

/** Text that can sit inside any kind of quote in code without escaping. */
const PLAIN_TEXT = /^[^'"`\\$\n\r]*$/;

/**
 * Rewrites a string that the code quotes whole ('Tape stop' → 'Tape stop (copy)'), leaving longer strings that merely
 * start with it alone ("user.old-name-2" when renaming "user.old-name"). Returns the new files and how many places
 * changed. Markdown and Faust files are left as they are. A replacement with quotes, backslashes or `$` in it is
 * refused (0 changes) because it could not be written safely into code.
 */
export function replaceQuoted(
  files: readonly PluginFile[],
  from: string,
  to: string,
): { files: PluginFile[]; changes: number } {
  const copy = files.map((file) => ({ ...file }));
  if (!PLAIN_TEXT.test(to)) return { files: copy, changes: 0 };
  let changes = 0;
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const quoted = new RegExp(`(['"\`])${escaped}\\1`, 'g');
  for (const file of copy) {
    if (file.path.endsWith('.md') || file.path.endsWith('.dsp')) continue;
    file.content = file.content.replace(quoted, (_all, quote: string) => {
      changes++;
      return `${quote}${to}${quote}`;
    });
  }
  return { files: copy, changes };
}

/** Rewrites the plugin id wherever the code spells it as a quoted string ("user.old" → "user.new"); 0 changes means the code never says its own id. */
export function withPluginId(
  files: readonly PluginFile[],
  from: string,
  to: string,
): { files: PluginFile[]; changes: number } {
  return replaceQuoted(files, from, to);
}

/** True when some code file spells the id as a quoted string (what a definition's `id:` looks like). */
export function declaresPluginId(files: readonly PluginFile[], id: string): boolean {
  return withPluginId(files, id, id).changes > 0;
}

const DECLARED_ID = /['"](user\.[a-z][a-z0-9-]{1,40})['"]/;
const DECLARED_VERSION = /\bversion:\s*(\d+)/;

/** The id and version a plugin's code declares (the code is the one place they are written); null when no id is found. */
export function declaredIdentity(files: readonly PluginFile[]): { id: string; version: number } | null {
  const code = files.filter((file) => /\.(ts|tsx)$/.test(file.path));
  const id = code.map((file) => DECLARED_ID.exec(file.content)?.[1]).find((found) => found !== undefined);
  const index = code.find((file) => /^index\.tsx?$/.test(file.path));
  const version = Number(DECLARED_VERSION.exec(index?.content ?? '')?.[1] ?? 1);
  return id ? { id, version } : null;
}
