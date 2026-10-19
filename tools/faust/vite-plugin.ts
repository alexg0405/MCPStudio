import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { normalizePath, type Plugin } from 'vite';
import { compileFaust, hasGate } from './compile.ts';

/**
 * Faust files as plugin modules. `import dsp from './filter.dsp'` compiles filter.dsp to WebAssembly
 * and gives `{ name, kind, meta, processor, processorName }` (see @agstudio/sdk/faust).
 *
 * `processor` is the URL of a worklet module that registers the DSP's kernel. Its id is
 * `<file>.dsp.<hash>.faust.js` (a .js name, so the dev server serves it as a module; the hash makes
 * every edit a new module and a new processor name, since a running AudioContext can't re-register
 * one). A compile error becomes an import error, which AGstudio shows as a broken plugin.
 */
const WORKLET = /^(.*\.dsp)\.([0-9a-f]+)\.faust\.js$/;

export function faustPlugin(): Plugin {
  let root = process.cwd();
  return {
    name: 'ag:faust',
    enforce: 'pre',
    configResolved(config) {
      root = config.root;
    },
    resolveId(source) {
      const [path = '', query] = source.split('?');
      if (!WORKLET.test(path)) return null;
      // Our own virtual worklet ids, as file paths (the browser asks by URL, relative to the root).
      const file = path.startsWith(root) ? path : normalizePath(join(root, path));
      return query ? `${file}?${query}` : file;
    },
    async load(id) {
      const [path = '', query = ''] = id.split('?');
      const worklet = WORKLET.exec(path);
      const file = worklet ? (worklet[1] as string) : path;
      if (!file.endsWith('.dsp')) return null;
      const q = new URLSearchParams(query);
      // `?worker&url` asks for the worklet's URL (Vite's worker plugin answers it); `?raw` and
      // `?url` mean the file itself (the plugin builder shows Claude the templates as text).
      if (worklet ? q.has('worker') || q.has('url') : q.has('raw') || q.has('url')) return null;
      this.addWatchFile(file);
      const name = basename(file, '.dsp');
      let compiled;
      try {
        compiled = await compileFaust(name, await readFile(file, 'utf8'));
      } catch (e) {
        const message = `${name}.dsp: ${e instanceof Error ? e.message : String(e)}`;
        return `throw new Error(${JSON.stringify(message)});\n`;
      }
      const kind = hasGate(compiled.meta.ui) ? 'instrument' : 'effect';
      if (worklet) {
        const wasm = Buffer.from(compiled.wasm).toString('base64');
        return [
          `import { registerFaustKernel } from '@agstudio/sdk/faust/kernel';`,
          `registerFaustKernel(${JSON.stringify(`faust.${name}.${worklet[2]}`)}, ${JSON.stringify(compiled.meta)}, ${JSON.stringify(wasm)}, ${JSON.stringify(kind)});`,
          '',
        ].join('\n');
      }
      const description = { name, kind, meta: compiled.meta, processorName: `faust.${name}.${compiled.hash}` };
      return [
        `import processor from ${JSON.stringify(`${file}.${compiled.hash}.faust.js?worker&url`)};`,
        `export default { ...${JSON.stringify(description)}, processor };`,
        '',
      ].join('\n');
    },
  };
}
