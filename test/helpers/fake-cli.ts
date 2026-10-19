/// <reference types="node" />
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A stand-in command line tool for the backend tests: a small CommonJS Node script that behaves like `claude` or `codex`.
 *
 * macOS and Linux run it as an executable file with a `#!/usr/bin/env node` first line. Windows can't run a script
 * by its first line, so the script is saved as `<name>.cjs` next to a `<name>.cmd` that starts it with the Node
 * running the test (the same shape as the shims `npm i -g` writes). Returns the path to give the backend.
 */
export async function writeFakeCli(folder: string, name: string, script: string): Promise<string> {
  if (process.platform !== 'win32') {
    const path = join(folder, name);
    await writeFile(path, `#!/usr/bin/env node\n${script}`);
    await chmod(path, 0o755);
    return path;
  }
  await writeFile(join(folder, `${name}.cjs`), script);
  const path = join(folder, `${name}.cmd`);
  await writeFile(path, `@echo off\r\n"${process.execPath}" "%~dp0${name}.cjs" %*\r\n`);
  return path;
}
