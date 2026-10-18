import type { LaunchQuantize } from '../model/types';

/** Quantizes from the finest to the coarsest. */
export const QUANTIZE_ORDER: readonly LaunchQuantize[] = ['none', 'beat', 'bar', '2bars', '4bars'];
