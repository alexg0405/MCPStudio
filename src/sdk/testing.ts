/**
 * `@agstudio/sdk/testing`: run worklet kernels in plain Vitest (Node), without an AudioContext.
 *
 * ```ts
 * import { runEffect } from '@agstudio/sdk/testing';
 * const [left] = runEffect(MyKernel, params, (i) => Math.sin(i * 0.05), 48000, { params: { drive: 12 } });
 * ```
 *
 * For instruments, `renderInstrument` plays notes at exact frames (the way the SDK's processor splits
 * blocks); `rms` and `peak` measure the result.
 *
 * Blocks are 128 frames like in Chrome; params are given in their own units (enums by option id,
 * bools as booleans) and may be functions of the frame for automation. Kernels see a stopped
 * transport at 120 BPM unless you pass `transport`.
 *
 * The pieces live in `test-kit/`: the host and transport (`host.ts`), param blocks (`params.ts`),
 * the block runners (`run.ts`), measuring (`measure.ts`), golden references (`golden.ts`) and speed
 * tests (`speed.ts`). This file re-exports all of them so the import path stays the same.
 */
export * from './test-kit/host';
export * from './test-kit/params';
export * from './test-kit/run';
export * from './test-kit/measure';
export * from './test-kit/golden';
export * from './test-kit/speed';
