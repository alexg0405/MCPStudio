// `import dsp from './synth.dsp'`: AGstudio's dev server compiles Faust files (tools/faust).
// Same shape as FaustDsp in ./index.ts (a script file can't import it).
declare module '*.dsp' {
  interface FaustUiItem {
    type: string;
    label: string;
    shortname?: string;
    address?: string;
    index?: number;
    init?: number;
    min?: number;
    max?: number;
    step?: number;
    meta?: Record<string, string>[];
    items?: FaustUiItem[];
  }
  const dsp: {
    name: string;
    kind: 'effect' | 'instrument';
    meta: { name: string; size: number; inputs: number; outputs: number; ui: FaustUiItem[] };
    processor: string;
    processorName: string;
  };
  export default dsp;
}
