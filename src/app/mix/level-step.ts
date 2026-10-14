/**
 * The "level the mix" step after an AI answer that built or rearranged a song: renders the busiest
 * part, measures each bus and sets the faders and the master limiter to the style's targets.
 * (Not written yet: until it is, answers asking for it are applied without leveling.)
 */
import type { AfterStep } from '../assistant/after-steps';

export const levelMixStep: AfterStep | null = null;
