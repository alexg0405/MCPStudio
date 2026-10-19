/**
 * The piano roll's built-in tools, written as note scripts against the public SDK (exactly what a
 * user script in plugins/ can do). Each one is a thin wrapper around `@agstudio/sdk/notes`.
 *
 * The descriptions are shown as the first line of each tool's dialog, so they say in plain words
 * what the tool does; param labels carry their units. The tools live in one file per category
 * (timing, edit, pitch, velocity, generate, progression) and share their param builders through
 * `shared-params.ts`; this file only lists them, in the order the piano roll shows them.
 */
import { chopTool, flipTool, glueTool, lengthTool, limitTool } from './edit';
import { arpTool, generateTool, randomizeTool } from './generate';
import { chordsTool, snapTool, transposeTool } from './pitch';
import { progressionTool } from './progression';
import { humanizeTool, legatoTool, quantizeTool, strumTool, stretchTool } from './timing';
import { scaleVelocityTool, velocityRampTool, velocityRangeTool } from './velocity';

export default [
  quantizeTool,
  humanizeTool,
  legatoTool,
  strumTool,
  stretchTool,
  chopTool,
  glueTool,
  flipTool,
  lengthTool,
  limitTool,
  transposeTool,
  snapTool,
  chordsTool,
  scaleVelocityTool,
  velocityRangeTool,
  velocityRampTool,
  arpTool,
  randomizeTool,
  generateTool,
  progressionTool,
];
