import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
// The ESM build (the package's "main" is its CommonJS one, which Node can't name-import).
import { FaustCompiler, instantiateFaustModuleFromFile, LibFaust } from '@grame/faustwasm/dist/esm/index.js';

/**
 * Faust → WebAssembly in Node, with the Faust compiler's own WebAssembly build (faustwasm). One
 * compiler per process, started on first use (~70 ms); results are cached by source.
 */

export interface CompiledFaust {
  wasm: Uint8Array;
  /** Faust's JSON description (ui tree, size, inputs, outputs…). */
  meta: { name: string; size: number; inputs: number; outputs: number; ui: unknown[] } & Record<string, unknown>;
  /** Short hash of the source and options: names the processor, so edits load as new ones. */
  hash: string;
}

/** Single precision, denormals flushed: what the AGstudio kernel expects. */
const ARGS = '-ftz 2';

let compiler: Promise<FaustCompiler> | null = null;
const cache = new Map<string, CompiledFaust>();

function getCompiler(): Promise<FaustCompiler> {
  compiler ??= (async () => {
    const libfaust = createRequire(import.meta.url).resolve('@grame/faustwasm/libfaust-wasm/libfaust-wasm.js');
    return new FaustCompiler(new LibFaust(await instantiateFaustModuleFromFile(libfaust)));
  })();
  return compiler;
}

/** Faust's error text without the compiler's internal noise ("name:3 : ERROR : …" → "line 3: …"). */
export function faustErrorText(raw: string, name: string): string {
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^Aborted\(|exception catching/i.test(l));
  return (
    lines
      .map((l) => l.replace(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)\\s*:\\s*ERROR\\s*:\\s*`), 'line $1: '))
      .join('; ') || 'the Faust compiler failed'
  );
}

export async function compileFaust(name: string, code: string): Promise<CompiledFaust> {
  const hash = createHash('sha256').update(`${ARGS}\n${name}\n${code}`).digest('hex').slice(0, 12);
  const hit = cache.get(hash);
  if (hit) return hit;
  const c = await getCompiler();
  let factory: { code: Uint8Array; json: string } | null;
  try {
    factory = await c.createMonoDSPFactory(name, code, ARGS);
  } catch (e) {
    throw new Error(faustErrorText(e instanceof Error ? e.message : String(e), name), { cause: e });
  }
  if (!factory) throw new Error(faustErrorText(c.getErrorMessage(), name));
  const compiled: CompiledFaust = {
    wasm: factory.code,
    meta: JSON.parse(factory.json) as CompiledFaust['meta'],
    hash,
  };
  if (cache.size > 100) cache.clear();
  cache.set(hash, compiled);
  return compiled;
}

/** A DSP with a `gate` control is an instrument (Faust's polyphony convention). */
export function hasGate(ui: readonly unknown[]): boolean {
  for (const raw of ui) {
    const item = raw as { items?: unknown[]; shortname?: string; label?: string };
    if (item.items ? hasGate(item.items) : (item.shortname ?? item.label ?? '').trim().toLowerCase() === 'gate')
      return true;
  }
  return false;
}
