/**
 * Putting analysed voice events on a step grid: quantization (with swing and 1/32 resolution),
 * tempo estimation, and a compact text summary for people and for an AI prompt. One file per job in
 * `grid/` (`quantize.ts`, `tempo.ts`, `describe.ts`); this file keeps the import path every caller uses.
 */
export { quantizeToGrid, type Grid, type GridEvent, type QuantizeOptions } from './grid/quantize';
export { estimateBpm, type BpmOptions } from './grid/tempo';
export { describeEvents, noteName, VOICE_SUMMARY_LEGEND, type DescribeOptions } from './grid/describe';
