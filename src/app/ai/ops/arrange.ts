/**
 * Song craft: arranging a whole song from sections (arrange), adding fills and transitions to an
 * existing one (develop), one boundary (transition), one spot (vary). The AI decides the structure;
 * the arranger (`core/arrange`) does the craft. (Not written yet.)
 */
import type { OpModule } from './context';

export const arrange: OpModule = { handlers: {}, schemas: [] };
